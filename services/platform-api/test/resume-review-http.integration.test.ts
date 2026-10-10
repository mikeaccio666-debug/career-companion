import { createHash } from 'node:crypto';
import { fictionalResumePdf } from './fixtures/resume-pdf.ts';
import { before,after,test } from 'node:test';import assert from 'node:assert/strict';import { randomUUID } from 'node:crypto';
import { PLATFORM_ACCOUNT_HEADER,parseResumeReviewView } from '@companion/platform-contracts';import { createProviderRuntime } from '@companion/ai-core';import { buildApp } from '../src/app.ts';import { readConfig } from '../src/config.ts';import { hashPassword } from '../src/auth.ts';import { createCompanionNameSafetyFixture } from './fixtures/companion-name-safety.ts';import { FICTIONAL_LEGAL } from './fixtures/student-entry.ts';
const origin='https://fictional-resume-review.example.invalid',password='Fictional-original-password-123',root='/api/platform/';
let f:Awaited<ReturnType<typeof createCompanionNameSafetyFixture>>,system:Awaited<ReturnType<typeof buildApp>>,calls=0;
before(async()=>{f=await createCompanionNameSafetyFixture();system=await buildApp({db:f.db,legalBundle:FICTIONAL_LEGAL,config:{...readConfig(),dataCrypto:f.crypto,requireVerifiedEmail:true,allowedOrigins:new Set([origin])},enableQueue:false,runtime:createProviderRuntime({env:{PLATFORM_ALLOW_PROVIDER_CALLS:'0'},fetch:async()=>{calls++;throw Error('No provider request allowed.');}})});});after(async()=>{await system?.app.close();assert.equal(calls,0);await f?.close();});
async function actor(){const who=await f.actor();await f.db.query('UPDATE platform_users SET password_hash=$2 WHERE id=$1',[who.userId,await hashPassword(password)]);const r=await system.app.inject({method:'POST',url:root+'auth/login',headers:{origin},payload:{email:who.userId+'@example.invalid',password}});assert.equal(r.statusCode,200);const raw=r.headers['set-cookie'],cookie=(Array.isArray(raw)?raw[0]:raw)!.split(';')[0];return {id:who.userId,context:who,headers:{origin,cookie,[PLATFORM_ACCOUNT_HEADER]:who.userId}};}
const create=()=>({operationId:randomUUID(),expectedRevision:0,track:'da',label:'Fictional raw original',text:'Fictional strategy course project; personal research action.'});
test('actual password-login Web original review confirms one immutable payload and leaves approved old version usable when creating a new same-track draft',async()=>{
 const a=await actor(),body=create(),r=await system.app.inject({method:'POST',url:root+'career/resume-versions',headers:a.headers,payload:body});assert.equal(r.statusCode,201,r.body);assert.equal(r.headers['cache-control'],'private, no-store');const v=parseResumeReviewView(r.json().view);
 const approved=await system.app.inject({method:'POST',url:root+'pending-items/'+v.item.id+'/decision',headers:a.headers,payload:{operationId:randomUUID(),revision:1,payloadDigest:v.item.payloadDigest,decision:'approve'}});assert.equal(approved.statusCode,200,approved.body);assert.equal(approved.json().view.item.resumeStatus,'active');
 const fresh=await system.app.inject({method:'POST',url:root+'career/resume-versions',headers:a.headers,payload:{...create(),derivedFromId:v.item.resumeVersionId,text:'Fictional revised project.'}});assert.equal(fresh.statusCode,201,fresh.body);
 assert.equal((await system.app.inject({url:root+'career/resume-versions/'+v.item.resumeVersionId,headers:a.headers})).json().item.resumeStatus,'active');
 assert.equal((await system.app.inject({url:root+'pending-items/operations/'+body.operationId,headers:a.headers})).json().view.item.status,'approved');
 const list=await system.app.inject({url:root+'pending-items?status=pending',headers:a.headers});assert.equal(list.statusCode,200,list.body);assert.equal(list.json().items.length,1);assert(!list.body.includes('Fictional revised project.'));
 assert.equal(calls,0);
});
test('real stale digest, cross-owner and window/CSRF boundaries cannot confirm a different original, impersonate an expert, batch approve or send',async()=>{
 const a=await actor(),b=await actor(),saved=await system.app.inject({method:'POST',url:root+'career/resume-versions',headers:a.headers,payload:create()}),v=parseResumeReviewView(saved.json().view);
 const decision={operationId:randomUUID(),revision:1,payloadDigest:v.item.payloadDigest,decision:'approve'};
 assert.equal((await system.app.inject({method:'POST',url:root+'pending-items/'+v.item.id+'/decision',headers:b.headers,payload:decision})).statusCode,404);
 assert.equal((await system.app.inject({url:root+'pending-items/'+v.item.id,headers:{...b.headers,[PLATFORM_ACCOUNT_HEADER]:a.id}})).statusCode,409);
 assert.equal((await system.app.inject({method:'POST',url:root+'pending-items/'+v.item.id+'/decision',headers:{...a.headers,origin:'https://evil.invalid'},payload:decision})).statusCode,403);
 for(const patch of [{channel:'discord'},{approvedAt:v.item.createdAt},{ownerId:b.id}])assert.equal((await system.app.inject({method:'POST',url:root+'pending-items/'+v.item.id+'/decision',headers:a.headers,payload:{...decision,...patch}})).statusCode,400);
 for(const patch of [{kind:'email_draft'},{claims:[{text:'Invented work.'}]},{draftedBy:'guide'},{source:'model'},{uploadId:randomUUID()}])assert.equal((await system.app.inject({method:'POST',url:root+'career/resume-versions',headers:a.headers,payload:{...create(),...patch}})).statusCode,400);
 for(const route of ['pending-items/approve','pending-items/'+v.item.id+'/mark-sent'])assert.equal((await system.app.inject({method:'POST',url:root+route,headers:a.headers,payload:decision})).statusCode,404);
 assert.equal((await system.app.inject({method:'POST',url:root+'pending-items/'+v.item.id+'/decision',headers:a.headers,payload:{...decision,decision:'request_changes'}})).statusCode,503);
 const edit=await system.app.inject({method:'POST',url:root+'pending-items/'+v.item.id+'/revisions',headers:a.headers,payload:{operationId:randomUUID(),expectedRevision:1,payloadDigest:v.item.payloadDigest,label:'Fictional edited raw',text:'Fictional one-character change.'}});assert.equal(edit.statusCode,200,edit.body);
 assert.equal((await system.app.inject({method:'POST',url:root+'pending-items/'+v.item.id+'/decision',headers:a.headers,payload:decision})).statusCode,409);
 assert.equal((await system.app.inject({url:root+'pending-items/'+v.item.id,headers:a.headers})).json().item.status,'pending');
 assert.equal((await system.app.inject({url:root+'pending-items'})).statusCode,401);
});
test('the actual original-operation observer confirms deletion without reviving private content, and original revision reads are owner-scoped',async()=>{
 const a=await actor(),body=create(),r=await system.app.inject({method:'POST',url:root+'career/resume-versions',headers:a.headers,payload:body}),v=parseResumeReviewView(r.json().view);
 const original=await system.app.inject({url:root+'pending-items/'+v.item.id+'/revisions/1',headers:a.headers});assert.equal(original.statusCode,200,original.body);assert.equal(original.json().payload.text,body.text);
 const deleted=await system.app.inject({method:'DELETE',url:root+'pending-items/'+v.item.id,headers:a.headers,payload:{operationId:randomUUID(),expectedRevision:1,payloadDigest:v.item.payloadDigest}});assert.equal(deleted.statusCode,200,deleted.body);
 assert.equal((await system.app.inject({url:root+'pending-items/operations/'+body.operationId,headers:a.headers})).json().view,null);
 assert.equal((await system.app.inject({method:'POST',url:root+'career/resume-versions',headers:a.headers,payload:body})).json().view,null);
 assert.equal((await system.app.inject({url:root+'pending-items/'+v.item.id+'/revisions/1',headers:a.headers})).statusCode,404);assert.equal(calls,0);
});

