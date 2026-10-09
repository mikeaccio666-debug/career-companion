import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PoolClient } from 'pg';
import type { PlatformProviderRuntime } from '@companion/platform-contracts';
import { AccountReauthentication } from '../src/account-reauthentication.ts';
import { buildApp } from '../src/app.ts';
import { Database } from '../src/database.ts';
import { readConfig } from '../src/config.ts';
import { hashPassword, tokenHash, type FixedSessionContext } from '../src/auth.ts';
import { FICTIONAL_LEGAL, seedFictionalActiveLegal } from './fixtures/student-entry.ts';

const base = readConfig(), schema = 'account_privacy_' + randomUUID().replaceAll('-', ''), url = new URL(base.databaseUrl);
assert(['localhost','127.0.0.1','[::1]'].includes(url.hostname)); url.searchParams.set('options', '-c search_path=' + schema);
const admin = new Database(base.databaseUrl), db = new Database(url.toString()), service = new AccountReauthentication(db);
const password = 'Fictional-privacy-password-2026', origin = 'https://privacy.example.invalid';
let encoded: string, directory: string, app: Awaited<ReturnType<typeof buildApp>>, second: Awaited<ReturnType<typeof buildApp>>, calls = 0;
const unused = async (): Promise<never> => { calls++; throw new Error('No provider or task may run.'); };
const runtime: PlatformProviderRuntime = { capabilities: () => [], streamChat: async function*() { await unused(); }, executeJob: unused, createVoiceSession: unused, transcribe: unused, speech: unused };
before(async () => {
  await admin.query(`CREATE SCHEMA ${schema}`); await db.migrate(); await seedFictionalActiveLegal(db); encoded = await hashPassword(password); directory = await mkdtemp(join(tmpdir(), 'privacy-fixture-'));
  const config = { ...base, databaseUrl: url.toString(), storageDir: directory, allowedOrigins: new Set([origin]), requireVerifiedEmail: true };
  app = await buildApp({ db, config, runtime, enableQueue: false, legalBundle: FICTIONAL_LEGAL });
  second = await buildApp({ db, config, runtime, enableQueue: false, legalBundle: FICTIONAL_LEGAL });
});
after(async () => { assert.equal(calls, 0); await app?.app.close(); await second?.app.close(); await db.close(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.close(); if (directory) await rm(directory, { recursive: true, force: true }); });
async function actor() {
  const userId = randomUUID(), token = randomUUID();
  await db.query("INSERT INTO platform_users(id,email,name,password_hash,account_kind) VALUES($1,$2,'Fictional privacy owner',$3,'student')", [userId,userId+'@example.invalid',encoded]);
  await db.query("INSERT INTO platform_sessions(token_hash,user_id,auth_version,expires_at) VALUES($1,$2,0,clock_timestamp()+interval '1 hour')", [tokenHash(token),userId]);
  return { userId, tokenHash: tokenHash(token), cookie: 'companion_session='+token };
}
const fixed = (a: Awaited<ReturnType<typeof actor>>): FixedSessionContext => ({ userId:a.userId,tokenHash:a.tokenHash });
const command = (purpose: 'account_export' | 'account_delete' = 'account_export') => ({ purpose, password });
const proofRow = async (a: FixedSessionContext) => (await db.query('SELECT * FROM platform_account_reauthentications WHERE user_id=$1', [a.userId])).rows;
const consume = (a: FixedSessionContext, token: string, purpose: 'account_export' | 'account_delete' = 'account_export') => db.withBoundedTransaction(c => service.consumeInTransaction(c, a, purpose, token));
const request = (a: Awaited<ReturnType<typeof actor>>, payload: Record<string, unknown> = command(), server = app, headers: Record<string,string> = {}) => server.app.inject({ method:'POST',url:'/api/platform/account/reauthenticate',headers:{origin,cookie:a.cookie,'x-companion-account':a.userId,...headers},payload });

test('actual password verification stores only a purpose/session-bound digest and works without model consent or verified email', async () => {
  const a=await actor(), result=await request(a); assert.equal(result.statusCode,200,result.body); assert.equal(result.headers['cache-control'],'private, no-store');
  const p=result.json().proof; assert.equal(p.ownerId,a.userId); assert.equal(p.purpose,'account_export'); assert.match(p.token,/^[A-Za-z0-9_-]{43}$/);
  const rows=await proofRow(a); assert.equal(rows.length,1); assert.equal(rows[0].session_hash,a.tokenHash); assert.equal(rows[0].auth_version,'0');
  assert.equal(rows[0].expires_at.getTime()-rows[0].verified_at.getTime(),300000); assert.equal(rows[0].consumed_at,null);
  assert(!JSON.stringify(rows).includes(password)); assert(!JSON.stringify(rows).includes(p.token));
  const other=await actor(); await assert.rejects(consume(fixed(other),p.token)); await assert.rejects(consume(fixed(a),p.token,'account_delete'));
  await consume(fixed(a),p.token); await assert.rejects(consume(fixed(a),p.token));
});
test('wrong password, foreign context, malformed authority and disallowed Origin produce no proof', async () => {
  const a=await actor(), b=await actor();
  assert.equal((await request(a,{...command(),password:'wrong'})).statusCode,401);
  assert.equal((await request(a,command(),app,{'x-companion-account':b.userId})).statusCode,409);
  assert.equal((await request(a,{...command(),userId:b.userId})).statusCode,400);
  assert.equal((await request(a,command(),app,{origin:'https://foreign.example.invalid'})).statusCode,403);
  assert.equal((await app.app.inject({method:'POST',url:'/api/platform/account/reauthenticate',headers:{origin},payload:command()})).statusCode,401);
  assert.equal((await proofRow(a)).length,0);
});
test('wrong attempts are limited per actual account across independent API instances and purposes', async () => {
  const a=await actor();
  for(let i=0;i<5;i++)assert.equal((await request(a,{...command(i%2?'account_delete':'account_export'),password:'wrong'},i%2?app:second)).statusCode,401);
  const result=await request(a,command(),second); assert.equal(result.statusCode,429); assert(Number(result.headers['retry-after'])>0); assert.equal((await proofRow(a)).length,0);
});
test('fresh verification replaces only the same session/purpose proof and another session cannot spend it', async () => {
  const a=await actor(), current=fixed(a), first=await service.verify(current,command()), deletion=await service.verify(current,command('account_delete'));
  const next=await service.verify(current,command()); assert.notEqual(next.token,first.token); await assert.rejects(consume(current,first.token));
  const otherToken=tokenHash(randomUUID()); await db.query("INSERT INTO platform_sessions(token_hash,user_id,auth_version,expires_at) VALUES($1,$2,0,clock_timestamp()+interval '1 hour')",[otherToken,a.userId]);
  await assert.rejects(consume({userId:a.userId,tokenHash:otherToken},next.token)); await consume(current,next.token); await consume(current,deletion.token,'account_delete');
});
test('concurrent consumption commits once and a failed operation rolls consumption back', async () => {
  const a=fixed(await actor()), p=await service.verify(a,command());
  const rollback=new Error('Fictional operation rollback'); await assert.rejects(db.withBoundedTransaction(async c=>{await service.consumeInTransaction(c,a,'account_export',p.token);throw rollback;}),e=>e===rollback);
  assert.equal((await proofRow(a))[0].consumed_at,null);
  const attempts=await Promise.allSettled([consume(a,p.token),consume(a,p.token)]); assert.equal(attempts.filter(v=>v.status==='fulfilled').length,1);
});
test('expiration, password reset and logout invalidate verification and existing proofs', async () => {
  for(const mode of ['expired','reset','logout']) {
    const a=fixed(await actor()), p=await service.verify(a,command());
    if(mode==='expired')await db.query("UPDATE platform_account_reauthentications SET verified_at=statement_timestamp()-interval '6 minutes',expires_at=statement_timestamp()-interval '1 minute' WHERE user_id=$1",[a.userId]);
    if(mode==='reset')await db.query('UPDATE platform_users SET auth_version=auth_version+1 WHERE id=$1',[a.userId]);
    if(mode==='logout')await db.query('DELETE FROM platform_sessions WHERE token_hash=$1',[a.tokenHash]);
    await assert.rejects(consume(a,p.token)); if(mode!=='expired')await assert.rejects(service.verify(a,command()));
    if(mode==='logout')assert.equal((await proofRow(a)).length,0);
  }
});
test('failed verification COMMIT returns no usable proof, and relational ownership cannot be transplanted', async () => {
  const a=fixed(await actor()), b=fixed(await actor());
  await db.query(`CREATE FUNCTION fictional_reauth_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Fictional reauth COMMIT failure'; END $$`);
  await db.query('CREATE CONSTRAINT TRIGGER fictional_reauth_failure AFTER INSERT ON platform_account_reauthentications DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION fictional_reauth_failure()');
  try {await assert.rejects(service.verify(a,command()));assert.equal((await proofRow(a)).length,0);}finally{await db.query('DROP FUNCTION fictional_reauth_failure() CASCADE');}
  await service.verify(a,command()); await assert.rejects(db.query('UPDATE platform_account_reauthentications SET user_id=$2 WHERE user_id=$1',[a.userId,b.userId]));
});
test('closed identity inputs cannot evaluate getters or choose extra authority', async () => {
  const a=fixed(await actor()); let read=false;
  const trapped={userId:a.userId,get tokenHash(){read=true;return a.tokenHash;}};
  await assert.rejects(service.verify(trapped,command())); assert.equal(read,false);
  await assert.rejects(service.verify({...a,override:true} as FixedSessionContext,command()));
});
test('schema inventory records data locations without reading private rows', async () => {
  const tables=(await db.query(`SELECT c.relname AS table_name,array_agg(a.attname::text ORDER BY a.attnum) AS columns
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_attribute a ON a.attrelid=c.oid
    WHERE n.nspname=$1 AND c.relkind='r' AND a.attnum>0 AND NOT a.attisdropped GROUP BY c.relname ORDER BY c.relname`,[schema])).rows;
  const owners=(await db.query(`SELECT c.relname AS table_name,a.attname AS column_name,
    CASE k.confdeltype WHEN 'c' THEN 'CASCADE' WHEN 'n' THEN 'SET NULL' WHEN 'r' THEN 'RESTRICT' ELSE 'NO ACTION' END AS delete_rule
    FROM pg_constraint k JOIN pg_class c ON c.oid=k.conrelid JOIN pg_namespace n ON n.oid=c.relnamespace
    JOIN pg_attribute a ON a.attrelid=c.oid AND a.attnum=ANY(k.conkey)
    WHERE n.nspname=$1 AND k.contype='f' AND k.confrelid='platform_users'::regclass ORDER BY c.relname,a.attname`,[schema])).rows;
  assert(tables.every(t=>Array.isArray(t.columns)));
  const filename=process.env.ACCOUNT_PRIVACY_INVENTORY_PATH;
  if(filename)await writeFile(filename,JSON.stringify({tables,owners},null,2),{mode:0o600});
  assert(tables.some(t=>t.table_name==='platform_account_reauthentications')); assert(owners.some(o=>o.table_name==='platform_account_reauthentications'&&o.delete_rule==='CASCADE'));
});

class AfterCaptureDatabase extends Database {
  private captured=false;
  constructor(private readonly afterCapture:()=>Promise<void>){super(url.toString());}
  override async withBoundedTransaction<T>(run:(client:PoolClient)=>Promise<T>,options:{readOnly?:boolean;timeoutMs?:number}={}) {
    const result=await super.withBoundedTransaction(run,options);
    if(!this.captured){this.captured=true;await this.afterCapture();}
    return result;
  }
}
test('password reset after the real initial capture cannot mint a proof from stale credentials',async()=>{
  const a=fixed(await actor());
  const gated=new AfterCaptureDatabase(async()=>{await db.query('UPDATE platform_users SET auth_version=auth_version+1 WHERE id=$1',[a.userId]);});
  try{await assert.rejects(new AccountReauthentication(gated).verify(a,command()));assert.equal((await proofRow(a)).length,0);}finally{await gated.close();}
});
test('mutable caller identity cannot switch an in-flight verification to another real account',async()=>{
  const a=fixed(await actor()),b=fixed(await actor()),mutable={...a};
  const gated=new AfterCaptureDatabase(async()=>{Object.assign(mutable,b);});
  try{const p=await new AccountReauthentication(gated).verify(mutable,command());assert.equal(p.ownerId,a.userId);assert.equal((await proofRow(b)).length,0);await consume(a,p.token);}finally{await gated.close();}
});
