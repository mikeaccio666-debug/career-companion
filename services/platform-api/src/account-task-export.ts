import {createHash} from 'node:crypto';
import type {PoolClient} from 'pg';
import {careerRecordId as id,careerRecordObject as object,CONVERSATION_TASK_TOOLS} from '@companion/platform-contracts';
import {authorizeFixedSession,type FixedSessionContext} from './auth.ts';
import {parseJob} from './jobs.ts';
import {parseJobOutcomeReviewInput} from './job-outcome-reviews.ts';
import {accountPlanSource} from './account-plan-export.ts';
import {ApiError} from './errors.ts';
export const TASK_EXPORT_TABLES=Object.freeze(['platform_jobs','platform_approvals','platform_job_attempts','platform_job_outbox','platform_conversation_tasks','platform_job_outcome_reviews'] as const);
export type TaskExportSection='jobs'|'jobApprovals'|'jobAttempts'|'jobDispatches'|'conversationTasks'|'jobOutcomeReviews';
type Row=Record<string,any>;
const unavailable=()=>new ApiError(503,'ACCOUNT_TASK_EXPORT_UNAVAILABLE','The saved task history could not be confirmed.');
const states=['needs_approval','queued','running','succeeded','failed','cancelled','uncertain'];
function integer(v:unknown,min=0,max=2147483647):number{if(!Number.isSafeInteger(v)||Number(v)<min||Number(v)>max)throw unavailable();return Number(v);}
function at(v:any){if(v===null)return null;if(!(v instanceof Date)||!Number.isFinite(v.getTime()))throw unavailable();return v.toISOString();}
function choice(v:any,allowed:readonly string[]){if(typeof v!=='string'||!allowed.includes(v))throw unavailable();return v;}
function hash(v:any){if(typeof v!=='string'||!/^[a-f0-9]{64}$/.test(v))throw unavailable();return v;}
function text(v:any,max=20000){if(typeof v!=='string'||v.length>max)throw unavailable();return v;}
const inputKeys=['kind','provider','prompt','model','options','attachmentIds','executionTemplate'];
/** Original saved tasks only. No queue, provider, current approval, recovery,
 * checkpoint evaluation or result fetching. A stored approval is historical. */