test('real HTTP owner cursors page resume versions, experience records and saved jobs without leaking body fields',async()=>{
 let a=await actor();const other=await actor();
 for(let i=0;i<52;i++){
  const saved=await system.app.inject({method:'POST',url:root+'career/resume-versions',headers:a.headers,payload:create()});assert.equal(saved.statusCode,201,saved.body);
 }
 async function pages(path:string,key:string){
  const first=await system.app.inject({url:root+path,headers:a.headers});assert.equal(first.statusCode,200,first.body);assert.equal(first.json()[key].length,50);assert(first.json().nextAfter);
  const cursor=first.json().nextAfter;
  const second=await system.app.inject({url:root+path+'?after='+cursor,headers:a.headers});assert.equal(second.statusCode,200,second.body);assert.equal(second.json()[key].length,2);assert.equal(second.json().nextAfter,null);
  const ids=[...first.json()[key],...second.json()[key]].map((v:any)=>v.record?.id??v.id);assert.equal(new Set(ids).size,52);
  assert.equal((await system.app.inject({url:root+path+'?after='+cursor,headers:other.headers})).statusCode,404);
  for(const query of ['after='+cursor+'&after='+cursor,'unsupported=x'])assert.equal((await system.app.inject({url:root+path+'?'+query,headers:a.headers})).statusCode,400);
  return {first,second};
 }
 const resumes=await pages('career/resume-versions','items');assert(!resumes.first.body.includes('personal research action'));
 assert.equal((await system.app.inject({url:root+'pending-items?status=superseded',headers:a.headers})).json().items.length,50);
 assert.equal((await system.app.inject({url:root+'pending-items?status=pending&status=approved',headers:a.headers})).statusCode,400);
 a=await actor();
 for(let i=0;i<52;i++){
  const project={operationId:randomUUID(),expectedRevision:0,title:'Fictional project '+i,experienceKind:'course_project',sensitivity:'normal',occurredAt:'2026-08-01T00:00:00.000Z',context:'Fictional class context.',contribution:'Fictional personal contribution.',outcome:'Fictional class feedback.'};
  const result=await system.app.inject({method:'POST',url:root+'career/projects',headers:a.headers,payload:project});assert.equal(result.statusCode,201,result.body);
 }
 const projects=await pages('career/projects','records');assert(!projects.first.body.includes('Fictional personal contribution.'));
 a=await actor();
 for(let i=0;i<52;i++){
  const job={operationId:randomUUID(),expectedRevision:0,employer:'Fictional Company '+i,title:'Fictional Analyst',canonicalUrl:'https://example.invalid/jobs/'+i,roleFamily:'da',location:'',deadlineAt:null,deadlineTimeZone:null,privateNote:'Fictional private note',jobText:'Fictional raw job description.'};
  const saved=await system.app.inject({method:'POST',url:root+'career/job-observations',headers:a.headers,payload:job});assert.equal(saved.statusCode,201,saved.body);
 }
 const jobs=await pages('career/job-observations','jobs');assert(!jobs.first.body.includes('Fictional raw job description.'));
 assert.equal(calls,0);
});
test('real HTTP memory pagination keeps unreviewed legacy sensitivity private and requires explicit owner review',async()=>{
 const a=await actor(),other=await actor();for(let i=0;i<3;i++)await f.db.query('INSERT INTO platform_memories(id,user_id,content) VALUES($1,$2,$3)',[randomUUID(),a.id,'Fictional unreviewed original '+i]);
 const first=await system.app.inject({url:root+'memories?limit=2',headers:a.headers});assert.equal(first.statusCode,200,first.body);assert.equal(first.json().memories.length,2);assert(first.json().nextCursor);assert(first.json().memories.every((m:any)=>m.kind==='needs_review'));
 const cursor=encodeURIComponent(first.json().nextCursor),second=await system.app.inject({url:root+'memories?limit=2&cursor='+cursor,headers:a.headers});assert.equal(second.statusCode,200,second.body);assert.equal(second.json().memories.length,1);
 assert.equal((await system.app.inject({url:root+'memories?cursor='+cursor,headers:other.headers})).statusCode,400);
 assert.equal((await system.app.inject({url:root+'memories?limit=2&limit=3',headers:a.headers})).statusCode,400);
 assert.equal((await system.app.inject({url:root+'career/targets?ownerId='+a.id,headers:a.headers})).statusCode,400);
});

