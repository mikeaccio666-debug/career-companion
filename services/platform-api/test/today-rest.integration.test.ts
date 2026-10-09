import {CompanionDailySettingsService} from '../src/companion-daily-settings.ts';
import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { TodayRestService } from '../src/today-rest.ts';
import { createPrebirthFixture, withPrebirthLoopback, type PrebirthFixture } from './fixtures/companion-prebirth.ts';
import { readyBirth } from './fixtures/companion-birth.ts';
import { FICTIONAL_LEGAL } from './fixtures/student-entry.ts';
import { ApiError } from '../src/errors.ts';
import { AccountCoreExport } from '../src/account-core-export.ts';
import { AccountReauthentication } from '../src/account-reauthentication.ts';
import { hashPassword } from '../src/auth.ts';
let f: PrebirthFixture, service: TodayRestService;
before(async () => { f = await createPrebirthFixture(); service = new TodayRestService(f.db, f.config, FICTIONAL_LEGAL); });
after(async () => { await f?.close(); });
async function born() { let result: Awaited<ReturnType<typeof readyBirth>> | undefined; await withPrebirthLoopback(async runtime => { const b = await readyBirth(f, runtime); await b.service.birth(b.ready.who, b.body, b.key); await new CompanionDailySettingsService(f.db,f.config,FICTIONAL_LEGAL).change(b.ready.who,{companionId:(await service.read(b.ready.who)).settings.companionId,operationId:randomUUID(),expectedRevision:0,preferences});result = b; }); assert(result); return result; }
const error = (status: number) => (e: unknown) => e instanceof ApiError && e.status === status;
const preferences = {timeZone:'America/New_York',morningTime:'09:00',quietStart:'22:30',quietEnd:'08:30',dailyMinutes:90,webAlert:'none' as const};
function command(companionId:string,expectedRevision=0,choice:'today'|'1_day'|'3_days'|'7_days'|'reminders_off'='today'){return{companionId,operationId:randomUUID(),expectedRevision,choice};}
test('saved rest survives restart and replay never shifts the deadline or overwrites a newer choice',async()=>{
 const b=await born(),who=b.ready.who,initial=(await service.read(who)).settings;
 assert.equal(initial.revision,0);assert.equal(initial.pauseUntil,null);
 const cmd=command(initial.companionId,0,'1_day'),saved=await service.change(who,cmd);
 assert(saved.settings.pauseUntil);assert.equal(saved.settings.reminders,'keep');
 assert.deepEqual((await new TodayRestService(f.db,f.config,FICTIONAL_LEGAL).read(who)).settings,saved.settings);
 const next=await service.change(who,command(initial.companionId,1,'reminders_off'));
 const replay=await service.change(who,cmd);assert.equal(replay.operation.replayed,true);assert.equal(replay.operation.choice,'1_day');assert.deepEqual(replay.settings,next.settings);assert.equal(replay.settings.pauseUntil,saved.settings.pauseUntil);
 assert.deepEqual(await service.operation(who,cmd.operationId),replay);
 await assert.rejects(service.change(who,{...cmd,choice:'3_days'}),error(409));
 await f.db.query(await readFile(new URL('../migrations/082_today_rest.sql',import.meta.url),'utf8'));await f.db.migrate();assert.equal((await service.read(who)).settings.revision,2);
});
test('prebirth, staff, foreign companion and revoked session are rejected',async()=>{
 const b=await born(),who=b.ready.who,c=command((await service.read(who)).settings.companionId); await service.change(who,c);
 const other=await f.actor(); await assert.rejects(service.read(other),error(409)); await assert.rejects(service.change(other,c),error(409)); await assert.rejects(service.operation(other,c.operationId),error(404));
 await assert.rejects(service.read(await f.actor(true)),error(403)); await assert.rejects(service.change(who,command(randomUUID(),1)),error(409));
 await f.db.query('UPDATE platform_users SET auth_version=auth_version+1 WHERE id=$1',[who.userId]); await assert.rejects(service.read(who),error(401)); await assert.rejects(service.change(who,c),error(401));
});
test('concurrent devices accept one revision and immutable history is removed only by actual account deletion',async()=>{
 const who=(await born()).ready.who,id=(await service.read(who)).settings.companionId;
 const results=await Promise.allSettled((['1_day','3_days'] as const).map(choice=>service.change(who,command(id,0,choice)))); assert.equal(results.filter(x=>x.status==='fulfilled').length,1);assert.equal((await service.read(who)).settings.revision,1);
 await assert.rejects(f.db.query('DELETE FROM platform_today_rest WHERE user_id=$1',[who.userId]));
 await assert.rejects(f.db.query('UPDATE platform_today_rest SET revision=2 WHERE user_id=$1',[who.userId]));
 await f.db.query('DELETE FROM platform_users WHERE id=$1',[who.userId]);assert.equal((await f.db.query('SELECT * FROM platform_today_rest WHERE user_id=$1',[who.userId])).rowCount,0);
});
test('withdrawn consent permits private reading and operation recovery but blocks new policy use or writes',async()=>{
 const who=(await born()).ready.who,id=(await service.read(who)).settings.companionId,cmd=command(id);await service.change(who,cmd);
 await f.db.query('DELETE FROM platform_terms_consents WHERE user_id=$1',[who.userId]);await f.db.query('UPDATE platform_users SET email_verified_at=NULL WHERE id=$1',[who.userId]);
 assert((await service.read(who)).settings.optedOutUntil);assert.equal((await service.change(who,cmd)).operation.replayed,true);
 await assert.rejects(service.change(who,command(id,1)),error(403));await assert.rejects(f.db.withBoundedTransaction(c=>service.readForPolicyInTransaction(c,who)),error(403));
});
test('a late session reset rolls back the immutable insertion',async()=>{
 const who=(await born()).ready.who,id=(await service.read(who)).settings.companionId,original=f.db.withBoundedTransaction.bind(f.db);
 f.db.withBoundedTransaction=async(run,options)=>original(async client=>{ const query=client.query.bind(client);let reset=false; return run(new Proxy(client,{get(target,key){if(key==='query')return async(...args:any[])=>{const result=await (query as any)(...args);if(!reset&&typeof args[0]==='string'&&args[0].startsWith('INSERT INTO platform_today_rest')){reset=true;await query('UPDATE platform_users SET auth_version=auth_version+1 WHERE id=$1',[who.userId]);}return result;};return Reflect.get(target,key);}}));},options);
 try {await assert.rejects(service.change(who,command(id)),error(401));}finally{f.db.withBoundedTransaction=original;}
 assert.equal((await service.read(who)).settings.revision,0);
});
test('malformed input and an already-aborted request do not create a choice',async()=>{
 const who=(await born()).ready.who,id=(await service.read(who)).settings.companionId,cmd=command(id);
 await assert.rejects(service.change(who,{...cmd,choice:'30_days'}),error(400));
 await assert.rejects(service.change(who,cmd,AbortSignal.abort())); await assert.rejects(service.operation(who,'bad'),error(400));
 assert.equal((await service.read(who)).settings.revision,0);
});
test('actual owner archive includes every rest revision across pages and account deletion removes encrypted choices',async()=>{
 const who=(await born()).ready.who,id=(await service.read(who)).settings.companionId;
 const other=(await born()).ready.who,otherId=(await service.read(other)).settings.companionId;await service.change(other,command(otherId));
 for(let i=0;i<105;i++)await service.change(who,command(id,i,i%2?'1_day':'today'));
 const password='Fictional-daily-export-password',hash=await hashPassword(password);await f.db.query('UPDATE platform_users SET password_hash=$2 WHERE id=$1',[who.userId,hash]);
 await f.db.query('DELETE FROM platform_terms_consents WHERE user_id=$1',[who.userId]);
 const proof=(await new AccountReauthentication(f.db).verify(who,{purpose:'account_export',password})).token;
 const result=await new AccountCoreExport(f.db,f.config).capture(who,proof),history=result.sections.todayRest as any[];
 assert.equal(history.length,105);assert.equal(new Set(history.map(x=>x.lastOperationId)).size,105);assert.deepEqual(history.map(x=>x.revision).sort((a,b)=>a-b),Array.from({length:105},(_,i)=>i+1));
 assert.equal(result.complete,false);assert(result.includedTables.includes('platform_today_rest'));
 const text=JSON.stringify(result);for(const secret of [other.userId,otherId,who.tokenHash,password,hash,proof,'record_ciphertext','acceptedAuthVersion','commandDigest'])assert(!text.includes(secret));
 const rows=(await f.db.query('SELECT record_ciphertext FROM platform_today_rest WHERE user_id=$1',[who.userId])).rows;assert(rows.every(row=>!row.record_ciphertext.toString().includes('America/New_York')));
});

