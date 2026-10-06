import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { buildApp } from '../src/app.ts';
import { readConfig } from '../src/config.ts';
import { Database } from '../src/database.ts';
import { tokenHash } from '../src/auth.ts';
import { AccountActions } from '../src/account-actions.ts';
import { decryptAccountEmail } from '../src/account-mail.ts';
import type { AccountEmailConfig } from '../src/account-mail.ts';

const origin='http://localhost:4321',prefix='/api/platform',schema=`auth_version_${randomUUID().replaceAll('-','')}`;
const base=readConfig(),admin=new Database(base.databaseUrl),url=new URL(base.databaseUrl);
url.searchParams.set('options',`-c search_path=${schema}`);
const databases=[new Database(url.toString()),new Database(url.toString())];
const mail:AccountEmailConfig={apiKey:'fictional-mail-key',from:'noreply@example.invalid',webOrigin:origin,encryptionKey:Buffer.alloc(32,17)};
const systems:Awaited<ReturnType<typeof buildApp>>[]=[];
before(async()=>{
  await admin.query(`CREATE SCHEMA ${schema}`);await databases[0].migrate();
  for(const db of databases)systems.push(await buildApp({db,config:{...base,databaseUrl:url.toString(),accountEmail:mail},enableQueue:false}));
});
after(async()=>{await Promise.all(systems.map(system=>system.app.close()));await Promise.all(databases.map(db=>db.close()));await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.close();});
function request(instance:number,route:string,body?:unknown,cookie?:string){return systems[instance].app.inject({method:body===undefined?'GET':'POST',url:prefix+route,headers:{origin,...(cookie?{cookie}:{}),...(body===undefined?{}:{'content-type':'application/json'})},...(body===undefined?{}:{payload:JSON.stringify(body)})});}
function cookie(response:{headers:Record<string,unknown>}){return String(response.headers['set-cookie']).split(';')[0];}

test('a login checked against the old password cannot acquire a usable session after a concurrent reset',async()=>{
  const address='login-race@example.invalid',oldPassword='fictional-old-password',newPassword='fictional-new-password';
  const registration=await request(0,'/auth/register',{email:address,name:'Fictional login race',password:oldPassword});
  assert.equal(registration.statusCode,201);const owner=registration.json().user.id,oldCookie=cookie(registration);
  const second=await request(1,'/auth/login',{email:address,password:oldPassword});assert.equal(second.statusCode,200);const secondCookie=cookie(second);
  await new AccountActions(databases[1],mail).requestPasswordReset(address);
  const queued=await databases[1].query('SELECT ciphertext FROM platform_account_email_outbox WHERE user_id=$1',[owner]);
  const token=new URL(decryptAccountEmail(mail,queued.rows[0].ciphertext).text.match(/http[^\s]+/)![0]).hash.match(/token=([A-Za-z0-9_-]{43})/)![1];
  const first=databases[0],original=first.query.bind(first);let captured!:()=>void,release!:()=>void;
  const observed=new Promise<void>(resolve=>{captured=resolve;}),paused=new Promise<void>(resolve=>{release=resolve;});
  first.query=async(text,values=[])=>{const result=await original(text,values);if(text==='SELECT * FROM platform_users WHERE email=$1'){captured();await paused;}return result;};
  const login=request(0,'/auth/login',{email:address,password:oldPassword});
  try{
    await observed;
    const reset=await request(1,'/auth/password-reset/complete',{token,password:newPassword});assert.equal(reset.statusCode,200);
    release();const late=await login;assert.equal(late.statusCode,401);assert.equal(late.headers['set-cookie'],undefined);
  }finally{first.query=original;release();await login;}
  for(const existing of [oldCookie,secondCookie])assert.equal((await request(1,'/auth/me',undefined,existing)).statusCode,401);
  // Even a database INSERT from a pre-reset snapshot cannot authorize a request.
  const staleToken=randomBytes(32).toString('base64url');
  await databases[1].query("INSERT INTO platform_sessions(token_hash,user_id,expires_at,auth_version) VALUES($1,$2,now()+interval '1 hour',0)",[tokenHash(staleToken),owner]);
  assert.equal((await request(0,'/auth/me',undefined,`companion_session=${staleToken}`)).statusCode,401);
  assert.equal((await request(1,'/auth/login',{email:address,password:oldPassword})).statusCode,401);
  const current=await request(1,'/auth/login',{email:address,password:newPassword});assert.equal(current.statusCode,200);
  assert.equal((await request(0,'/auth/me',undefined,cookie(current))).json().user.id,owner);
  const versions=await databases[1].query('SELECT auth_version FROM platform_users WHERE id=$1',[owner]);assert.equal(String(versions.rows[0].auth_version),'1');
});
