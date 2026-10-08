import { test } from 'node:test';import assert from 'node:assert/strict';import { randomUUID } from 'node:crypto';import type { BoundPlatformClient } from '../src/api.ts';
import { uploadOriginalResumeFile,readOwnedResumeUploads,readResumeReviews,readResumeReview,changeResumeReview,observeResumeIntent,resumePayloadDigest,type PendingResumeIntent } from '../src/resume-review-api.ts';
const owner=randomUUID(),id=randomUUID(),resumeId=randomUUID(),at='2026-10-08T00:00:00.000Z';
const payload={text:'Fictional original body.',claims:[],source_refs:[{kind:'owner_resume_input',id,revision:1}]} as any;
async function view(patch:Record<string,unknown>={}){return {item:{id,ownerId:owner,resumeVersionId:resumeId,kind:'resume_version',finalAction:'none',draftedBy:null,title:'简历版本',label:'Fictional raw',track:'da',sequence:1,source:'paste',uploadId:null,derivedFrom:null,status:'pending',resumeStatus:'draft',revision:1,generation:1,payloadDigest:await resumePayloadDigest(payload),sensitivity:'sensitive',approvedRevision:null,approvedDigest:null,approvedAt:null,approvedChannel:null,approvalOperationId:null,supersededBy:null,expiresAt:'2026-10-15T00:00:00.000Z',createdAt:at,updatedAt:at,lastOperationId:randomUUID(),...patch},payload};}
function client(run:(path:string,init:RequestInit)=>unknown):BoundPlatformClient{return {account:{accountId:owner,generation:1},isCurrent:()=>true,subscribe:()=>()=>{},request:async(path,init={})=>await run(path,init)} as BoundPlatformClient;}
test('owner-bound review details recompute the whole payload digest and refuse foreign or altered body/metadata',async()=>{
 const v=await view();assert.equal((await readResumeReview(client(()=>v),id)).payload.text,payload.text);
 for(const response of [{...v,payload:{...payload,text:'Fictional substituted body.'}},await view({ownerId:randomUUID()}),await view({approvedAt:at}),{...v,item:{...v.item,finalAction:'user_sends'}}])await assert.rejects(readResumeReview(client(()=>response),id));
});
test('list codec is body-free and refuses duplicate owners, raw payload injection and false pagination',async()=>{
 const v=await view();assert.equal((await readResumeReviews(client(()=>({items:[v.item],nextAfter:null})))).items.length,1);
 for(const response of [{items:[v.item,v.item],nextAfter:null},{items:[v.item],nextAfter:id},{items:[{...v.item,payload}],nextAfter:null},{items:[{...v.item,ownerId:randomUUID()}],nextAfter:null}])await assert.rejects(readResumeReviews(client(()=>response)));
});
test('a new create acknowledgement cannot fabricate confirmation or change the original body, direction or author',async()=>{
 const operationId=randomUUID(),body={operationId,expectedRevision:0,track:'da',label:'Fictional raw',text:payload.text} as const,intent:PendingResumeIntent={action:'create',itemId:null,body};
 const v=await view({lastOperationId:operationId}),operation={id:operationId,itemId:id,replayed:false};assert.equal((await changeResumeReview(client(()=>({view:v,operation})),intent)).view!.item.id,id);
 for(const patch of [{label:'Unexpected label'},{track:'swe'},{draftedBy:'guide'},{status:'approved',resumeStatus:'active',approvedAt:at,approvedRevision:1,approvedDigest:v.item.payloadDigest,approvedChannel:'web',approvalOperationId:operationId}])await assert.rejects(changeResumeReview(client(()=>({view:{...v,item:{...v.item,...patch}},operation})),intent));
 let reached=false;await assert.rejects(changeResumeReview(client(()=>{reached=true;return {};}),{...intent,body:{...body,source:'model'} as any}));assert.equal(reached,false);
});
test('approval uses the real version and digest tuple, observes only the originating operation and never equates removed content with an active original',async()=>{
 const operationId=randomUUID(),base=await view(),intent:PendingResumeIntent={action:'approve',itemId:id,body:{operationId,expectedRevision:1,payloadDigest:base.item.payloadDigest}},operation={id:operationId,itemId:id,replayed:false};
 const approved=await view({lastOperationId:operationId,generation:2,status:'approved',resumeStatus:'active',approvedRevision:1,approvedDigest:base.item.payloadDigest,approvedAt:at,approvedChannel:'web',approvalOperationId:operationId});
 let sent:any;const result=await changeResumeReview(client((path,init)=>{assert.equal(path,'/pending-items/'+id+'/decision');sent=JSON.parse(init.body as string);return {view:approved,operation};}),intent);assert.equal(result.view!.item.status,'approved');assert.deepEqual(sent,{operationId,revision:1,payloadDigest:base.item.payloadDigest,decision:'approve'});
 await assert.rejects(observeResumeIntent(client(()=>({view:approved,operation:{...operation,action:'create',replayed:true}})),intent));
 assert.equal((await observeResumeIntent(client(()=>({view:null,operation:{...operation,action:'approve',replayed:true}})),intent)).view,null);
});

