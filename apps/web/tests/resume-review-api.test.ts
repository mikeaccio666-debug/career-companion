import { test } from 'node:test';import assert from 'node:assert/strict';import { randomUUID } from 'node:crypto';import type { BoundPlatformClient } from '../src/api.ts';
import { readResumeReviews,readResumeReview,changeResumeReview,observeResumeIntent,resumePayloadDigest,type PendingResumeIntent } from '../src/resume-review-api.ts';
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