test('ciphertext damage or substituted metadata fails closed for current reads and owner exports',async()=>{
 const who=(await born()).ready.who,id=(await service.read(who)).settings.companionId;await service.change(who,command(id));
 const original=f.db.withBoundedTransaction.bind(f.db);
 for(const kind of ['ciphertext','timestamp','owner']){
  f.db.withBoundedTransaction=async(run,options)=>original(async client=>{const query=client.query.bind(client);return run(new Proxy(client,{get(target,key){if(key==='query')return async(...args:any[])=>{const result=await(query as any)(...args);if(typeof args[0]==='string'&&args[0].startsWith('SELECT * FROM platform_today_rest')){for(const row of result.rows){if(kind==='ciphertext'){row.record_ciphertext=Buffer.from(row.record_ciphertext);row.record_ciphertext[12]^=1;}if(kind==='timestamp')row.created_at=new Date(0);if(kind==='owner')row.user_id=randomUUID();}}return result;};return Reflect.get(target,key);}}));},options);
  try{await assert.rejects(service.read(who),error(503));await assert.rejects(f.db.withBoundedTransaction(async client=>{for await(const _ of service.exportInTransaction(client,who)){};}),error(503));}finally{f.db.withBoundedTransaction=original;}
 }
 assert.equal((await service.read(who)).settings.revision,1);
});
