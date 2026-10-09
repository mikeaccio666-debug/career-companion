import type {PoolClient} from 'pg';
import {careerRecordId as id,careerRecordObject as object} from '@companion/platform-contracts';
import {browserDefinitionHash,parseBrowserTaskOptions,workflowDefinitionHash} from '@companion/ai-core';
import {authorizeFixedSession,type FixedSessionContext} from './auth.ts';
import {parseWorkflowTemplate} from './workflow-templates.ts';
import {ApiError} from './errors.ts';
export const EXECUTION_EXPORT_TABLES=Object.freeze(['platform_workflow_templates','platform_workflow_checkpoints','platform_workflow_step_ledger','platform_browser_checkpoints','platform_browser_action_ledger'] as const);
export type ExecutionExportSection='workflowTemplates'|'workflowCheckpoints'|'workflowStepEvents'|'browserCheckpoints'|'browserActionEvents';
type Row=Record<string,any>;
const unavailable=()=>new ApiError(503,'ACCOUNT_EXECUTION_EXPORT_UNAVAILABLE','The saved execution history could not be confirmed.');
function integer(v:any,min=0,max=2147483647):number{if(!Number.isSafeInteger(v)||v<min||v>max)throw unavailable();return v;}
function hash(v:any):string{if(typeof v!=='string'||!/^[a-f0-9]{64}$/.test(v))throw unavailable();return v;}
function choice(v:any,allowed:readonly string[]):string{if(typeof v!=='string'||!allowed.includes(v))throw unavailable();return v;}
function at(v:any,nullable=false){if(v===null&&nullable)return null;if(!(v instanceof Date)||!Number.isFinite(v.getTime()))throw unavailable();return v.toISOString();}
function text(v:any,max:number){if(typeof v!=='string'||Buffer.byteLength(v)>max)throw unavailable();return v;}
function serial(v:any){if(typeof v!=='string'||! /^[1-9][0-9]*$/.test(v)||BigInt(v)>9223372036854775807n)throw unavailable();return v;}
/** Read saved execution facts; no resume decisions, live capabilities, leases,
 * storage reads or browser/model execution. SQL history is not an AEAD proof. */
