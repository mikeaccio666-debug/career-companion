import { before,after,test } from 'node:test';import assert from 'node:assert/strict';import { randomUUID } from 'node:crypto';
import { PLATFORM_ACCOUNT_HEADER,parseCareerStory,parseCareerProject } from '@companion/platform-contracts';import { createProviderRuntime } from '@companion/ai-core';import { buildApp } from '../src/app.ts';import { readConfig } from '../src/config.ts';import { hashPassword,tokenHash } from '../src/auth.ts';import { createCompanionNameSafetyFixture } from './fixtures/companion-name-safety.ts';import { FICTIONAL_LEGAL } from './fixtures/student-entry.ts';
const origin='https://fictional-stories.example.invalid',root='/api/platform/career/',password='Fictional-story-password-123';let f:Awaited<ReturnType<typeof createCompanionNameSafetyFixture>>,system:Awaited<ReturnType<typeof buildApp>>,calls=0;
before(async()=>{f=await createCompanionNameSafetyFixture();system=await buildApp({db:f.db,legalBundle:FICTIONAL_LEGAL,config:{...readConfig(),dataCrypto:f.crypto,requireVerifiedEmail:true,allowedOrigins:new Set([origin])},enableQueue:false,runtime:createProviderRuntime({env:{PLATFORM_ALLOW_PROVIDER_CALLS:'0'},fetch:async()=>{calls++;throw Error('No provider request allowed');}})});});after(async()=>{await system?.app.close();assert.equal(calls,0);await f?.close();});
async function actor(){const who=await f.actor();await f.db.query('UPDATE platform_users SET password_hash=$2 WHERE id=$1',[who.userId,await hashPassword(password)]);const r=await system.app.inject({method:'POST',url:'/api/platform/auth/login',headers:{origin},payload:{email:who.userId+'@example.invalid',password}});assert.equal(r.statusCode,200);const raw=r.headers['set-cookie'],cookie=(Array.isArray(raw)?raw[0]:raw)!.split(';')[0];return {id:who.userId,headers:{origin,cookie,[PLATFORM_ACCOUNT_HEADER]:who.userId}};}
const star={situation:'Fictional class.',task:'Fictional task.',action:'Fictional personal action.',result:'Fictional feedback.'};
const story=()=>({operationId:randomUUID(),expectedRevision:0,title:'Fictional story',experienceKind:'course_project',sensitivity:'normal',english:star,chinese:{situation:'',task:'',action:'',result:''},tags:[],projects:[]});
const project=()=>({operationId:randomUUID(),expectedRevision:0,title:'Fictional project',experienceKind:'course_project',sensitivity:'normal',occurredAt:'2026-08-01T00:00:00.000Z',context:'Fictional team task.',contribution:'Fictional individual work.',outcome:''});
test('actual logged-in story/project HTTP binds confirmation, privacy, original data and private no-store responses with zero model calls',async()=>{
 const a=await actor(),saved=await system.app.inject({method:'POST',url:root+'stories',headers:a.headers,payload:story()});assert.equal(saved.statusCode,201,saved.body);assert.equal(saved.headers['cache-control'],'private, no-store');const s=parseCareerStory(saved.json().record);assert.equal(s.ownerId,a.id);assert.equal(s.status,'draft');
 const confirm=await system.app.inject({method:'POST',url:root+'stories/'+s.id+'/confirm',headers:a.headers,payload:{operationId:randomUUID(),expectedRevision:1}});assert.equal(confirm.statusCode,200,confirm.body);assert.equal(confirm.json().record.confirmedRevision,2);
 const changed=await system.app.inject({method:'PATCH',url:root+'stories/'+s.id,headers:a.headers,payload:{...story(),expectedRevision:2}});assert.equal(changed.statusCode,200,changed.body);assert.equal(changed.json().record.status,'draft');assert.equal(changed.json().record.confirmedAt,null);
 const p=await system.app.inject({method:'POST',url:root+'projects',headers:a.headers,payload:project()});assert.equal(p.statusCode,201,p.body);assert.equal(parseCareerProject(p.json().record).verification,'self_reported');assert.equal((await system.app.inject({url:root+'progress',headers:a.headers})).json().progress.provisionalCounts.project,1);
 assert.equal((await system.app.inject({method:'DELETE',url:root+'stories/'+s.id,headers:a.headers,payload:{operationId:randomUUID(),expectedRevision:3}})).statusCode,200);assert.equal(calls,0);
});
test('real HTTP rejects cross-owner reads/writes/linking, stale account window, bad CSRF and manufactured expert/reviewer status',async()=>{
 const a=await actor(),b=await actor(),saved=await system.app.inject({method:'POST',url:root+'stories',headers:a.headers,payload:story()}),id=saved.json().record.id;for(const request of [{url:root+'stories/'+id},{method:'DELETE' as const,url:root+'stories/'+id,payload:{operationId:randomUUID(),expectedRevision:1}}])assert.equal((await system.app.inject({...request,headers:b.headers})).statusCode,404);
 assert.equal((await system.app.inject({url:root+'stories',headers:{...b.headers,[PLATFORM_ACCOUNT_HEADER]:a.id}})).statusCode,409);assert.equal((await system.app.inject({method:'POST',url:root+'stories',headers:{...a.headers,origin:'https://evil.invalid'},payload:story()})).statusCode,403);
 for(const patch of [{status:'confirmed'},{source:'expert'},{confirmedAt:'2026-10-08T00:00:00.000Z'},{ownerId:b.id},{practiceCount:100}])assert.equal((await system.app.inject({method:'POST',url:root+'stories',headers:a.headers,payload:{...story(),...patch}})).statusCode,400);
 for(const patch of [{verification:'mentor_reviewed'},{mentorReview:{reviewerId:a.id}},{kind:'interview'},{state:'active'}])assert.equal((await system.app.inject({method:'POST',url:root+'projects',headers:a.headers,payload:{...project(),...patch}})).statusCode,400);
 assert.equal((await system.app.inject({url:root+'stories?userId='+b.id,headers:a.headers})).statusCode,400);assert.equal((await system.app.inject({url:root+'stories'})).statusCode,401);assert.equal(calls,0);
});

