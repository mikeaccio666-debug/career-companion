import type {PoolClient} from 'pg';
import {careerRecordId as id,careerRecordObject as object,careerLibraryTime as time} from '@companion/platform-contracts';
import {authorizeFixedSession,type FixedSessionContext} from './auth.ts';
import {parseGoalPlanInput} from './goal-plans.ts';
import {goalPlanHash,planRevision,planStepIndex} from './goal-plan-core.ts';
import {parseJob} from './jobs.ts';
import {ApiError} from './errors.ts';

export const PLAN_EXPORT_TABLES=Object.freeze(['platform_goal_plans','platform_goal_plan_revisions','platform_goal_plan_steps','platform_goal_plan_proposals'] as const);
export type PlanExportSection='goalPlans'|'goalPlanRevisions'|'goalPlanSteps'|'goalPlanProposals';
type Row=Record<string,any>;
const unavailable=()=>new ApiError(503,'ACCOUNT_PLAN_EXPORT_UNAVAILABLE','The saved plan history could not be confirmed.');
function at(value:unknown,nullable=false){if(value===null&&nullable)return null;if(!(value instanceof Date)||!Number.isFinite(value.getTime()))throw unavailable();return value.toISOString();}
function integer(value:unknown,max=2147483647,min=0):number{if(!Number.isSafeInteger(value)||Number(value)<min||Number(value)>max)throw unavailable();return Number(value);}
function choice(value:unknown,values:string[]):string{if(typeof value!=='string'||!values.includes(value))throw unavailable();return value;}
function text(value:unknown,max:number):string{if(typeof value!=='string'||!value.length||value.length>max)throw unavailable();return value;}
function hash(value:unknown):string{if(typeof value!=='string'||!/^[a-f0-9]{64}$/.test(value))throw unavailable();return value;}
function receipt(value:unknown):Row|null{
 if(value===null)return null;
 if((value as Row)?.kind==='agent_turn'){
  const r=object(value,['kind','messageId','completedAt']);return {kind:'agent_turn',messageId:id(r.messageId),completedAt:time(r.completedAt)};
 }
 const r=object(value,['kind','jobId','generation','artifactIds','completedAt']);if(r.kind!=='task'||!Array.isArray(r.artifactIds)||r.artifactIds.length>64)throw unavailable();
 const artifactIds=r.artifactIds.map(id);if(new Set(artifactIds).size!==artifactIds.length)throw unavailable();
 return {kind:'task',jobId:id(r.jobId),generation:integer(r.generation,2147483647,1),artifactIds,completedAt:time(r.completedAt)};
}
function source(value:unknown,stepIndex:number):Row{
 const kind=(value as Row)?.source,base=['source','fromStep','sha256','byteSize'];
 const fields=kind==='analysis_text'?['mode','messageId']:kind==='artifact_text'?['mode','artifactIndex','jobId','generation','artifactId','mime']:
  kind==='reference_image'?['imageIndex','jobId','generation','artifactId','attachmentId','mime']:kind==='artifact_file'?['artifactIndex','jobId','generation','artifactId','attachmentId','name','mime']:null;
 if(!fields)throw unavailable();const r=object(value,[...base,...fields]);
 const out:Row={source:kind,fromStep:integer(r.fromStep,stepIndex-1),sha256:hash(r.sha256),byteSize:integer(r.byteSize,20*1024*1024)};
 if(kind==='analysis_text')return {...out,mode:choice(r.mode,['append','replace']),messageId:id(r.messageId)};
 Object.assign(out,{jobId:id(r.jobId),generation:integer(r.generation,2147483647,1),artifactId:id(r.artifactId),mime:text(r.mime,150)});
 if(kind==='artifact_text')Object.assign(out,{mode:choice(r.mode,['append','replace']),artifactIndex:integer(r.artifactIndex,63)});
 else Object.assign(out,{attachmentId:id(r.attachmentId),...(kind==='reference_image'?{imageIndex:integer(r.imageIndex,63)}:{artifactIndex:integer(r.artifactIndex,63),name:text(r.name,200)})});
 return out;
}
/** Original legacy plan history, not daily three-task scheduling. Do not call
 * GoalPlans.get/list: they hide old revisions and derive live execution states.
 * No plan confirmation, current provider/grant checks, recovery or file reads. */
