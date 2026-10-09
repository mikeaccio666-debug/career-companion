import { before,after,test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { PLATFORM_ACCOUNT_HEADER } from '@companion/platform-contracts';
import { createProviderRuntime } from '@companion/ai-core';
import { buildApp } from '../src/app.ts';
import { readConfig } from '../src/config.ts';
import { hashPassword } from '../src/auth.ts';
import { createCompanionNameSafetyFixture } from './fixtures/companion-name-safety.ts';
import { FICTIONAL_LEGAL } from './fixtures/student-entry.ts';
const origin='https://fictional-target.example.invalid',prefix='/api/platform/career/profile',password='Fictional-memory-password-123';
let f:Awaited<ReturnType<typeof createCompanionNameSafetyFixture>>,system:Awaited<ReturnType<typeof buildApp>>,calls=0;
before(async()=>{f=await createCompanionNameSafetyFixture();system=await buildApp({db:f.db,legalBundle:FICTIONAL_LEGAL,config:{...readConfig(),dataCrypto:f.crypto,requireVerifiedEmail:true,allowedOrigins:new Set([origin])},enableQueue:false,
 runtime:createProviderRuntime({env:{PLATFORM_ALLOW_PROVIDER_CALLS:'0'},fetch:async()=>{calls++;throw Error('No external provider is allowed');}})});});
after(async()=>{await system?.app.close();assert.equal(calls,0);await f?.close();});
async function actor(){const who=await f.actor();await f.db.query('UPDATE platform_users SET password_hash=$2 WHERE id=$1',[who.userId,await hashPassword(password)]);
 const r=await system.app.inject({method:'POST',url:'/api/platform/auth/login',headers:{origin},payload:{email:who.userId+'@example.invalid',password}});assert.equal(r.statusCode,200);
 const raw=r.headers['set-cookie'],cookie=(Array.isArray(raw)?raw[0]:raw)!.split(';')[0];return {id:who.userId,headers:{origin,cookie,[PLATFORM_ACCOUNT_HEADER]:who.userId}};}

const command=()=>({operationId:randomUUID(),expectedRevision:0,confirmed:true,facts:{degreeField:'cs',graduationMonth:'2028-06',graduated:false,targetTracks:['swe']}});
test('real password login profile save, read, update, operation observation and deletion remain versioned and no-store',async()=>{
 const a=await actor(),payload=command();assert.equal((await system.app.inject({url:prefix,headers:a.headers})).json().revision,0);
 const saved=await system.app.inject({method:'PATCH',url:prefix,headers:a.headers,payload});assert.equal(saved.statusCode,200,saved.body);assert.equal(saved.headers['cache-control'],'private, no-store');
 assert.equal(saved.json().profile.ownerId,a.id);assert.equal(saved.json().profile.revision,1);
 const retry=await system.app.inject({method:'PATCH',url:prefix,headers:a.headers,payload});assert.equal(retry.json().operation.replayed,true);
 const newer=await system.app.inject({method:'PATCH',url:prefix,headers:a.headers,payload:{...command(),expectedRevision:1}});assert.equal(newer.statusCode,200,newer.body);
 const observed=await system.app.inject({url:prefix+'/operations/'+payload.operationId,headers:a.headers});assert.equal(observed.statusCode,200,observed.body);assert.equal(observed.json().operation.appliedRevision,1);assert.equal(observed.json().revision,2);
 const deleted=await system.app.inject({method:'DELETE',url:prefix,headers:a.headers,payload:{operationId:randomUUID(),expectedRevision:2}});assert.equal(deleted.statusCode,200,deleted.body);assert.equal(deleted.json().profile,null);
 const current=await system.app.inject({url:prefix,headers:a.headers});assert.equal(current.json().revision,3);assert.equal(current.json().profile,null);
 assert.equal((await system.app.inject({method:'PATCH',url:prefix,headers:a.headers,payload})).json().profile,null);
});
test('account binding, CSRF, session and closed inputs reject forged ownership and confirmation',async()=>{
 const a=await actor(),b=await actor(),payload=command();await system.app.inject({method:'PATCH',url:prefix,headers:a.headers,payload});
 assert.equal((await system.app.inject({url:prefix,headers:b.headers})).json().profile,null);
 assert.equal((await system.app.inject({url:prefix+'/operations/'+payload.operationId,headers:b.headers})).statusCode,404);
 assert.equal((await system.app.inject({url:prefix,headers:{...b.headers,[PLATFORM_ACCOUNT_HEADER]:a.id}})).statusCode,409);
 assert.equal((await system.app.inject({method:'PATCH',url:prefix,headers:{...a.headers,origin:'https://evil.invalid'},payload:command()})).statusCode,403);
 for(const extra of [{ownerId:a.id},{source:'model'},{confirmed:false},{privateAllowed:true}])assert.equal((await system.app.inject({method:'PATCH',url:prefix,headers:a.headers,payload:{...command(),...extra}})).statusCode,400);
 for(const path of [prefix,prefix+'/operations/'+payload.operationId]){assert.equal((await system.app.inject({url:path+'?ownerId='+b.id,headers:a.headers})).statusCode,400);assert.equal((await system.app.inject({url:path})).statusCode,401);}
 assert.equal((await system.app.inject({method:'DELETE',url:prefix,headers:b.headers,payload:{operationId:randomUUID(),expectedRevision:0,ownerId:a.id}})).statusCode,400);
});