test('application assembly reads actual records written through password-authenticated HTTP and revalidates the original source after an owner edit',async()=>{
 const a=await actor(),b=await actor();
 const who={userId:a.id,tokenHash:tokenHash(decodeURIComponent(a.headers.cookie.slice(a.headers.cookie.indexOf('=')+1)))};
 const saved=await system.app.inject({method:'POST',url:root+'projects',headers:a.headers,payload:project()});assert.equal(saved.statusCode,201,saved.body);
 const p=parseCareerProject(saved.json().record),index=await system.careerPreparationSources.read(who);assert.deepEqual(index.projects.map(p=>p.id),[p.id]);assert.equal(index.projects[0].revision,1);assert(!JSON.stringify(index).includes('Fictional individual work.'));
 const prepared=await system.careerPreparationSources.prepare(who,{skillId:'evidence-story',selection:{projectId:p.id}});assert.equal(prepared.built.context.inputs[0].id,p.id);assert.equal(prepared.built.context.profileRevision,0);
 assert.equal((await system.app.inject({url:root+'preparation-sources',headers:a.headers})).statusCode,404);
 await system.db.withBoundedTransaction(client=>system.careerPreparationSources.assertCurrentInTransaction(client,who,{ownerId:a.id,indexId:index.indexId}));
 const changed=await system.app.inject({method:'PATCH',url:root+'projects/'+p.id,headers:a.headers,payload:{...project(),expectedRevision:1,sensitivity:'restricted'}});assert.equal(changed.statusCode,200,changed.body);
 assert.deepEqual((await system.careerPreparationSources.read(who)).projects,[]);
 await assert.rejects(system.db.withBoundedTransaction(client=>system.careerPreparationSources.assertCurrentInTransaction(client,who,{ownerId:a.id,indexId:index.indexId})),(e:any)=>e.status===409);
 await assert.rejects(system.db.withBoundedTransaction(client=>system.careerPreparationSources.assertCurrentInTransaction(client,who,{ownerId:b.id,indexId:index.indexId})),(e:any)=>e.status===404);
 assert.equal(calls,0);
});