test('actual buildApp assembly feeds an HTTP-confirmed original into the real source index without granting model access or copying its body',async()=>{
 const a=await actor(),body=create(),r=await system.app.inject({method:'POST',url:root+'career/resume-versions',headers:a.headers,payload:body}),v=parseResumeReviewView(r.json().view);
 assert.deepEqual((await system.careerPreparationSources.read(a.context)).resumes,[]);
 const confirmed=await system.app.inject({method:'POST',url:root+'pending-items/'+v.item.id+'/decision',headers:a.headers,payload:{operationId:randomUUID(),revision:1,payloadDigest:v.item.payloadDigest,decision:'approve'}});assert.equal(confirmed.statusCode,200,confirmed.body);
 const index=await system.careerPreparationSources.read(a.context);assert.equal(index.resumes!.length,1);assert.equal(index.resumes![0].id,v.item.resumeVersionId);assert.equal(index.resumes![0].revision,1);assert(!JSON.stringify(index).includes(body.text));assert(!JSON.stringify(index).includes(body.label));
 const prepared=await system.careerPreparationSources.prepare(a.context,{skillId:'resume-revision',selection:{resumeId:v.item.resumeVersionId}});assert.equal(prepared.built.context.inputs.find(r=>r.input==='resume-source')!.id,v.item.resumeVersionId);assert.deepEqual(prepared.built.context.tools,{});assert(!prepared.built.unavailableSources.includes('readProfile'));
 assert.deepEqual(prepared.sourceIndex.profileSource,{available:true,profile:null});
 assert.equal(prepared.built.context.profileRevision,0);
 assert(!prepared.built.context.inputs.some(input=>input.input==='confirmed-profile'));assert.equal(calls,0);
});

