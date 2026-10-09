import { test } from 'node:test';import assert from 'node:assert/strict';import { randomUUID } from 'node:crypto';import { careerLibrarySummary } from '@companion/platform-contracts';
import type { BoundPlatformClient } from '../src/api.ts';import { readCareerLibrary,readCareerLibraryRecord,readCareerProjectChoices,changeCareerLibrary } from '../src/career-story-api.ts';
const owner=randomUUID(),id=randomUUID(),at='2026-10-08T00:00:00.000Z',star={situation:'Fictional situation',task:'Fictional task',action:'Fictional action',result:'Fictional result'};
const command=(op=randomUUID())=>({operationId:op,expectedRevision:0,title:'Fictional story',experienceKind:'course_project',sensitivity:'normal',english:star,chinese:{situation:'',task:'',action:'',result:''},tags:['ownership'],projects:[]});
function state(patch:Record<string,unknown>={}){const {operationId,expectedRevision,...fields}=command();return {...fields,id,ownerId:owner,source:'user_entered',revision:1,createdAt:at,updatedAt:at,lastOperationId:operationId,confirmedAt:null,confirmedRevision:null,status:'draft',...patch} as any;}
function client(run:(path:string,init:RequestInit)=>unknown):BoundPlatformClient{return {account:{accountId:owner,generation:1},isCurrent:()=>true,subscribe:()=>()=>{},request:async(path,init={})=>await run(path,init)} as BoundPlatformClient;}
test('owner-bound story summaries reject foreign/duplicate records and misleading page continuation without raw STAR leakage',async()=>{
 const summary=careerLibrarySummary('story',state()),v={record:summary,evidenceAvailability:'current'};const result=await readCareerLibrary(client(()=>({records:[v],nextAfter:null})),'story');assert(Object.isFrozen(result.records));assert(!('english' in result.records[0].record));
 for(const response of [{records:[{record:careerLibrarySummary('story',state({ownerId:randomUUID()})),evidenceAvailability:'current'}],nextAfter:null},{records:[v,v],nextAfter:null},{records:[v],nextAfter:id}])await assert.rejects(readCareerLibrary(client(()=>response),'story'));
});
test('stable owner acknowledgements cannot change title/body/experience labels, invent a confirmed create, or fabricate a review',async()=>{
 const body=command(),op={id:body.operationId,recordId:id,recordKind:'story',appliedRevision:1,replayed:false},record=state({lastOperationId:body.operationId});assert.equal((await changeCareerLibrary(client(()=>({record,evidenceAvailability:'current',operation:op})),'story','create',null,body)).record!.id,id);
 for(const patch of [{ownerId:randomUUID()},{title:'Fictional changed title'},{experienceKind:'employment'},{english:{...star,action:'Fictional unrequested action'}},{status:'confirmed',confirmedAt:at,confirmedRevision:1}])await assert.rejects(changeCareerLibrary(client(()=>({record:state({...record,...patch}),evidenceAvailability:'current',operation:op})),'story','create',null,body));
 let reached=false;await assert.rejects(changeCareerLibrary(client(()=>{reached=true;return {};}),'story','create',null,{...body,status:'confirmed'}));assert.equal(reached,false);
});
test('real confirmation acknowledgement binds current revision, and a replay can return a physically removed story without resurrection',async()=>{
 const operationId=randomUUID(),command={operationId,expectedRevision:1},op={id:operationId,recordId:id,recordKind:'story',appliedRevision:2,replayed:false},record=state({revision:2,lastOperationId:operationId,status:'confirmed',confirmedAt:at,confirmedRevision:2});
 assert.equal((await changeCareerLibrary(client(()=>({record,evidenceAvailability:'current',operation:op})),'story','confirm',id,command)).record!.confirmedRevision,2);await assert.rejects(changeCareerLibrary(client(()=>({record:state({revision:2,lastOperationId:operationId}),evidenceAvailability:'current',operation:op})),'story','confirm',id,command));
 assert.equal((await changeCareerLibrary(client(()=>({record:null,evidenceAvailability:null,operation:{...op,replayed:true}})),'story','confirm',id,command)).record,null);await assert.rejects(readCareerLibraryRecord(client(()=>({record:state(),evidenceAvailability:'fake_ready'})),'story',id));
});
test('project choice lookup follows actual owner pagination and rejects repeated IDs or manufactured mentor review',async()=>{
 const project=(id:string)=>({id,ownerId:owner,revision:1,createdAt:at,updatedAt:at,lastOperationId:randomUUID(),source:'user_entered',confirmedAt:null,confirmedRevision:null,title:'Fictional project',experienceKind:'course_project',sensitivity:'normal',kind:'project',subjectId:id,referenceId:'career-project:'+id+':1',occurredAt:at,state:'active',verification:'self_reported'});
 const first=Array.from({length:50},()=>project(randomUUID())),second=project(randomUUID()),cursor=first.at(-1)!.id;const c=client(path=>({records:(path.endsWith(cursor)?[second]:first).map(p=>({record:p,evidenceAvailability:null})),nextAfter:path.endsWith(cursor)?null:cursor}));assert.equal((await readCareerProjectChoices(c)).length,51);
 await assert.rejects(readCareerProjectChoices(client(()=>({records:[{record:{...second,verification:'mentor_reviewed'},evidenceAvailability:null}],nextAfter:null}))));
});

test('read-only recovery sends no command body and binds original kind, operation and revision',async()=>{
 const body=command(),operation={id:body.operationId,recordId:id,recordKind:'story',appliedRevision:1,replayed:true},record=state({revision:2,lastOperationId:randomUUID()});
 const response={record,evidenceAvailability:'current',operation};let requests=0;
 const c=client((route,init)=>{requests++;assert.equal(route,'/career/stories/operations/'+body.operationId);assert.equal(init.method,undefined);assert.equal(init.body,undefined);assert.equal(init.cache,'no-store');return response;});
 assert.equal((await changeCareerLibrary(c,'story','create',null,body,undefined,true)).record!.revision,2);assert.equal(requests,1);
 for(const patch of [{replayed:false},{recordKind:'project'},{id:randomUUID()},{appliedRevision:2}])await assert.rejects(changeCareerLibrary(client(()=>({...response,operation:{...operation,...patch}})),'story','create',null,body,undefined,true));
 assert.equal((await changeCareerLibrary(client(()=>({...response,record:null,evidenceAvailability:null})),'story','create',null,body,undefined,true)).record,null);
 await assert.rejects(changeCareerLibrary(client(()=>({...response,record:state({revision:1,lastOperationId:randomUUID()})})),'story','create',null,body,undefined,true));
});
test('empty list and removed-operation results are rejected after account invalidation',async()=>{
 const body=command(),response={record:null,evidenceAvailability:null,operation:{id:body.operationId,recordId:id,recordKind:'story',appliedRevision:1,replayed:true}};
 for(const [reply,run] of [[{records:[],nextAfter:null},(c:BoundPlatformClient)=>readCareerLibrary(c,'story')],[response,(c:BoundPlatformClient)=>changeCareerLibrary(c,'story','create',null,body,undefined,true)]] as const){
  let live=true;const c=client(()=>{live=false;return reply;});c.isCurrent=()=>live;
  await assert.rejects(run(c));
 }
 let requested=false;const stale=client(()=>{requested=true;return {};});stale.isCurrent=()=>false;
 await assert.rejects(readCareerLibrary(stale,'story'));await assert.rejects(readCareerLibraryRecord(stale,'story',id));assert.equal(requested,false);
});
