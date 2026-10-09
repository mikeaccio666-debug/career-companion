import { before,after,test } from 'node:test';import assert from 'node:assert/strict';import { randomUUID } from 'node:crypto';
import { PLATFORM_ACCOUNT_HEADER,parseManualJob } from '@companion/platform-contracts';import { createProviderRuntime } from '@companion/ai-core';
import { buildApp } from '../src/app.ts';import { readConfig } from '../src/config.ts';import { hashPassword } from '../src/auth.ts';import { createCompanionNameSafetyFixture } from './fixtures/companion-name-safety.ts';import { FICTIONAL_LEGAL } from './fixtures/student-entry.ts';
const origin='https://fictional-job.example.invalid',prefix='/api/platform/career/job-observations',password='Fictional-job-password-123';let f:Awaited<ReturnType<typeof createCompanionNameSafetyFixture>>,system:Awaited<ReturnType<typeof buildApp>>,calls=0;
before(async()=>{f=await createCompanionNameSafetyFixture();system=await buildApp({db:f.db,legalBundle:FICTIONAL_LEGAL,config:{...readConfig(),dataCrypto:f.crypto,requireVerifiedEmail:true,allowedOrigins:new Set([origin])},enableQueue:false,runtime:createProviderRuntime({env:{PLATFORM_ALLOW_PROVIDER_CALLS:'0'},fetch:async()=>{calls++;throw Error('No external request is allowed');}})});});after(async()=>{await system?.app.close();assert.equal(calls,0);await f?.close();});
async function actor(){const who=await f.actor();await f.db.query('UPDATE platform_users SET password_hash=$2 WHERE id=$1',[who.userId,await hashPassword(password)]);const r=await system.app.inject({method:'POST',url:'/api/platform/auth/login',headers:{origin},payload:{email:who.userId+'@example.invalid',password}});assert.equal(r.statusCode,200);const raw=r.headers['set-cookie'],cookie=(Array.isArray(raw)?raw[0]:raw)!.split(';')[0];return {id:who.userId,headers:{origin,cookie,[PLATFORM_ACCOUNT_HEADER]:who.userId}};}
const command=()=>({operationId:randomUUID(),expectedRevision:0,employer:'Fictional Company',title:'Fictional Analyst',canonicalUrl:'https://www.linkedin.com/jobs/view/fictional-only',roleFamily:'da',location:'',deadlineAt:null,deadlineTimeZone:null,privateNote:'Fictional private note',jobText:'Fictional position. We will provide visa sponsorship.'});
test('actual login, CSRF and account-bound saved-job HTTP preserves manual uncertainty, source evidence and no-store',async()=>{
 const a=await actor(),payload=command(),created=await system.app.inject({method:'POST',url:prefix,headers:a.headers,payload});assert.equal(created.statusCode,201,created.body);assert.equal(created.headers['cache-control'],'private, no-store');const job=parseManualJob(created.json().job);assert.equal(job.ownerId,a.id);assert.equal(job.state,'unknown');assert.equal(job.sponsorshipEvidence[0].text,'We will provide visa sponsorship.');assert.equal(calls,0);
 const list=await system.app.inject({url:prefix,headers:a.headers});assert.equal(list.statusCode,200);assert(!('jobText' in list.json().jobs[0]));const duplicate=await system.app.inject({method:'POST',url:prefix+'/duplicates',headers:a.headers,payload:command()});assert.equal(duplicate.json().jobs[0].id,job.id);
 assert.equal((await system.app.inject({method:'POST',url:prefix,headers:a.headers,payload})).json().operation.replayed,true);assert.equal((await system.app.inject({method:'POST',url:prefix,headers:a.headers,payload:command()})).statusCode,409);
 const removed=await system.app.inject({method:'DELETE',url:prefix+'/'+job.id,headers:a.headers,payload:{operationId:randomUUID(),expectedRevision:1}});assert.equal(removed.statusCode,200);assert.equal(removed.json().job,null);assert.equal((await system.app.inject({url:prefix+'/'+job.id,headers:a.headers})).statusCode,404);assert.equal(calls,0);
});
test('foreign, stale headers, CSRF and fabricated live/eligibility/source metadata are rejected through real HTTP',async()=>{
 const a=await actor(),b=await actor(),r=await system.app.inject({method:'POST',url:prefix,headers:a.headers,payload:command()}),id=r.json().job.id;for(const request of [{url:prefix+'/'+id},{method:'DELETE' as const,url:prefix+'/'+id,payload:{operationId:randomUUID(),expectedRevision:1}}])assert.equal((await system.app.inject({...request,headers:b.headers})).statusCode,404);
 assert.equal((await system.app.inject({url:prefix,headers:{...b.headers,[PLATFORM_ACCOUNT_HEADER]:a.id}})).statusCode,409);assert.equal((await system.app.inject({method:'POST',url:prefix,headers:{...a.headers,origin:'https://evil.invalid'},payload:command()})).statusCode,403);
 for(const patch of [{state:'observed_open'},{source:'greenhouse'},{sponsorship:'explicit_yes'},{eligible:true},{checkedAt:'2026-10-08T00:00:00.000Z'},{ownerId:b.id}])assert.equal((await system.app.inject({method:'POST',url:prefix,headers:a.headers,payload:{...command(),...patch}})).statusCode,400);
 assert.equal((await system.app.inject({url:prefix+'?userId='+b.id,headers:a.headers})).statusCode,400);assert.equal((await system.app.inject({url:prefix})).statusCode,401);assert.equal((await system.app.inject({method:'PATCH',url:prefix+'/'+id,headers:a.headers,payload:command()})).statusCode,404);
});

test('actual authenticated GET reconciles the owner operation without resubmitting and rejects foreign or query authority',async()=>{
 const a=await actor(),b=await actor(),payload=command();
 const saved=await system.app.inject({method:'POST',url:prefix,headers:a.headers,payload});assert.equal(saved.statusCode,201);
 const url=prefix+'/operations/'+payload.operationId;
 const observed=await system.app.inject({url,headers:a.headers});assert.equal(observed.statusCode,200,observed.body);
 assert.equal(observed.headers['cache-control'],'private, no-store');assert.deepEqual(observed.json().job,saved.json().job);assert.equal(observed.json().operation.replayed,true);
 assert.equal((await system.app.inject({url,headers:b.headers})).statusCode,404);
 assert.equal((await system.app.inject({url:url+'?userId='+b.id,headers:a.headers})).statusCode,400);
 assert.equal((await system.app.inject({url})).statusCode,401);
 assert.equal((await system.app.inject({url,headers:{...a.headers,[PLATFORM_ACCOUNT_HEADER]:b.id}})).statusCode,409);
 assert.equal((await f.db.query('SELECT * FROM platform_career_job_observation_operations WHERE user_id=$1',[a.id])).rowCount,1);
 const removed=await system.app.inject({method:'DELETE',url:prefix+'/'+saved.json().job.id,headers:a.headers,payload:{operationId:randomUUID(),expectedRevision:1}});assert.equal(removed.statusCode,200);
 assert.equal((await system.app.inject({url,headers:a.headers})).json().job,null);assert.equal(calls,0);
});