test('owner can observe a committed story operation without another write, including a later edit or deletion',async()=>{
 const a=await actor(),b=await actor(),body=story();
 const created=await system.app.inject({method:'POST',url:root+'stories',headers:a.headers,payload:body});assert.equal(created.statusCode,201);
 const id=created.json().record.id,url=root+'stories/operations/'+body.operationId;
 const count=async()=>Number((await f.db.query('SELECT count(*) n FROM platform_career_library_operations WHERE user_id=$1',[a.id])).rows[0].n);
 const read=()=>system.app.inject({url,headers:a.headers});
 for(let i=0;i<2;i++){const r=await read();assert.equal(r.statusCode,200);assert.equal(r.headers['cache-control'],'private, no-store');assert.equal(r.json().operation.replayed,true);assert.equal(r.json().operation.appliedRevision,1);assert.equal(r.json().record.id,id);}
 assert.equal(await count(),1);
 assert.equal((await system.app.inject({url,headers:b.headers})).statusCode,404);
 assert.equal((await system.app.inject({url})).statusCode,401);
 assert.equal((await system.app.inject({url:url+'?ownerId='+a.id,headers:a.headers})).statusCode,400);
 assert.equal((await system.app.inject({url:root+'projects/operations/'+body.operationId,headers:a.headers})).statusCode,404);
 const edit=await system.app.inject({method:'PATCH',url:root+'stories/'+id,headers:a.headers,payload:{...story(),expectedRevision:1,title:'Fictional revised story'}});assert.equal(edit.statusCode,200);
 const updated=await read();assert.equal(updated.json().record.revision,2);assert.equal(updated.json().operation.appliedRevision,1);assert.equal(await count(),2);
 const removal=await system.app.inject({method:'DELETE',url:root+'stories/'+id,headers:a.headers,payload:{operationId:randomUUID(),expectedRevision:2}});assert.equal(removal.statusCode,200);
 const deleted=await read();assert.equal(deleted.statusCode,200);assert.equal(deleted.json().record,null);assert.equal(deleted.json().evidenceAvailability,null);assert.equal(await count(),3);
});
test('observation cannot infer deletion from an absent row or manufacture an operation; project receipt stays privately readable after email admission is withdrawn',async()=>{
 const a=await actor(),body=project(),saved=await system.app.inject({method:'POST',url:root+'projects',headers:a.headers,payload:body});assert.equal(saved.statusCode,201);
 const url=root+'projects/operations/'+body.operationId;
 await f.db.query('UPDATE platform_users SET email_verified_at=NULL WHERE id=$1',[a.id]);
 const r=await system.app.inject({url,headers:a.headers});assert.equal(r.statusCode,200);assert.equal(r.json().record.id,saved.json().record.id);
 assert.equal((await system.app.inject({url:root+'projects/operations/'+randomUUID(),headers:a.headers})).statusCode,404);
 assert.equal((await system.app.inject({url:root+'projects/operations/not-an-id',headers:a.headers})).statusCode,404);
 // Administrative fault injection into this test's private schema: no delete receipt exists.
 await f.db.query('DELETE FROM platform_career_evidence WHERE user_id=$1 AND id=$2',[a.id,saved.json().record.id]);
 const missing=await system.app.inject({url,headers:a.headers});assert.equal(missing.statusCode,503);assert.equal(missing.json().error.code,'REQUEST_FAILED');
 const fixed={userId:a.id,tokenHash:tokenHash(decodeURIComponent(a.headers.cookie.slice(a.headers.cookie.indexOf('=')+1)))};
 await assert.rejects(system.careerStories.observe(fixed,'project',body.operationId),(error:any)=>error.status===503&&error.code==='CAREER_LIBRARY_STORAGE_UNAVAILABLE');
 assert.equal((await f.db.query('SELECT count(*)::int n FROM platform_career_library_operations WHERE user_id=$1',[a.id])).rows[0].n,1);
 await f.db.query('DELETE FROM platform_sessions WHERE user_id=$1',[a.id]);
 assert.equal((await system.app.inject({url,headers:a.headers})).statusCode,401);
});