export async function* exportTasksInTransaction(c:PoolClient,value:FixedSessionContext,signal?:AbortSignal):AsyncGenerator<{section:TaskExportSection;record:unknown}>{
 const v=object(value,['userId','tokenHash']),who=Object.freeze({userId:id(v.userId),tokenHash:hash(v.tokenHash)});await authorizeFixedSession(c,who,signal);
 try{
  const jobs=new Map<string,{generation:number;kind:string}>();
  async function ref(kind:'upload'|'job'|'conversation'|'message'|'artifact'|'plan'|'connection',key:string,expected?:{conversation?:string;job?:string;upload?:string}){
   signal?.throwIfAborted();id(key);
   const sql=kind==='message'?'SELECT m.id,c.user_id,m.conversation_id FROM platform_messages m JOIN platform_conversations c ON c.id=m.conversation_id WHERE m.id=$1':
    kind==='artifact'?'SELECT a.id,a.user_id,a.job_id,a.upload_id,u.user_id AS upload_owner FROM platform_artifacts a LEFT JOIN platform_uploads u ON u.id=a.upload_id WHERE a.id=$1':
    `SELECT id,user_id${kind==='plan'?',conversation_id':''} FROM ${({upload:'platform_uploads',job:'platform_jobs',conversation:'platform_conversations',plan:'platform_goal_plans',connection:'platform_mcp_connections'} as Record<string,string>)[kind]} WHERE id=$1`;
   const r=(await c.query(sql,[key])).rows[0];
   if(r&&(r.user_id!==who.userId||expected?.conversation&&r.conversation_id!==expected.conversation||expected?.job&&r.job_id!==expected.job||expected?.upload&&r.upload_id!==expected.upload||kind==='artifact'&&r.upload_id!==null&&r.upload_owner!==who.userId))throw unavailable();
   return {id:key,availability:r?'metadata_present':'not_found',...(kind==='plan'&&r?{conversationId:r.conversation_id}:{})};
  }
  async function input(raw:Row){parseJob(raw);const references=[];for(const key of raw.attachmentIds??[])references.push(await ref('upload',key));return {definition:raw,attachments:references};}
  async function args(raw:unknown){
   const a=object(raw,['kind','provider','prompt'],['model','options','attachmentIds','executionTemplate','modelProvider','modelRelayLimits','workflowDefinitionHash','browserDefinitionHash','mcp','mcpDefinitionHash','goalPlanInput']);
   const task=Object.fromEntries(inputKeys.filter(k=>Object.hasOwn(a,k)).map(k=>[k,a[k]])),saved=await input(task),metadata:Row={};
   // Closed server-added metadata; never copy arbitrary execution policy or graph.
   for(const field of ['workflowDefinitionHash','browserDefinitionHash','mcpDefinitionHash'])if(a[field]!==undefined)hash(a[field]);
   if(a.modelProvider!==undefined)metadata.modelProvider=choice(a.modelProvider,['openai','ollama']);
   if(a.modelRelayLimits!==undefined){const r=object(a.modelRelayLimits,['model','maxRequests','maxTokens','dailyTokens','maxOutputTokens'],['provider','upstreamHash']);if(r.upstreamHash!==undefined)hash(r.upstreamHash);
    metadata.modelRelayLimits={model:text(r.model,150),...(r.provider===undefined?{}:{provider:choice(r.provider,['openai','ollama'])}),maxRequests:integer(r.maxRequests,1),maxTokens:integer(r.maxTokens,1),dailyTokens:integer(r.dailyTokens,1),maxOutputTokens:integer(r.maxOutputTokens,1)};
   }
   if(a.mcp!==undefined){const m=object(a.mcp,['connectionId','connectionName','catalogId','grantVersion','toolName','schemaHash']);
    metadata.mcp={connectionId:id(m.connectionId),connectionName:text(m.connectionName,200),catalogId:text(m.catalogId,150),grantVersion:integer(m.grantVersion,1),toolName:text(m.toolName,200),schemaHash:hash(m.schemaHash),connection:await ref('connection',id(m.connectionId))};
   }
   if(a.goalPlanInput!==undefined){const p=object(a.goalPlanInput,['planId','revision','stepIndex','templateHash','effectiveInputHash','inputSources']);hash(p.templateHash);hash(p.effectiveInputHash);
    if(!Array.isArray(p.inputSources)||p.inputSources.length>9)throw unavailable();const stepIndex=integer(p.stepIndex,0,7),plan=await ref('plan',id(p.planId)),sources=p.inputSources.map(s=>accountPlanSource(s,stepIndex)),references=[];
    for(const s of sources){if(s.messageId)references.push({kind:'message',...await ref('message',s.messageId,plan.conversationId?{conversation:plan.conversationId}:undefined)});
     if(s.jobId)references.push({kind:'job',...await ref('job',s.jobId)});if(s.artifactId)references.push({kind:'artifact',...await ref('artifact',s.artifactId,{job:s.jobId,...(s.attachmentId?{upload:s.attachmentId}:{})})});if(s.attachmentId)references.push({kind:'upload',...await ref('upload',s.attachmentId)});}
    metadata.goalPlanInput={plan,revision:integer(p.revision,1),stepIndex,inputSources:sources,references};
   }
   return {...saved,metadata,provenance:'saved_approval_request'};
  }
  async function* pages(sql:string){let after:string|null=null;for(;;){signal?.throwIfAborted();const rows:Row[]=(await c.query(sql,[who.userId,after])).rows;for(const row of rows){signal?.throwIfAborted();yield row;}if(rows.length<100)break;after=id(rows.at(-1)!.id);}}
  for await(const r of pages(`SELECT id,user_id,kind,provider,model,prompt,options,attachment_ids,status,requires_approval,generation,attempt_count,progress,
   (provider_task_id IS NOT NULL) AS has_provider_task,error_code,error_message,(lease_token IS NOT NULL OR lease_until IS NOT NULL) AS cleanup_pending,created_at,updated_at
   FROM platform_jobs WHERE user_id=$1 AND ($2::uuid IS NULL OR id>$2) ORDER BY id LIMIT 100`)){
   if(r.user_id!==who.userId||typeof r.requires_approval!=='boolean'||typeof r.cleanup_pending!=='boolean'||typeof r.has_provider_task!=='boolean')throw unavailable();
   const saved=await input({kind:r.kind,provider:r.provider,...(r.model===null?{}:{model:r.model}),prompt:r.prompt,options:r.options,...(r.kind==='mcp'?{}:{attachmentIds:r.attachment_ids})});
   if(r.kind==='mcp'&&(!Array.isArray(r.attachment_ids)||r.attachment_ids.length))throw unavailable();
   const key=id(r.id),generation=integer(r.generation,1);jobs.set(key,{generation,kind:r.kind});
   yield {section:'jobs',record:{id:key,ownerId:who.userId,...saved,provenance:'saved_task_input',storedStatus:choice(r.status,states),requiresApproval:r.requires_approval,generation,attemptCount:integer(r.attempt_count),progress:integer(r.progress,0,100),hasProviderTask:r.has_provider_task,cleanupPending:r.cleanup_pending,error:r.error_code===null?null:{code:text(r.error_code),message:r.error_message===null?null:text(r.error_message)},createdAt:at(r.created_at),updatedAt:at(r.updated_at)}};
  }
  function parent(key:string,generation:number){const p=jobs.get(id(key));if(!p||integer(generation,1)>p.generation)throw unavailable();return p;}
  for await(const r of pages(`SELECT a.id,a.user_id,a.job_id,a.conversation_id,a.tool_name,a.args,a.status,a.generation,a.created_at,a.decided_at
   FROM platform_approvals a WHERE a.user_id=$1 AND ($2::uuid IS NULL OR a.id>$2) ORDER BY a.id LIMIT 100`)){
   if(r.user_id!==who.userId)throw unavailable();integer(r.generation,1);
   if(r.job_id!==null){const p=parent(r.job_id,r.generation);if(p.kind!==r.tool_name)throw unavailable();}
   // Conversation-only legacy approvals have no documented payload protocol.
   // Refuse unsupported records rather than publish unknown server fields.
   if(r.job_id===null)throw unavailable();
   const conversation=r.conversation_id===null?null:await ref('conversation',id(r.conversation_id));if(conversation?.availability==='not_found')throw unavailable();
   const request=await args(r.args);if(request.definition.kind!==r.tool_name)throw unavailable();
   yield {section:'jobApprovals',record:{id:id(r.id),ownerId:who.userId,jobId:r.job_id,conversation,toolName:r.tool_name,generation:r.generation,request,status:choice(r.status,['pending','approved','rejected','expired']),createdAt:at(r.created_at),decidedAt:at(r.decided_at)}};
  }
  for await(const r of pages(`SELECT a.id,a.job_id,a.generation,a.attempt,a.status,(a.provider_task_id IS NOT NULL) AS has_provider_task,a.error_code,a.started_at,a.finished_at
   FROM platform_job_attempts a JOIN platform_jobs j ON j.id=a.job_id WHERE j.user_id=$1 AND ($2::uuid IS NULL OR a.id>$2) ORDER BY a.id LIMIT 100`)){
   parent(r.job_id,r.generation);yield {section:'jobAttempts',record:{id:id(r.id),ownerId:who.userId,jobId:r.job_id,generation:r.generation,attempt:integer(r.attempt,1),status:choice(r.status,states.slice(2)),hasProviderTask:r.has_provider_task,errorCode:r.error_code===null?null:text(r.error_code),startedAt:at(r.started_at),finishedAt:at(r.finished_at)}};
  }
  let cursor:readonly[string,number]|null=null;
  for(;;){signal?.throwIfAborted();const rows:Row[]=(await c.query(`SELECT o.job_id,o.generation,o.created_at,o.dispatched_at,(o.definition_hash IS NOT NULL) AS definition_recorded
   FROM platform_job_outbox o JOIN platform_jobs j ON j.id=o.job_id WHERE j.user_id=$1 AND ($2::uuid IS NULL OR (o.job_id,o.generation)>($2::uuid,$3::integer)) ORDER BY o.job_id,o.generation LIMIT 100`,[who.userId,cursor?.[0]??null,cursor?.[1]??null])).rows;
   for(const r of rows){signal?.throwIfAborted();parent(r.job_id,r.generation);yield {section:'jobDispatches',record:{ownerId:who.userId,jobId:r.job_id,generation:r.generation,createdAt:at(r.created_at),dispatchedAt:at(r.dispatched_at),definitionRecorded:r.definition_recorded}};}if(rows.length<100)break;cursor=[id(rows.at(-1)!.job_id),rows.at(-1)!.generation];
  }
  for await(const r of pages(`SELECT t.job_id AS id,t.user_id,t.conversation_id,t.message_id,t.tool,t.created_generation,t.created_at FROM platform_conversation_tasks t
   WHERE t.user_id=$1 AND ($2::uuid IS NULL OR t.job_id>$2) ORDER BY t.job_id LIMIT 100`)){
   if(r.user_id!==who.userId)throw unavailable();const p=parent(r.id,r.created_generation),tool=choice(r.tool,CONVERSATION_TASK_TOOLS);
   if(tool==='prepare_browser_task'&&p.kind!=='browser'||tool==='prepare_mcp_task'&&p.kind!=='mcp')throw unavailable();
   const conversation=await ref('conversation',id(r.conversation_id)),message=await ref('message',id(r.message_id),{conversation:r.conversation_id});if(conversation.availability==='not_found'||message.availability==='not_found')throw unavailable();
   yield {section:'conversationTasks',record:{ownerId:who.userId,jobId:r.id,conversationId:r.conversation_id,messageId:r.message_id,tool,createdGeneration:r.created_generation,createdAt:at(r.created_at)}};
  }
  let reviewCursor:readonly[string,number,number]|null=null;const revisions=new Map<string,number>();
  for(;;){signal?.throwIfAborted();const rows:Row[]=(await c.query(`SELECT id,user_id,job_id,generation,revision,request_id,request_hash,evidence_version,outcome,note,provenance,verified,created_at
   FROM platform_job_outcome_reviews WHERE user_id=$1 AND ($2::uuid IS NULL OR (job_id,generation,revision)>($2::uuid,$3::integer,$4::integer)) ORDER BY job_id,generation,revision LIMIT 100`,[who.userId,reviewCursor?.[0]??null,reviewCursor?.[1]??null,reviewCursor?.[2]??null])).rows;
   for(const r of rows){signal?.throwIfAborted();parent(r.job_id,r.generation);if(r.user_id!==who.userId||r.provenance!=='user_reported'||r.verified!==false)throw unavailable();const key=r.job_id+':'+r.generation,revision=integer(r.revision,1);if(revision!==(revisions.get(key)??0)+1)throw unavailable();revisions.set(key,revision);
    const command=parseJobOutcomeReviewInput({generation:r.generation,evidenceVersion:r.evidence_version,expectedRevision:revision-1,requestId:r.request_id,outcome:r.outcome,...(r.note===null?{}:{note:r.note})});
    if(createHash('sha256').update(JSON.stringify({jobId:r.job_id,...command})).digest('hex')!==r.request_hash)throw unavailable();
    yield {section:'jobOutcomeReviews',record:{id:id(r.id),ownerId:who.userId,jobId:r.job_id,generation:r.generation,revision,requestId:command.requestId,evidenceVersion:command.evidenceVersion,outcome:command.outcome,note:r.note,provenance:'user_reported',verified:false,createdAt:at(r.created_at)}};
   }if(rows.length<100)break;const r=rows.at(-1)!;reviewCursor=[id(r.job_id),r.generation,r.revision];
  }
  await authorizeFixedSession(c,who,signal);signal?.throwIfAborted();
 }catch{signal?.throwIfAborted();throw unavailable();}
}