export async function* exportExecutionInTransaction(c:PoolClient,value:FixedSessionContext,signal?:AbortSignal):AsyncGenerator<{section:ExecutionExportSection;record:unknown}>{
 const v=object(value,['userId','tokenHash']),who=Object.freeze({userId:id(v.userId),tokenHash:hash(v.tokenHash)});await authorizeFixedSession(c,who,signal);
 try{
  async function* pages(sql:string,numeric=false){let after:string|null=null;for(;;){signal?.throwIfAborted();const rows:Row[]=(await c.query(sql,[who.userId,after])).rows;for(const row of rows){signal?.throwIfAborted();yield row;}if(rows.length<100)break;after=numeric?serial(rows.at(-1)!.id):id(rows.at(-1)!.id);}}
  for await(const r of pages(`SELECT id,user_id,name,description,steps,revision,created_at,updated_at,deleted_at FROM platform_workflow_templates
   WHERE user_id=$1 AND ($2::uuid IS NULL OR id>$2) ORDER BY id LIMIT 100`)){
   if(r.user_id!==who.userId)throw unavailable();parseWorkflowTemplate(structuredClone({name:r.name,description:r.description,steps:r.steps}));
   yield {section:'workflowTemplates',record:{id:id(r.id),ownerId:who.userId,name:r.name,description:r.description,steps:r.steps,revision:integer(r.revision,1),createdAt:at(r.created_at),updatedAt:at(r.updated_at),deletedAt:at(r.deleted_at,true)}};
  }
  const workflows=new Map<string,{revision:number;generation:number;steps:Row[];seen:number;latest:Map<number,Row>;definition:string}>();
  for await(const r of pages(`SELECT w.job_id AS id,w.definition_hash,w.revision,w.steps,w.created_at,w.updated_at,j.user_id,j.kind,j.provider,j.prompt,j.options,j.generation FROM platform_workflow_checkpoints w
   JOIN platform_jobs j ON j.id=w.job_id WHERE j.user_id=$1 AND ($2::uuid IS NULL OR w.job_id>$2) ORDER BY w.job_id LIMIT 100`)){
   if(r.user_id!==who.userId||r.kind!=='workflow'||r.provider!=='workflow')throw unavailable();
   const definition=hash(r.definition_hash);if(workflowDefinitionHash({kind:r.kind,provider:r.provider,prompt:r.prompt,options:r.options})!==definition)throw unavailable();
   const plan=parseWorkflowTemplate(structuredClone({name:'Saved workflow',steps:r.options?.steps})).steps;
   if(!Array.isArray(r.steps)||r.steps.length>plan.length)throw unavailable();const steps:Row[]=[],rawSteps:Row[]=[];
   for(const [index,value] of r.steps.entries()){
    const s=object(value,['index','inputHash','state'],['providerTaskId','text','artifacts','errorCode']);if(integer(s.index,0,7)!==index)throw unavailable();hash(s.inputHash);
    const state=choice(s.state,['started','provider_task','completed','failed','uncertain']),hasProviderTask=s.providerTaskId!==undefined;
    if(hasProviderTask&&!text(s.providerTaskId,4096).length||state==='provider_task'&&!hasProviderTask||index<r.steps.length-1&&state!=='completed')throw unavailable();
    if(s.text!==undefined&&state!=='completed'||s.artifacts!==undefined&&state!=='completed'||s.errorCode!==undefined&&!['failed','uncertain'].includes(state))throw unavailable();
    const artifacts:Row[]=[];
    if(s.artifacts!==undefined){if(!Array.isArray(s.artifacts)||s.artifacts.length>8)throw unavailable();const ids=new Set<string>();
     for(const value of s.artifacts){const a=object(value,['attachmentId','name','mime','size']),key=id(a.attachmentId);if(ids.has(key))throw unavailable();ids.add(key);
      const name=text(a.name,800),mime=text(a.mime,150),size=integer(a.size,1,100*1024*1024),upload=(await c.query('SELECT id,user_id,filename,mime,byte_size FROM platform_uploads WHERE id=$1',[key])).rows[0];
      if(upload&&(upload.user_id!==who.userId||upload.filename!==name||upload.mime!==mime||Number(upload.byte_size)!==size))throw unavailable();
      const links:Row[]=(await c.query('SELECT id,user_id,job_id,metadata FROM platform_artifacts WHERE upload_id=$1',[key])).rows;
      for(const link of links)if(link.user_id!==who.userId||link.job_id!==r.id||link.metadata?.workflowStep!==index||link.metadata?.definitionHash!==definition)throw unavailable();
      artifacts.push({attachmentId:key,name,mime,size,availability:upload?'metadata_present':'not_found',artifactReferences:links.map(link=>id(link.id))});
     }
    }
    const errorCode=s.errorCode===undefined?undefined:text(s.errorCode,100);if(errorCode!==undefined&&!/^[A-Z][A-Z0-9_]*$/.test(errorCode))throw unavailable();
    rawSteps.push(s);steps.push({index,state,hasProviderTask,...(s.text===undefined?{}:{text:text(s.text,512*1024),textProvenance:'saved_generated_output'}),...(s.artifacts===undefined?{}:{artifacts}),...(errorCode===undefined?{}:{errorCode})});
   }
   const revision=integer(r.revision);if(revision===0&&steps.length||revision>0&&!steps.length)throw unavailable();workflows.set(id(r.id),{revision,generation:integer(r.generation,1),steps:rawSteps,seen:0,latest:new Map(),definition});
   yield {section:'workflowCheckpoints',record:{jobId:r.id,ownerId:who.userId,revision,steps,createdAt:at(r.created_at),updatedAt:at(r.updated_at)}};
  }
  for await(const r of pages(`SELECT l.id::text AS id,l.job_id,l.revision,l.generation,l.step_index,l.input_hash,l.event_type,l.provider_task_id,l.error_code,l.created_at
   FROM platform_workflow_step_ledger l JOIN platform_jobs j ON j.id=l.job_id WHERE j.user_id=$1 AND ($2::bigint IS NULL OR l.id>$2::bigint) ORDER BY l.id LIMIT 100`,true)){
   const p=workflows.get(id(r.job_id));if(!p||integer(r.revision,1)!==p.seen+1||r.revision>p.revision||integer(r.generation,1)>p.generation)throw unavailable();p.seen++;
   const index=integer(r.step_index,0,p.steps.length-1),type=choice(r.event_type,['started','provider_task','completed','failed','uncertain']);hash(r.input_hash);
   if(r.input_hash!==p.steps[index].inputHash||r.provider_task_id!==null&&!text(r.provider_task_id,4096).length||r.error_code!==null&&!/^[A-Z][A-Z0-9_]{0,99}$/.test(r.error_code))throw unavailable();
   p.latest.set(index,r);yield {section:'workflowStepEvents',record:{id:serial(r.id),ownerId:who.userId,jobId:r.job_id,revision:r.revision,generation:r.generation,stepIndex:index,eventType:type,hasProviderTask:r.provider_task_id!==null,errorCode:r.error_code,createdAt:at(r.created_at)}};
  }
  for(const p of workflows.values()){
   if(p.seen!==p.revision||p.latest.size!==p.steps.length)throw unavailable();for(const s of p.steps){const e=p.latest.get(s.index);if(!e||e.event_type!==s.state||(s.errorCode??null)!==e.error_code||e.event_type!=='started'&&(s.providerTaskId??null)!==e.provider_task_id)throw unavailable();}
  }
  const browsers=new Map<string,{revision:number;generation:number;total:number;next:number;state:string;seen:number;foldNext:number;foldState:string}>();
  for await(const r of pages(`SELECT b.job_id AS id,b.definition_hash,b.total_actions,b.revision,b.next_index,b.state,b.created_at,b.updated_at,j.user_id,j.kind,j.provider,j.prompt,j.options,j.generation FROM platform_browser_checkpoints b
   JOIN platform_jobs j ON j.id=b.job_id WHERE j.user_id=$1 AND ($2::uuid IS NULL OR b.job_id>$2) ORDER BY b.job_id LIMIT 100`)){
   if(r.user_id!==who.userId||r.kind!=='browser'||r.provider!=='browser')throw unavailable();if(browserDefinitionHash({kind:r.kind,provider:r.provider,prompt:r.prompt,options:r.options})!==hash(r.definition_hash))throw unavailable();
   const total=integer(r.total_actions,1,12);if(parseBrowserTaskOptions(r.options).actions?.length!==total)throw unavailable();const revision=integer(r.revision),next=integer(r.next_index,0,total),state=choice(r.state,['ready','started','completed','uncertain']);
   browsers.set(id(r.id),{revision,generation:integer(r.generation,1),total,next,state,seen:0,foldNext:0,foldState:'ready'});
   yield {section:'browserCheckpoints',record:{jobId:r.id,ownerId:who.userId,totalActions:total,revision,completedActions:next,state,createdAt:at(r.created_at),updatedAt:at(r.updated_at)}};
  }
  for await(const r of pages(`SELECT l.id::text AS id,l.job_id,l.revision,l.generation,l.action_index,l.event_type,l.created_at FROM platform_browser_action_ledger l
   JOIN platform_jobs j ON j.id=l.job_id WHERE j.user_id=$1 AND ($2::bigint IS NULL OR l.id>$2::bigint) ORDER BY l.id LIMIT 100`,true)){
   const p=browsers.get(id(r.job_id));if(!p||integer(r.revision,1)!==p.seen+1||r.revision>p.revision||integer(r.generation,1)>p.generation)throw unavailable();
   const index=integer(r.action_index,0,p.total-1),type=choice(r.event_type,['started','completed','uncertain']);
   if(type==='started'){if(p.foldState!=='ready'||index!==p.foldNext)throw unavailable();p.foldState='started';}
   else if(type==='completed'){if(p.foldState!=='started'||index!==p.foldNext)throw unavailable();p.foldNext++;p.foldState=p.foldNext===p.total?'completed':'ready';}
   else {if(p.seen===0||p.foldState==='uncertain'||index!==Math.min(p.total-1,p.foldState==='started'?p.foldNext:Math.max(0,p.foldNext-1)))throw unavailable();p.foldState='uncertain';}
   p.seen++;yield {section:'browserActionEvents',record:{id:serial(r.id),ownerId:who.userId,jobId:r.job_id,revision:r.revision,generation:r.generation,actionIndex:index,eventType:type,createdAt:at(r.created_at)}};
  }
  for(const p of browsers.values())if(p.seen!==p.revision||p.foldNext!==p.next||p.foldState!==p.state)throw unavailable();
  await authorizeFixedSession(c,who,signal);signal?.throwIfAborted();
 }catch{signal?.throwIfAborted();throw unavailable();}
}
