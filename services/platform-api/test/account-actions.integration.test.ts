import { FICTIONAL_LEGAL, fictionalRegistration, seedFictionalActiveLegal } from './fixtures/student-entry.ts';
import { PLATFORM_ACCOUNT_HEADER } from '@companion/platform-contracts';
import { after, afterEach, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import http, { type IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { PlatformProviderRuntime } from '@companion/platform-contracts';
import { AccountActions } from '../src/account-actions.ts';
import { decryptAccountEmail, processAccountEmails, type AccountEmailConfig } from '../src/account-mail.ts';
import { buildApp, type AppOptions } from '../src/app.ts';
import { checkPassword, tokenHash } from '../src/auth.ts';
import { readConfig } from '../src/config.ts';
import { Database } from '../src/database.ts';
import { ApiError } from '../src/errors.ts';

// Real loopback HTTP providers and API instances, isolated real PostgreSQL tables.
// All addresses, passwords and credentials are fictional; no third-party service is contacted.
const prefix='/api/platform', origin='https://account-actions.example.invalid';
const base=readConfig({...process.env,PLATFORM_REQUIRE_INVITE:'1'}), schema=`account_actions_${randomUUID().replaceAll('-','')}`;
const admin=new Database(base.databaseUrl), url=new URL(base.databaseUrl);
url.searchParams.set('options',`-c search_path=${schema}`);
const databases=[new Database(url.toString()),new Database(url.toString()),new Database(url.toString())];
const config: AccountEmailConfig={apiKey:'re_fictional_account_key',from:'Career Companion <no-reply@example.invalid>',webOrigin:origin,encryptionKey:Buffer.alloc(32,0x37)};
const actions=databases.slice(0,2).map(db=>new AccountActions(db,config));
type System=Awaited<ReturnType<typeof buildApp>>;
type Actor={id:string;email:string;cookie:string;password:string};
type ResponseData={status:number;headers:IncomingHttpHeaders;bytes:Buffer};
type Captured={key:string;body:string;headers:IncomingHttpHeaders;mail:{from:string;to:string;subject:string;text:string}};
const captured:Captured[]=[], accepted=new Map<string,{body:string;id:string}>();
const modes=new Map<string,'fail'|'hold'|'accept-drop'|'redirect'|'oversized'>();
const holds=new Map<string,()=>void>();
let systems:System[]=[], ports:number[]=[], directory:string, providerPort:number, schemaCreated=false;
let modelCalls=0, transportCalls=0;
const unused=async():Promise<never>=>{modelCalls++;throw new Error('No model or task may execute in account fixtures.');};
const runtime:PlatformProviderRuntime={capabilities:()=>[],streamChat:async function*(){modelCalls++;throw new Error('No model calls.');},executeJob:unused,createVoiceSession:unused,transcribe:unused,speech:unused};
const policies:NonNullable<AppOptions['requestLimits']>={policies:Object.fromEntries(['api','chat','speech','transcription','realtime','control','auth-login','auth-register','auth-email-request','auth-email-consume','public'].map(scope=>[scope,{max:1000,windowSeconds:60}]))};

const provider=http.createServer((request,response)=>{
  const chunks:Buffer[]=[];
  request.on('data',(chunk:Buffer)=>chunks.push(chunk));
  request.on('end',()=>{
    try {
      assert.equal(request.method,'POST'); assert.equal(request.url,'/emails');
      const body=Buffer.concat(chunks).toString('utf8'), mail=JSON.parse(body), key=String(request.headers['idempotency-key']??'');
      const item:Captured={key,body,mail,headers:request.headers}; captured.push(item);
      const mode=modes.get(mail.to);
      if(mode==='fail'){response.writeHead(500,{'content-type':'application/json'});response.end(JSON.stringify({error:'Fictional upstream private body; never persist this string'}));return;}
      if(mode==='redirect'){response.writeHead(307,{location:'https://never-request.example.invalid/'});response.end();return;}
      if(mode==='oversized'){response.writeHead(200,{'content-type':'application/json'});response.end('x'.repeat(9000));return;}
      let record=accepted.get(key);
      if(record && record.body!==body){response.writeHead(409);response.end('{}');return;}
      if(!record){record={body,id:randomUUID()};accepted.set(key,record);}
      const finish=()=>{response.writeHead(200,{'content-type':'application/json'});response.end(JSON.stringify({id:record!.id}));};
      if(mode==='accept-drop'){response.destroy();return;}
      if(mode==='hold'){holds.set(mail.to,finish);return;}
      finish();
    } catch {response.writeHead(500);response.end('{}');}
  });
});
const transport:typeof globalThis.fetch=async(input,init)=>{
  transportCalls++;
  assert.equal(String(input),'https://api.resend.com/emails'); assert.equal(init?.redirect,'error');
  assert.equal(new Headers(init?.headers).get('authorization'),`Bearer ${config.apiKey}`);
  return globalThis.fetch(`http://127.0.0.1:${providerPort}/emails`,init);
};

function exchange(instance:number,route:string,actor?:Actor,options:{method?:string;body?:unknown;origin?:string;omitOrigin?:boolean;headers?:Record<string,string>}={}):Promise<ResponseData>{
  return new Promise((resolve,reject)=>{
    const body=options.body===undefined?undefined:JSON.stringify(options.body);
    const request=http.request({host:'127.0.0.1',port:ports[instance],path:prefix+route,method:options.method??'GET',agent:false,
      headers:{...(!options.omitOrigin?{origin:options.origin??origin}:{}),...(actor?{cookie:actor.cookie, [PLATFORM_ACCOUNT_HEADER]: actor.id}:{}),...(body!==undefined?{'content-type':'application/json','content-length':Buffer.byteLength(body)}:{}),...options.headers}},response=>{
      const chunks:Buffer[]=[];response.on('data',(chunk:Buffer)=>chunks.push(chunk));response.on('error',reject);
      response.on('end',()=>resolve({status:response.statusCode!,headers:response.headers,bytes:Buffer.concat(chunks)}));
    });request.on('error',reject);request.setTimeout(10_000,()=>request.destroy(new Error('Account HTTP fixture timed out.')));
    if(body!==undefined)request.write(body);request.end();
  });
}
function post(instance:number,route:string,actor:Actor|undefined,body:unknown,options:Parameters<typeof exchange>[3]={}){
  return exchange(instance,route,actor,{...options,method:'POST',body});
}
function json(result:ResponseData){return JSON.parse(result.bytes.toString('utf8'));}
function assertSafe(result:ResponseData,expected:number){
  assert.equal(result.status,expected,result.bytes.toString());assert.equal(result.headers['cache-control'],'private, no-store');
  assert.equal(result.headers['access-control-allow-origin'],origin);assert.equal(result.headers['access-control-allow-credentials'],'true');
  for(const privateValue of [config.apiKey,config.encryptionKey.toString('hex')])assert(!result.bytes.includes(privateValue));
}
async function register(instance=0):Promise<Actor>{
  const email=`account-${randomUUID()}@example.invalid`,password='Fictional-old-password-2026';
  const result=await post(instance,'/auth/register',undefined,await fictionalRegistration(databases[0]!,{email,password,name:'Fictional account owner'}));
  assertSafe(result,201);const user=json(result).user;assert.equal(user.emailVerified,false);
  const setCookie=result.headers['set-cookie']?.[0];assert(setCookie);assert.match(setCookie,/HttpOnly/);assert.match(setCookie,/SameSite=Lax/);
  return {id:user.id,email,password,cookie:setCookie.split(';')[0]!};
}
async function row(actor:Actor){return (await databases[0]!.query('SELECT * FROM platform_users WHERE id=$1',[actor.id])).rows[0];}
async function queued(actor:Actor){return (await databases[0]!.query('SELECT * FROM platform_account_email_outbox WHERE user_id=$1 ORDER BY created_at,id',[actor.id])).rows;}
async function resetRequest(actor:Actor,instance=0){const result=await post(instance,'/auth/password-reset/request',undefined,{email:actor.email});assertSafe(result,202);assert.deepEqual(json(result),{accepted:true});return result;}
async function verifyRequest(actor:Actor,instance=0){const result=await post(instance,'/auth/email-verification/request',actor,{});assertSafe(result,202);assert.deepEqual(json(result),{accepted:true});return result;}
async function dispatch(db=databases[0]!,options:{timeoutMs?:number;limit?:number}={}){return processAccountEmails(db,config,{fetch:transport,limit:1,...options});}
function sent(actor:Actor){return captured.filter(item=>item.mail.to===actor.email);}
function linkToken(item:Captured){const link=/https:\/\/[^\s]+/.exec(item.mail.text)?.[0];assert(link);const params=new URLSearchParams(new URL(link).hash.slice(1));const token=params.get('token');assert(token&&/^[A-Za-z0-9_-]{43}$/.test(token));assert.equal(new URL(link).origin,origin);return {token,purpose:params.get('account-action')};}
const invalidAction=(cause:unknown)=>cause instanceof ApiError&&cause.status===400&&cause.code==='ACCOUNT_ACTION_INVALID';
async function until(run:()=>boolean){const end=Date.now()+2000;while(!run()){if(Date.now()>end)throw new Error('Fixture state was not reached.');await new Promise(resolve=>setTimeout(resolve,5));}}

before(async()=>{
  assert(['localhost','127.0.0.1','[::1]'].includes(new URL(base.databaseUrl).hostname),'Only the local isolated test database may be used.');
  await admin.query(`CREATE SCHEMA ${schema}`);schemaCreated=true;await databases[0]!.migrate(); await seedFictionalActiveLegal(databases[0]!);
  directory=await fs.mkdtemp(path.join(os.tmpdir(),'companion-account-actions-'));
  await new Promise<void>(resolve=>provider.listen(0,'127.0.0.1',resolve));providerPort=(provider.address() as AddressInfo).port;
  for(let index=0;index<3;index++){
    const system=await buildApp({legalBundle:FICTIONAL_LEGAL,db:databases[index],runtime,enableQueue:false,requestLimits:policies,
      config:{...base,databaseUrl:url.toString(),storageDir:directory,s3:undefined,webStaticDir:undefined,allowedOrigins:new Set([origin]),
        secureCookies:true,accountEmail:index===2?undefined:config,requireVerifiedEmail:index!==2}});
    await system.app.listen({host:'127.0.0.1',port:0});systems.push(system);ports.push((system.app.server.address() as AddressInfo).port);
  }
});
afterEach(async()=>{
  for(const finish of holds.values())finish();holds.clear();modes.clear();
  if(schemaCreated){await databases[0]!.query("UPDATE platform_account_email_outbox SET status='revoked',ciphertext=NULL,lease_token=NULL,lease_until=NULL,finished_at=now() WHERE status IN ('pending','sending')");
    await databases[0]!.query('UPDATE platform_account_actions SET consumed_at=now() WHERE consumed_at IS NULL');}
});
after(async()=>{
  await Promise.all(systems.map(system=>system.app.close()));await new Promise<void>(resolve=>provider.close(()=>resolve()));
  await Promise.all(databases.map(db=>db.close()));try{if(schemaCreated)await admin.query(`DROP SCHEMA ${schema} CASCADE`);}finally{await admin.close();if(directory)await fs.rm(directory,{recursive:true,force:true});}
});

test('disabled mail is truthful and performs no outbox or network work for known and unknown emails',async()=>{
  const actor=await register(2),beforeCalls=transportCalls;
  for(const email of [actor.email,`${randomUUID()}@example.invalid`]){
    const result=await post(2,'/auth/password-reset/request',undefined,{email});assertSafe(result,503);assert.equal(json(result).error.code,'ACCOUNT_EMAIL_UNAVAILABLE');
  }
  const result=await post(2,'/auth/email-verification/request',actor,{});assertSafe(result,503);
  assert.equal(await processAccountEmails(databases[2]!,undefined,{fetch:transport}),0);assert.equal(transportCalls,beforeCalls);
  assert.equal((await queued(actor)).length,0);assertSafe(await exchange(2,'/conversations',actor),200);
  const status=await exchange(2,'/auth/options');assertSafe(status,200);assert.deepEqual(json(status),{emailActionsEnabled:false,requireVerifiedEmail:false,requireInvite:true,legal:{status:'available',version:FICTIONAL_LEGAL.version,digest:FICTIONAL_LEGAL.digest}});
});

test('request HTTP responses do not enumerate accounts or issue secrets and target limits survive both instances',async()=>{
  const actor=await register(),unknown=`unknown-${randomUUID()}@example.invalid`,responses:ResponseData[]=[];
  for(let index=0;index<5;index++){
    responses.push(await post(index%2,'/auth/password-reset/request',undefined,{email:actor.email}));
    responses.push(await post(index%2,'/auth/password-reset/request',undefined,{email:unknown}));
  }
  for(const result of responses){assertSafe(result,202);assert.deepEqual(json(result),{accepted:true});assert.equal(result.headers['set-cookie'],undefined);}
  assert.equal(new Set(responses.map(result=>result.bytes.toString())).size,1);
  const outbox=await queued(actor);assert.equal(outbox.length,3);
  for(const item of outbox){assert(Buffer.isBuffer(item.ciphertext));assert(!item.ciphertext.includes(actor.email));assert(!item.ciphertext.includes(config.from));assert.equal(item.status,'pending');}
  const targets=await databases[0]!.query('SELECT target_hash,purpose,request_count FROM platform_account_action_limits WHERE purpose=$1',['password-reset']);
  assert(targets.rows.some(item=>item.request_count===3));assert(targets.rows.every(item=>/^[0-9a-f]{64}$/.test(item.target_hash)));
  assert.equal(modelCalls,0);
});

test('concurrent known and unknown requests use a shared atomic three-per-hour target window',async()=>{
  const actor=await register(),unknown=`unknown-${randomUUID()}@example.invalid`;
  const results=await Promise.all(Array.from({length:20},(_,index)=>post(index%2,'/auth/password-reset/request',undefined,{email:index%2?actor.email:unknown})));
  for(const result of results){assertSafe(result,202);assert.deepEqual(json(result),{accepted:true});}
  assert.equal((await queued(actor)).length,3);
  await databases[0]!.query("UPDATE platform_account_action_limits SET expires_at=now()-interval '1 second' WHERE purpose='password-reset'");
  await resetRequest(actor);assert.equal((await queued(actor)).length,4);
});

test('real provider HTTP receives fixed decrypted mail and UUID idempotency while sent rows erase ciphertext',async()=>{
  const actor=await register();await resetRequest(actor);const before=await queued(actor);assert.equal(before.length,1);
  const plaintext=decryptAccountEmail(config,before[0].ciphertext);assert.equal(plaintext.to,actor.email);assert.equal(plaintext.from,config.from);
  assert.equal(await dispatch(),1);const request=sent(actor)[0]!;
  assert.equal(request.key,before[0].id);assert.equal(request.body,JSON.stringify(plaintext));assert.match(request.key,/^[0-9a-f-]{36}$/);
  const actionToken=linkToken(request);assert.equal(actionToken.purpose,'password-reset');
  const action=(await databases[0]!.query('SELECT * FROM platform_account_actions WHERE user_id=$1',[actor.id])).rows[0];
  assert.equal(action.token_hash,tokenHash(actionToken.token));assert.equal(action.user_id,actor.id);
  assert.equal(new Date(action.expires_at).getTime()-new Date(action.created_at).getTime(),15*60_000);
  const completed=(await queued(actor))[0];assert.equal(completed.status,'sent');assert.equal(completed.ciphertext,null);assert.equal(completed.lease_token,null);assert.equal(completed.provider_message_id,accepted.get(request.key)!.id);
  assert.equal(await dispatch(),0);
});

test('two independent workers cannot concurrently send an active lease',async()=>{
  const actor=await register();await resetRequest(actor);modes.set(actor.email,'hold');
  const first=dispatch();await until(()=>holds.has(actor.email));
  assert.equal(await dispatch(databases[1]!),0);assert.equal(sent(actor).length,1);
  holds.get(actor.email)!();holds.delete(actor.email);assert.equal(await first,1);
  assert.equal((await queued(actor))[0].status,'sent');
});

test('uncertain provider acceptance retries exactly the same payload and idempotency key',async()=>{
  const actor=await register();await resetRequest(actor);modes.set(actor.email,'accept-drop');
  assert.equal(await dispatch(),1);const initial=(await queued(actor))[0],first=sent(actor)[0]!;
  assert.equal(initial.status,'pending');assert(initial.ciphertext);assert.equal(initial.error_code,'ACCOUNT_EMAIL_SEND_FAILED');
  assert.equal(accepted.get(first.key)?.body,first.body);
  modes.delete(actor.email);await databases[0]!.query("UPDATE platform_account_email_outbox SET next_attempt_at=now()-interval '1 second' WHERE id=$1",[initial.id]);
  assert.equal(await dispatch(databases[1]!),1);const requests=sent(actor);assert.equal(requests.length,2);assert.equal(requests[1]!.key,first.key);assert.equal(requests[1]!.body,first.body);
  const completed=(await queued(actor))[0];assert.equal(completed.status,'sent');assert.equal(completed.provider_message_id,accepted.get(first.key)!.id);assert.equal(completed.ciphertext,null);assert.equal(completed.error_code,null);
});

test('a provider response timeout leaves a retryable encrypted message and preserves the accepted idempotency key',async()=>{
  const actor=await register();await resetRequest(actor);modes.set(actor.email,'hold');
  const before=Date.now();assert.equal(await dispatch(databases[0]!,{timeoutMs:100}),1);assert(Date.now()-before<2000);
  const item=(await queued(actor))[0],first=sent(actor)[0]!;assert.equal(item.status,'pending');assert.equal(item.error_code,'ACCOUNT_EMAIL_SEND_FAILED');assert(item.ciphertext);
  holds.get(actor.email)!();holds.delete(actor.email);modes.delete(actor.email);
  await databases[0]!.query("UPDATE platform_account_email_outbox SET next_attempt_at=now()-interval '1 second' WHERE id=$1",[item.id]);
  assert.equal(await dispatch(databases[1]!),1);assert.equal(sent(actor)[1]!.key,first.key);assert.equal(sent(actor)[1]!.body,first.body);
  assert.equal((await queued(actor))[0].provider_message_id,accepted.get(first.key)!.id);
});

test('expired leases resume safely and expiry or corrupt payload prevents a provider call',async()=>{
  const actor=await register();await resetRequest(actor);const outbox=(await queued(actor))[0];
  await databases[0]!.query("UPDATE platform_account_email_outbox SET status='sending',lease_token=$2,lease_until=now()-interval '1 second' WHERE id=$1",[outbox.id,randomUUID()]);
  assert.equal(await dispatch(),1);assert.equal(sent(actor).length,1);assert.equal(sent(actor)[0]!.key,outbox.id);
  const expired=await register();await resetRequest(expired);const expiredOutbox=(await queued(expired))[0];
  await databases[0]!.query("UPDATE platform_account_actions SET created_at=now()-interval '16 minutes',expires_at=now()-interval '1 minute' WHERE user_id=$1",[expired.id]);
  const before=transportCalls;assert.equal(await dispatch(),0);assert.equal(transportCalls,before);assert.equal((await queued(expired))[0].status,'expired');assert.equal((await queued(expired))[0].ciphertext,null);
  const corrupt=await register();await resetRequest(corrupt);await databases[0]!.query('UPDATE platform_account_email_outbox SET ciphertext=$2 WHERE user_id=$1',[corrupt.id,Buffer.from('fictional-corrupt-payload')]);
  assert.equal(await dispatch(),1);assert.equal(transportCalls,before);assert.equal((await queued(corrupt))[0].status,'failed');assert.equal((await queued(corrupt))[0].error_code,'ACCOUNT_EMAIL_PAYLOAD_INVALID');assert.equal((await queued(corrupt))[0].ciphertext,null);
  assert.notEqual(expiredOutbox.ciphertext,null);
});

test('provider failure, redirect and bounded invalid receipts persist only fixed error codes and stop after deadline',async()=>{
  for(const mode of ['fail','redirect','oversized'] as const){
    const actor=await register();await resetRequest(actor);modes.set(actor.email,mode);assert.equal(await dispatch(),1);
    const item=(await queued(actor))[0];assert.equal(item.status,'pending');assert.equal(item.error_code,'ACCOUNT_EMAIL_SEND_FAILED');assert(item.ciphertext);
    assert(!JSON.stringify(item).includes('Fictional upstream private body'));
    await databases[0]!.query("UPDATE platform_account_email_outbox SET created_at=now()-interval '16 minutes',expires_at=now()-interval '1 minute',next_attempt_at=now()-interval '1 second' WHERE id=$1",[item.id]);
    const before=transportCalls;assert.equal(await dispatch(),0);assert.equal(transportCalls,before);assert.equal((await queued(actor))[0].status,'expired');assert.equal((await queued(actor))[0].ciphertext,null);
  }
});

test('verified access needs both the received token and matching authenticated owner, then current sessions see verification',async()=>{
  const alice=await register(),bob=await register(1);
  assertSafe(await exchange(0,'/auth/me',alice),200);
  const blocked=await exchange(1,'/conversations',alice);assertSafe(blocked,403);assert.equal(json(blocked).error.code,'EMAIL_VERIFICATION_REQUIRED');
  await verifyRequest(alice);await verifyRequest(alice,1);assert.equal((await queued(alice)).length,2);
  assert.equal(await processAccountEmails(databases[0]!,config,{fetch:transport,limit:2}),2);
  const tokens=sent(alice).map(linkToken);assert(tokens.every(item=>item.purpose==='verify-email'));
  const before=row(alice);const noLogin=await post(0,'/auth/email-verification/complete',undefined,{token:tokens[0]!.token});assertSafe(noLogin,401);
  const wrong=await post(1,'/auth/email-verification/complete',bob,{token:tokens[0]!.token});assertSafe(wrong,400);assert.equal(json(wrong).error.code,'ACCOUNT_ACTION_INVALID');assert.equal((await row(alice)).email_verified_at,null);
  const done=await post(1,'/auth/email-verification/complete',alice,{token:tokens[0]!.token});assertSafe(done,200);assert.equal(json(done).user.id,alice.id);assert.equal(json(done).user.emailVerified,true);assert.equal(done.headers['set-cookie'],undefined);
  assertSafe(await exchange(0,'/conversations',alice),200);assert.equal(json(await exchange(0,'/auth/me',bob)).user.emailVerified,false);
  const repeat=await post(0,'/auth/email-verification/complete',alice,{token:tokens[1]!.token});assertSafe(repeat,400);assert.equal(json(repeat).error.code,'ACCOUNT_ACTION_INVALID');
  assert.equal((await row(alice)).auth_version,(await before).auth_version);
});

test('single reset token is consumed once across HTTP instances and revokes every old session',async()=>{
  const alice=await register(),bob=await register(1);
  const second=await post(1,'/auth/login',undefined,{email:alice.email,password:alice.password});assertSafe(second,200);
  const secondCookie=second.headers['set-cookie']![0]!.split(';')[0]!;
  await resetRequest(alice);assert.equal(await dispatch(),1);const {token}=linkToken(sent(alice)[0]!);
  const password='Fictional-new-password-2026';
  const results=await Promise.all(Array.from({length:10},(_,index)=>post(index%2,'/auth/password-reset/complete',undefined,{token,password})));
  assert.equal(results.filter(result=>result.status===200).length,1);assert.equal(results.filter(result=>result.status===400).length,9);
  for(const result of results){assertSafe(result,result.status);if(result.status===400)assert.equal(json(result).error.code,'ACCOUNT_ACTION_INVALID');}
  const success=results.find(result=>result.status===200)!;assert.deepEqual(json(success),{ok:true});assert.match(success.headers['set-cookie']![0]!,/companion_session=;/);assert.match(success.headers['set-cookie']![0]!,/Max-Age=0|Expires=Thu, 01 Jan 1970/i);
  assertSafe(await exchange(0,'/auth/me',alice),401);assertSafe(await exchange(1,'/auth/me',{...alice,cookie:secondCookie}),401);assertSafe(await exchange(1,'/auth/me',bob),200);
  assert.equal((await row(alice)).auth_version,'1');assert(await checkPassword(password,(await row(alice)).password_hash));assert.equal((await row(bob)).auth_version,'0');
  assertSafe(await post(0,'/auth/login',undefined,{email:alice.email,password:alice.password}),401);
  const newLogin=await post(1,'/auth/login',undefined,{email:alice.email,password});assertSafe(newLogin,200);assert.equal(json(newLogin).user.emailVerified,false);
});

test('different valid reset tokens remain usable until one succeeds and atomically revoke all remaining actions and pending ciphertext',async()=>{
  const actor=await register();await resetRequest(actor);await resetRequest(actor,1);await verifyRequest(actor);
  assert.equal(await processAccountEmails(databases[0]!,config,{fetch:transport,limit:2}),2);
  const tokens=sent(actor).map(linkToken);assert(tokens.every(item=>item.purpose==='password-reset'));assert.equal((await queued(actor)).filter(item=>item.status==='pending').length,1);
  const changed=await Promise.allSettled(tokens.map((item,index)=>actions[index]!.consume('password-reset',item.token,`Fictional-new-password-${index}`)));
  assert.equal(changed.filter(result=>result.status==='fulfilled').length,1);assert.equal(changed.filter(result=>result.status==='rejected'&&invalidAction(result.reason)).length,1);
  assert.equal((await row(actor)).auth_version,'1');
  const all=(await databases[0]!.query('SELECT consumed_at FROM platform_account_actions WHERE user_id=$1',[actor.id])).rows;assert(all.every(item=>item.consumed_at));
  const pending=(await queued(actor)).find(item=>item.status==='revoked');assert(pending);assert.equal(pending.ciphertext,null);assert.equal(await dispatch(),0);
});

test('wrong purpose, expiry, secret malformation, forged extra owner/redirect and password bounds cannot mutate accounts',async()=>{
  const actor=await register(),other=await register(1);await resetRequest(actor);await dispatch();const {token}=linkToken(sent(actor)[0]!);
  for(const password of ['short','x'.repeat(257),'',null,123]){const result=await post(0,'/auth/password-reset/complete',undefined,{token,password});assertSafe(result,400);assert.equal(json(result).error.code,'INVALID_REQUEST');}
  const forged=await post(1,'/auth/password-reset/complete',other,{token,password:'Fictional-new-password',userId:other.id,email:other.email,redirect:'https://evil.example.invalid'});assertSafe(forged,400);
  await assert.rejects(actions[0]!.consume('verify-email',token,undefined,actor.id),invalidAction);
  await assert.rejects(actions[0]!.consume('password-reset','not-a-real-token','Fictional-new-password'),invalidAction);
  await databases[0]!.query("UPDATE platform_account_actions SET created_at=now()-interval '16 minutes',expires_at=now()-interval '1 minute' WHERE user_id=$1",[actor.id]);
  const expired=await post(0,'/auth/password-reset/complete',undefined,{token,password:'Fictional-new-password'});assertSafe(expired,400);assert.equal(json(expired).error.code,'ACCOUNT_ACTION_INVALID');
  assert.equal((await row(actor)).auth_version,'0');assert.equal((await row(other)).auth_version,'0');assert(await checkPassword(actor.password,(await row(actor)).password_hash));
});

test('Origin rejection and GET cannot enqueue or consume a challenge; unverified logout still works',async()=>{
  const actor=await register();const before=transportCalls;
  for(const options of [{origin:'https://evil.example.invalid'},{omitOrigin:true}]){
    const result=await post(0,'/auth/password-reset/request',undefined,{email:actor.email},options);assert.equal(result.status,403);assert.equal(json(result).error.code,'ORIGIN_REJECTED');
  }
  assert.equal((await queued(actor)).length,0);assert.equal(transportCalls,before);
  await resetRequest(actor);await dispatch();const {token}=linkToken(sent(actor)[0]!);
  const get=await exchange(1,`/auth/password-reset/complete?token=${token}`);assert.equal(get.status,404);
  const bad=await post(1,'/auth/password-reset/complete',undefined,{token,password:'Fictional-new-password'},{origin:'https://evil.example.invalid'});assert.equal(bad.status,403);
  assert.equal((await row(actor)).auth_version,'0');assert.equal((await databases[0]!.query('SELECT consumed_at FROM platform_account_actions WHERE token_hash=$1',[tokenHash(token)])).rows[0].consumed_at,null);
  const logout=await post(0,'/auth/logout',actor,{});assertSafe(logout,200);assertSafe(await exchange(0,'/auth/me',actor),401);assert.equal(modelCalls,0);
});

test('an outbox insertion failure rolls back the target count and challenge instead of exposing a half-issued action',async()=>{
  const actor=await register();
  // Reject one fictional owner's insert in PostgreSQL itself, after the challenge insert.
  assert.match(actor.id,/^[0-9a-f-]{36}$/);
  await databases[0]!.query(`ALTER TABLE platform_account_email_outbox ADD CONSTRAINT fictional_outbox_insert_failure CHECK (user_id <> '${actor.id}'::uuid)`);
  try {
    const failed=await post(0,'/auth/password-reset/request',undefined,{email:actor.email});assertSafe(failed,503);
    assert.equal((await queued(actor)).length,0);assert.equal((await databases[0]!.query('SELECT id FROM platform_account_actions WHERE user_id=$1',[actor.id])).rowCount,0);
  } finally {await databases[0]!.query('ALTER TABLE platform_account_email_outbox DROP CONSTRAINT fictional_outbox_insert_failure');}
  await resetRequest(actor);await resetRequest(actor,1);await resetRequest(actor);assert.equal((await queued(actor)).length,3);
});