test('actual multipart upload to original review preserves owned file provenance and leaves text unconfirmed until one full Web decision',async()=>{
 const a=await actor(),other=await actor(),bytes=fictionalResumePdf(),boundary='FictionalBoundary'+randomUUID().replaceAll('-',''),payload=Buffer.concat([Buffer.from('--'+boundary+'\r\nContent-Disposition: form-data; name="file"; filename="Fictional CV.pdf"\r\nContent-Type: application/pdf\r\n\r\n'),bytes,Buffer.from('\r\n--'+boundary+'--\r\n')]);
 const uploaded=await system.app.inject({method:'POST',url:root+'uploads',headers:{...a.headers,'content-type':'multipart/form-data; boundary='+boundary},payload});assert.equal(uploaded.statusCode,201,uploaded.body);const id=uploaded.json().attachment.id;
 const key=(await f.db.query('SELECT storage_key FROM platform_uploads WHERE id=$1 AND user_id=$2',[id,a.id])).rows[0].storage_key;
 try{
  const list=await system.app.inject({url:root+'career/resume-uploads',headers:a.headers});assert.equal(list.statusCode,200,list.body);assert.equal(list.json().files[0].id,id);assert(!list.body.includes('storage_key'));
  const command={operationId:randomUUID(),expectedRevision:0,track:'da',label:'Fictional uploaded original',uploadId:id,sha256:createHash('sha256').update(bytes).digest('hex')};
  assert.equal((await system.app.inject({method:'POST',url:root+'career/resume-versions/from-upload',headers:other.headers,payload:command})).statusCode,404);
  const saved=await system.app.inject({method:'POST',url:root+'career/resume-versions/from-upload',headers:a.headers,payload:command});assert.equal(saved.statusCode,201,saved.body);assert.equal(saved.headers['cache-control'],'private, no-store');const v=parseResumeReviewView(saved.json().view);assert.equal(v.item.source,'upload');assert.equal(v.item.uploadId,id);assert.equal(v.item.status,'pending');assert(v.payload.text.includes('Fictional CV'));assert.equal(v.payload.source_refs[1]!.sha256,command.sha256);
  assert.deepEqual((await system.careerPreparationSources.read(a.context)).resumes,[]);
  const decision=await system.app.inject({method:'POST',url:root+'pending-items/'+v.item.id+'/decision',headers:a.headers,payload:{operationId:randomUUID(),revision:1,payloadDigest:v.item.payloadDigest,decision:'approve'}});assert.equal(decision.statusCode,200,decision.body);assert.equal((await system.careerPreparationSources.read(a.context)).resumes![0].id,v.item.resumeVersionId);
  const replay=await system.app.inject({method:'POST',url:root+'career/resume-versions/from-upload',headers:a.headers,payload:command});assert.equal(replay.statusCode,200,replay.body);assert.equal(replay.json().operation.replayed,true);assert.equal(replay.json().view.item.status,'approved');
  assert.equal((await system.app.inject({method:'POST',url:root+'career/resume-versions/from-upload',headers:{...a.headers,origin:'https://evil.invalid'},payload:command})).statusCode,403);
  assert.equal((await system.app.inject({url:root+'career/resume-uploads?after='+id,headers:other.headers})).statusCode,404);
  assert.equal(calls,0);
 }finally{const {LocalBlobStorage}=await import('../src/storage.ts');await new LocalBlobStorage(readConfig().storageDir).delete(key);}
});