export async function* exportPlansInTransaction(client:PoolClient,value:FixedSessionContext,signal?:AbortSignal):AsyncGenerator<{section:PlanExportSection;record:unknown}>{
 const v=object(value,['userId','tokenHash']),who={userId:id(v.userId),tokenHash:hash(v.tokenHash)};
 await authorizeFixedSession(client,who,signal);
 try{
  const plans=new Map<string,{conversation:string;revision:number}>();let after:string|null=null;
  async function reference(kind:'job'|'message'|'artifact'|'upload',key:string,conversation:string,jobId?:string){
   signal?.throwIfAborted();id(key);
   const sql=kind==='message'?'SELECT m.id,m.conversation_id,c.user_id FROM platform_messages m JOIN platform_conversations c ON c.id=m.conversation_id WHERE m.id=$1':
    kind==='artifact'?'SELECT a.id,a.user_id,a.job_id,a.upload_id,u.user_id AS upload_owner FROM platform_artifacts a LEFT JOIN platform_uploads u ON u.id=a.upload_id WHERE a.id=$1':
    kind==='job'?'SELECT id,user_id FROM platform_jobs WHERE id=$1':'SELECT id,user_id FROM platform_uploads WHERE id=$1';
   const row=(await client.query(sql,[key])).rows[0];
   if(row&&kind==='artifact'&&row.upload_id!==null&&row.upload_owner!==who.userId)throw unavailable();
   if(row&&(row.user_id!==who.userId||kind==='message'&&row.conversation_id!==conversation||kind==='artifact'&&jobId!==undefined&&row.job_id!==jobId))throw unavailable();
   return {id:key,availability:row?'metadata_present':'not_found',...(kind==='artifact'&&row?{uploadId:row.upload_id}: {})};
  }
  for(;;){
   signal?.throwIfAborted();const rows:Row[]=(await client.query(`SELECT p.id,p.user_id,p.conversation_id,p.revision,p.status,p.created_at,p.updated_at,c.user_id AS conversation_owner
    FROM platform_goal_plans p LEFT JOIN platform_conversations c ON c.id=p.conversation_id
    WHERE p.user_id=$1 AND ($2::uuid IS NULL OR p.id>$2) ORDER BY p.id LIMIT 100`,[who.userId,after])).rows;
   for(const p of rows){
    signal?.throwIfAborted();if(p.user_id!==who.userId||p.conversation_owner!==who.userId)throw unavailable();
    const key=id(p.id),conversation=id(p.conversation_id),current=planRevision(p.revision),status=choice(p.status,['draft','active','paused','cancelled']);plans.set(key,{conversation,revision:current});
    yield {section:'goalPlans',record:{id:key,ownerId:who.userId,conversationId:conversation,currentRevision:current,storedStatus:status,createdAt:at(p.created_at),updatedAt:at(p.updated_at)}};
    let previous=0;
    for(;;){
     signal?.throwIfAborted();const revisions:Row[]=(await client.query(`SELECT plan_id,revision,title,goal,definition_hash,confirmed_at,created_at FROM platform_goal_plan_revisions
      WHERE plan_id=$1 AND revision>$2 ORDER BY revision LIMIT 100`,[key,previous])).rows;
     for(const r of revisions){
      signal?.throwIfAborted();if(r.plan_id!==key||r.revision!==previous+1||r.revision>current)throw unavailable();
      const steps:Row[]=(await client.query(`SELECT plan_id,revision,step_index,input,input_hash,job_id,job_generation,message_id,bound_at,receipt,resolved_task,input_sources
       FROM platform_goal_plan_steps WHERE plan_id=$1 AND revision=$2 ORDER BY step_index`,[key,r.revision])).rows;
      const original={title:r.title,goal:r.goal,steps:steps.map(s=>s.input)},parsed=parseGoalPlanInput(original);
      if(goalPlanHash(parsed)!==goalPlanHash(original)||goalPlanHash(original)!==hash(r.definition_hash))throw unavailable();
      if(r.revision===current&&['active','paused'].includes(status)&&r.confirmed_at===null)throw unavailable();
      yield {section:'goalPlanRevisions',record:{ownerId:who.userId,planId:key,revision:r.revision,title:r.title,goal:r.goal,confirmedAt:at(r.confirmed_at,true),createdAt:at(r.created_at)}};
      for(const [index,s] of steps.entries()){
       signal?.throwIfAborted();if(s.plan_id!==key||s.revision!==r.revision||planStepIndex(s.step_index)!==index||goalPlanHash(s.input)!==hash(s.input_hash))throw unavailable();
       const saved=receipt(s.receipt),jobId=s.job_id===null?null:id(s.job_id),messageId=s.message_id===null?null:id(s.message_id),generation=s.job_generation===null?null:integer(s.job_generation,2147483647,1),boundAt=at(s.bound_at,true);
       if(jobId&&messageId||jobId&&generation===null||(jobId||messageId||saved)&&!boundAt||(s.resolved_task===null)!==(s.input_sources===null))throw unavailable();
       if(s.input.kind==='agent_turn'&&(jobId||generation!==null||s.resolved_task!==null||saved&&saved.kind!=='agent_turn')||s.input.kind==='task'&&(messageId||saved&&saved.kind!=='task'))throw unavailable();
       const references:Row[]=[];
       if(jobId)references.push({kind:'job',...await reference('job',jobId,conversation)});
       if(messageId)references.push({kind:'message',...await reference('message',messageId,conversation)});
       if(saved?.kind==='task'){
        if(jobId!==null&&saved.jobId!==jobId||saved.generation!==generation)throw unavailable();
        references.push({kind:'receipt_job',...await reference('job',saved.jobId,conversation)});
        for(const artifact of saved.artifactIds){const found=await reference('artifact',artifact,conversation,saved.jobId);references.push({kind:'receipt_artifact',...found});}
       }else if(saved){if(messageId!==null&&saved.messageId!==messageId)throw unavailable();references.push({kind:'receipt_message',...await reference('message',saved.messageId,conversation)});}
       let resolvedTask=null,inputSources:Row[]|null=null;
       if(s.resolved_task!==null){
        resolvedTask=parseJob(s.resolved_task);if(goalPlanHash(resolvedTask)!==goalPlanHash(s.resolved_task)||resolvedTask.kind!==s.input.task.kind||!Array.isArray(s.input_sources)||s.input_sources.length>9||!boundAt)throw unavailable();
        inputSources=s.input_sources.map((v:unknown)=>source(v,index));
        for(const item of inputSources){
         const prior=steps[item.fromStep],priorReceipt=receipt(prior.receipt);if(!priorReceipt)throw unavailable();
         if(item.source==='analysis_text'){
          if(priorReceipt.kind!=='agent_turn'||item.messageId!==priorReceipt.messageId)throw unavailable();
          references.push({kind:'source_message',...await reference('message',item.messageId,conversation)});
         }else{
          if(priorReceipt.kind!=='task'||item.jobId!==priorReceipt.jobId||item.generation!==priorReceipt.generation||!priorReceipt.artifactIds.includes(item.artifactId))throw unavailable();
          references.push({kind:'source_job',...await reference('job',item.jobId,conversation)});
          const artifact=await reference('artifact',item.artifactId,conversation,item.jobId);references.push({kind:'source_artifact',...artifact});
          if(item.attachmentId){if(artifact.availability==='metadata_present'&&artifact.uploadId!==item.attachmentId)throw unavailable();references.push({kind:'source_upload',...await reference('upload',item.attachmentId,conversation)});}
         }
        }
       }
       // Inputs are the original saved user definition/resolved prompt. Provider
       // configuration, job execution_policy and approval credentials are never read.
       yield {section:'goalPlanSteps',record:{ownerId:who.userId,planId:key,revision:r.revision,index,input:s.input,provenance:'saved_plan_definition',jobId,generation,messageId,boundAt,receipt:saved,resolvedTask,inputSources,references}};
      }
      previous=r.revision;
     }
     if(revisions.length<100)break;
    }
    if(previous!==current)throw unavailable();
   }
   if(rows.length<100)break;after=id(rows.at(-1)!.id);
  }
  after=null;
  for(;;){
   signal?.throwIfAborted();const rows:Row[]=(await client.query(`SELECT plan_id,user_id,conversation_id,message_id,created_at FROM platform_goal_plan_proposals
    WHERE user_id=$1 AND ($2::uuid IS NULL OR plan_id>$2) ORDER BY plan_id LIMIT 100`,[who.userId,after])).rows;
   for(const r of rows){const p=plans.get(id(r.plan_id));if(r.user_id!==who.userId||!p||p.conversation!==r.conversation_id)throw unavailable();
    const message=r.message_id===null?null:await reference('message',id(r.message_id),p.conversation);
    yield {section:'goalPlanProposals',record:{ownerId:who.userId,planId:r.plan_id,conversationId:r.conversation_id,message,createdAt:at(r.created_at)}};
   }
   if(rows.length<100)break;after=id(rows.at(-1)!.plan_id);
  }
 }catch{signal?.throwIfAborted();throw unavailable();}
 await authorizeFixedSession(client,who,signal);signal?.throwIfAborted();
}
