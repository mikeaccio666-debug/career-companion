import {before,after,test} from 'node:test';import assert from 'node:assert/strict';import {randomUUID} from 'node:crypto';
import {PLATFORM_ACCOUNT_HEADER} from '@companion/platform-contracts';
import {createProviderRuntime} from '@companion/ai-core';
import {buildApp} from '../src/app.ts';import {readConfig} from '../src/config.ts';import {hashPassword} from '../src/auth.ts';
import {createCompanionNameSafetyFixture} from './fixtures/companion-name-safety.ts';import {FICTIONAL_LEGAL} from './fixtures/student-entry.ts';
const origin='https://fictional-feedback.example.invalid',prefix='/api/platform/feedback',password='Fictional-feedback-password-123';
let f:Awaited<ReturnType<typeof createCompanionNameSafetyFixture>>,system:Awaited<ReturnType<typeof buildApp>>,authority:Awaited<ReturnType<typeof f.identityAuthority>>,calls=0;
before(async()=>{f=await createCompanionNameSafetyFixture();authority=await f.identityAuthority();system=await buildApp({db:f.db,legalBundle:FICTIONAL_LEGAL,config:{...readConfig(),dataCrypto:f.crypto,supportOrganizationId:authority.orgId,productEventsEnabled:true,allowedOrigins:new Set([origin])},enableQueue:false,
 runtime:createProviderRuntime({env:{PLATFORM_ALLOW_PROVIDER_CALLS:'0'},fetch:async()=>{calls++;throw Error('No provider call allowed');}})});});
after(async()=>{await system?.app.close();assert.equal(calls,0);await f?.close();});
async function login(who?:{userId:string}){who??=await f.actor();await f.db.query('UPDATE platform_users SET password_hash=$2 WHERE id=$1',[who.userId,await hashPassword(password)]);
 const r=await system.app.inject({method:'POST',url:'/api/platform/auth/login',headers:{origin},payload:{email:who.userId+'@example.invalid',password}});assert.equal(r.statusCode,200,r.body);
 const raw=r.headers['set-cookie'],cookie=(Array.isArray(raw)?raw[0]:raw)!.split(';')[0];return {id:who.userId,headers:{origin,cookie,[PLATFORM_ACCOUNT_HEADER]:who.userId}};}
const command=()=>({operationId:randomUUID(),recipientId:authority.orgId,category:'other',surface:'today',description:'Fictional feedback request',sharedExcerpt:null,shareWithSupport:true});
test('password-authenticated student submission reaches audited staff inbox and replies become visible to reporter',async()=>{
 const a=await login(),staff=await login(authority.operator),payload=command();
 const saved=await system.app.inject({method:'POST',url:prefix,headers:a.headers,payload});assert.equal(saved.statusCode,200,saved.body);assert.equal(saved.headers['cache-control'],'private, no-store');const id=saved.json().feedback.id;
 assert.equal((await system.app.inject({method:'POST',url:prefix,headers:a.headers,payload})).json().operation.replayed,true);
 const inbox=await system.app.inject({url:'/api/platform/staff/feedback',headers:staff.headers});assert.equal(inbox.statusCode,200,inbox.body);assert(inbox.json().records.some((r:any)=>r.id===id));assert.equal(inbox.headers['cache-control'],'private, no-store');
 const updated=await system.app.inject({method:'PATCH',url:'/api/platform/staff/feedback/'+id,headers:staff.headers,payload:{operationId:randomUUID(),expectedRevision:1,status:'resolved',triage:'defect',reply:'The fictional issue is corrected.'}});assert.equal(updated.statusCode,200,updated.body);
 const read=await system.app.inject({url:prefix+'/'+id,headers:a.headers});assert.equal(read.statusCode,200);assert.equal(read.json().status,'resolved');assert.equal(read.json().updates[0].reply,'The fictional issue is corrected.');
});
test('routes require actual account context and CSRF; clients cannot select report ownership or support organization',async()=>{
 const a=await login(),b=await login(),payload=command(),saved=await system.app.inject({method:'POST',url:prefix,headers:a.headers,payload});const id=saved.json().feedback.id;
 assert.equal((await system.app.inject({url:prefix+'/'+id,headers:b.headers})).statusCode,404);
 assert.equal((await system.app.inject({url:prefix,headers:{...b.headers,[PLATFORM_ACCOUNT_HEADER]:a.id}})).statusCode,409);
 assert.equal((await system.app.inject({method:'POST',url:prefix,headers:{...a.headers,origin:'https://evil.invalid'},payload:command()})).statusCode,403);
 assert.equal((await system.app.inject({url:'/api/platform/staff/feedback',headers:a.headers})).statusCode,403);
 for(const extra of [{ownerId:a.id},{organizationId:authority.orgId},{shareWithSupport:false},{conversationId:randomUUID()}])
  assert.equal((await system.app.inject({method:'POST',url:prefix,headers:a.headers,payload:{...command(),...extra}})).statusCode,400);
 for(const path of [prefix,prefix+'/'+id,'/api/platform/staff/feedback']){
  assert.equal((await system.app.inject({url:path+'?orgId='+authority.orgId,headers:a.headers})).statusCode,400);
  assert.equal((await system.app.inject({url:path})).statusCode,401);
 }
 assert.equal((await system.app.inject({url:prefix+'?after=invalid',headers:a.headers})).statusCode,400);
 await f.db.query("UPDATE platform_sessions SET expires_at=clock_timestamp()-interval '1 second' WHERE user_id=$1",[a.id]);
 assert.equal((await system.app.inject({url:prefix,headers:a.headers})).statusCode,401);
});

test('routing availability and read-only operation observation use real sessions and do not accept recipient overrides',async()=>{
 const a=await login(),body=command();
 const info=await system.app.inject({url:prefix+'/availability',headers:a.headers});assert.equal(info.statusCode,200,info.body);assert.equal(info.json().recipient.id,authority.orgId);assert.equal(info.headers['cache-control'],'private, no-store');
 assert.equal((await system.app.inject({method:'POST',url:prefix,headers:a.headers,payload:{...body,recipientId:randomUUID()}})).statusCode,409);
 assert.equal((await system.app.inject({url:prefix+'/operations/'+body.operationId,headers:a.headers})).statusCode,404);
 const saved=await system.app.inject({method:'POST',url:prefix,headers:a.headers,payload:body});assert.equal(saved.statusCode,200);
 const observed=await system.app.inject({url:prefix+'/operations/'+body.operationId,headers:a.headers});assert.equal(observed.statusCode,200,observed.body);assert.equal(observed.json().operation.replayed,true);assert.equal(observed.json().feedback.id,saved.json().feedback.id);
 for(const path of [prefix+'/availability',prefix+'/operations/'+body.operationId])assert.equal((await system.app.inject({url:path+'?recipientId='+authority.orgId,headers:a.headers})).statusCode,400);
});