test('real authenticated HTTP diff uses strict revision query, no-store private history and cannot approve or read another owner',async()=>{
 const a=await actor(),b=await actor(),created=await system.app.inject({method:'POST',url:root+'career/resume-versions',headers:a.headers,payload:create()}),v=parseResumeReviewView(created.json().view),base=root+'pending-items/'+v.item.id;
 const edit=await system.app.inject({method:'POST',url:base+'/revisions',headers:a.headers,payload:{operationId:randomUUID(),expectedRevision:1,payloadDigest:v.item.payloadDigest,label:'Fictional changed',text:'Fictional revised personal contribution.'}});assert.equal(edit.statusCode,200,edit.body);
 const response=await system.app.inject({url:base+'/diff?from=1&to=2',headers:a.headers});assert.equal(response.statusCode,200,response.body);assert.equal(response.headers['cache-control'],'private, no-store');assert.equal(response.json().ownerId,a.id);assert.equal(response.json().to.payloadDigest,edit.json().view.item.payloadDigest);
 assert.equal((await system.app.inject({url:base,headers:a.headers})).json().item.status,'pending');assert.equal((await system.app.inject({url:base+'/diff?from=1&to=2',headers:b.headers})).statusCode,404);assert.equal((await system.app.inject({url:base+'/diff?from=1&to=2'})).statusCode,401);
 for(const query of ['from=1&to=2&ownerId='+a.id,'from=1&from=2&to=2','from=1&to=1','from=0&to=2','from=1.0&to=2','from=1','from=1&to=2147483648'])assert.equal((await system.app.inject({url:base+'/diff?'+query,headers:a.headers})).statusCode,400);
 assert.equal(calls,0);
});