test('uploaded originals bind genuine file coordinates and a recomputed body digest; no forged upload acknowledgement becomes confirmation',async()=>{
 const operationId=randomUUID(),uploadId=randomUUID(),sha256='1'.repeat(64),storageVersion='"fictional-stable-version"';
 const body={operationId,expectedRevision:0,track:'da',label:'Fictional raw',uploadId,sha256} as const,intent:PendingResumeIntent={action:'create',itemId:null,source:'upload',body};
 const uploadPayload={...payload,source_refs:[...payload.source_refs,{kind:'resume_upload',id:uploadId,sha256,storageVersion}]};
 const base=await view({source:'upload',uploadId,uploadSource:{uploadId,storageVersion,byteSize:100,sha256,textSha256:'2'.repeat(64),parser:'utf8',engineVersion:'24.21.0'},lastOperationId:operationId,payloadDigest:await resumePayloadDigest(uploadPayload)}),v={...base,payload:uploadPayload},operation={id:operationId,itemId:id,replayed:false};
 const saved=await changeResumeReview(client((path,init)=>{assert.equal(path,'/career/resume-versions/from-upload');assert.deepEqual(JSON.parse(init.body as string),body);return {view:v,operation};}),intent);assert.equal(saved.view!.item.status,'pending');
 for(const response of [{view:{...v,item:{...v.item,uploadId:randomUUID()}},operation},{view:{...v,payload:{...v.payload,text:'Fictional tampered extraction.'}},operation},{view:{...v,item:{...v.item,uploadSource:{...v.item.uploadSource,sha256:'3'.repeat(64)}}},operation}])await assert.rejects(changeResumeReview(client(()=>response),intent));
 let sent=false;await assert.rejects(changeResumeReview(client(()=>{sent=true;return {}; }),{...intent,body:{...body,text:'Forged extraction.'} as any}));assert.equal(sent,false);
 assert.equal((await observeResumeIntent(client(()=>({view:null,operation:{...operation,action:'create',replayed:true}})),intent)).view,null);
});
test('owner file-list rejects sparse arrays, accessors, hidden fields, storage coordinates and false cursors',async()=>{
 const file={id:randomUUID(),name:'fictional.txt',mime:'text/plain',size:100,createdAt:at};assert.equal((await readOwnedResumeUploads(client(()=>({files:[file],nextAfter:null})))).files[0].id,file.id);
 let getter=false;const accessor=[];Object.defineProperty(accessor,'0',{get(){getter=true;return file;},enumerable:true});
 for(const response of [{files:new Array(1),nextAfter:null},{files:accessor,nextAfter:null},{files:[{...file,key:'private-storage-key'}],nextAfter:null},{files:[file,file],nextAfter:null},{files:[file],nextAfter:file.id}])await assert.rejects(readOwnedResumeUploads(client(()=>response)));assert.equal(getter,false);
});
test('file upload hashes the actual selected bytes, sends genuine multipart and preserves unknown network outcome',async()=>{
 const file=new File(['Fictional course project.'],'fictional.txt',{type:'text/plain'}),uploadId=randomUUID();let requestCount=0;
 const result=await uploadOriginalResumeFile(client((path,init)=>{requestCount++;assert.equal(path,'/uploads');assert(init.body instanceof FormData);const chosen=init.body.get('file');assert(chosen instanceof File);assert.equal(chosen.name,file.name);assert.equal(chosen.size,file.size);return {attachment:{id:uploadId,name:file.name,mime:file.type,size:file.size,url:'/api/platform/uploads/'+uploadId}};}),file);
 const expected=await crypto.subtle.digest('SHA-256',await file.arrayBuffer());assert.equal(result.sha256,[...new Uint8Array(expected)].map(v=>v.toString(16).padStart(2,'0')).join(''));assert.equal(requestCount,1);
 const networkError=new TypeError('Fictional connection lost');await assert.rejects(uploadOriginalResumeFile(client(()=>{throw networkError;}),file),e=>e===networkError);
 let reached=false;const broken=new File(['Fictional'],'fictional.txt');broken.arrayBuffer=async()=>{throw Error('fictional local read error');};await assert.rejects(uploadOriginalResumeFile(client(()=>{reached=true;return {};}),broken),e=>(e as any).status===400);assert.equal(reached,false);
 const c=new AbortController();c.abort();await assert.rejects(uploadOriginalResumeFile(client(()=>{reached=true;return {};}),file,c.signal));assert.equal(reached,false);
});
