import { before,after,test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { PLATFORM_ACCOUNT_HEADER,parseCareerTarget } from '@companion/platform-contracts';
import { createProviderRuntime } from '@companion/ai-core';
import { buildApp } from '../src/app.ts';
import { readConfig } from '../src/config.ts';
import { hashPassword } from '../src/auth.ts';
import { createCompanionNameSafetyFixture } from './fixtures/companion-name-safety.ts';
import { FICTIONAL_LEGAL } from './fixtures/student-entry.ts';
const origin='https://fictional-target.example.invalid',prefix='/api/platform/career/targets',password='Fictional-memory-password-123';
let f:Awaited<ReturnType<typeof createCompanionNameSafetyFixture>>,system:Awaited<ReturnType<typeof buildApp>>,calls=0;
before(async()=>{f=await createCompanionNameSafetyFixture();system=await buildApp({db:f.db,legalBundle:FICTIONAL_LEGAL,config:{...readConfig(),dataCrypto:f.crypto,requireVerifiedEmail:true,allowedOrigins:new Set([origin])},enableQueue:false,
 runtime:createProviderRuntime({env:{PLATFORM_ALLOW_PROVIDER_CALLS:'0'},fetch:async()=>{calls++;throw Error('No external provider is allowed');}})});});
after(async()=>{await system?.app.close();assert.equal(calls,0);await f?.close();});
async function actor(){const who=await f.actor();await f.db.query('UPDATE platform_users SET password_hash=$2 WHERE id=$1',[who.userId,await hashPassword(password)]);
 const r=await system.app.inject({method:'POST',url:'/api/platform/auth/login',headers:{origin},payload:{email:who.userId+'@example.invalid',password}});assert.equal(r.statusCode,200);
 const raw=r.headers['set-cookie'],cookie=(Array.isArray(raw)?raw[0]:raw)!.split(';')[0];return {id:who.userId,headers:{origin,cookie,[PLATFORM_ACCOUNT_HEADER]:who.userId}};}
const command=()=>({operationId:randomUUID(),expectedRevision:0,roleFamily:'swe',title:'Fictional Backend Direction',locations:[],priority:1});
test('real logged-in HTTP direction lifecycle is versioned, account-bound and no-store',async()=>{
 const a=await actor(),payload=command(),created=await system.app.inject({method:'POST',url:prefix,headers:a.headers,payload});assert.equal(created.statusCode,201,created.body);assert.equal(created.headers['cache-control'],'private, no-store');
 const target=parseCareerTarget(created.json().target);assert.equal(target.ownerId,a.id);assert.equal(target.status,'exploring');
 assert.equal((await system.app.inject({method:'POST',url:prefix,headers:a.headers,payload})).json().operation.replayed,true);
 const active=await system.app.inject({method:'POST',url:prefix+'/'+target.id+'/status',headers:a.headers,payload:{operationId:randomUUID(),expectedRevision:1,status:'active'}});assert.equal(active.statusCode,200,active.body);assert.equal(active.json().target.revision,2);
 assert.equal((await system.app.inject({url:prefix,headers:a.headers})).json().targets.length,1);
 const changed=await system.app.inject({method:'PATCH',url:prefix+'/'+target.id,headers:a.headers,payload:{operationId:randomUUID(),expectedRevision:2,title:'Fictional Updated Direction'}});assert.equal(changed.statusCode,200,changed.body);
 const removed=await system.app.inject({method:'DELETE',url:prefix+'/'+target.id,headers:a.headers,payload:{operationId:randomUUID(),expectedRevision:3}});assert.equal(removed.statusCode,200);assert.equal(removed.json().target,null);
 assert.equal((await system.app.inject({url:prefix+'/'+target.id,headers:a.headers})).statusCode,404);assert.equal(calls,0);
});
test('cross-owner reads and writes, stale account headers, CSRF, and fabricated expert attribution are rejected',async()=>{
 const a=await actor(),b=await actor(),saved=await system.app.inject({method:'POST',url:prefix,headers:a.headers,payload:command()}),id=saved.json().target.id;
 for(const request of [{url:prefix+'/'+id},{method:'PATCH' as const,url:prefix+'/'+id,payload:{operationId:randomUUID(),expectedRevision:1,title:'Fictional foreign'}},{method:'DELETE' as const,url:prefix+'/'+id,payload:{operationId:randomUUID(),expectedRevision:1}}])assert.equal((await system.app.inject({...request,headers:b.headers})).statusCode,404);
 assert.equal((await system.app.inject({url:prefix,headers:{...b.headers,[PLATFORM_ACCOUNT_HEADER]:a.id}})).statusCode,409);
 assert.equal((await system.app.inject({method:'POST',url:prefix,headers:{...a.headers,origin:'https://evil.invalid'},payload:command()})).statusCode,403);
 for(const extra of [{ownerId:a.id},{status:'active'},{proposedBy:'expert:planner'},{source:'model'},{confirmed:true}])assert.equal((await system.app.inject({method:'POST',url:prefix,headers:a.headers,payload:{...command(),...extra}})).statusCode,400);
 assert.equal((await system.app.inject({url:prefix+'?userId='+b.id,headers:a.headers})).statusCode,400);assert.equal((await system.app.inject({url:prefix})).statusCode,401);
});
