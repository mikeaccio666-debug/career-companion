import type {PoolClient} from 'pg';
import {careerRecordId as id,careerRecordObject as object} from '@companion/platform-contracts';
import {authorizeFixedSession,type FixedSessionContext} from './auth.ts';
import {ApiError} from './errors.ts';

export const MODEL_AUDIT_EXPORT_TABLES=Object.freeze(['platform_safety_model_usage','platform_model_relay_requests'] as const);
export type ModelAuditExportSection='safetyModelUsage'|'modelRelayRequests';
type Row=Record<string,any>;
const unavailable=()=>new ApiError(503,'ACCOUNT_MODEL_AUDIT_EXPORT_UNAVAILABLE','The retained model call records could not be confirmed.');
function count(value:unknown,min=0):number{if(!Number.isSafeInteger(value)||Object.is(value,-0)||(value as number)<min||(value as number)>2147483647)throw unavailable();return value as number;}
function text(value:unknown,max:number):string{if(typeof value!=='string'||!value.length||value.length>max)throw unavailable();return value;}
function choice(value:unknown,values:readonly string[]):string{if(typeof value!=='string'||!values.includes(value))throw unavailable();return value;}
function at(value:unknown,nullable=false):string|null{if(value===null&&nullable)return null;if(!(value instanceof Date)||!Number.isFinite(value.getTime()))throw unavailable();return value.toISOString();}
const safetyQuery=`SELECT u.call_id AS id,u.user_id,u.source_kind,u.submission_id,u.operation_id,u.draft_id,u.question_id,u.entry_id,u.task_id,u.companion_id,
 u.preview_revision,u.expected_identity_revision,u.memory_id,u.submitted_revision,u.generation,u.detector_revision,u.call_index,u.provider,u.model,u.purpose,
 u.status,u.usage_status,u.input_tokens,u.output_tokens,u.cached_input_tokens,u.cache_write_input_tokens,u.created_at,u.admitted_at,u.finished_at,
 CASE u.source_kind
 WHEN 'onboarding' THEN EXISTS(SELECT 1 FROM platform_onboarding_safety_submissions s WHERE s.id=u.submission_id AND s.user_id=u.user_id
  AND s.operation_id=u.operation_id AND s.draft_id=u.draft_id AND s.question_id=u.question_id AND s.submitted_revision=u.submitted_revision)
 WHEN 'companion_name' THEN EXISTS(SELECT 1 FROM platform_companion_name_submissions s WHERE s.id=u.submission_id AND s.user_id=u.user_id
  AND s.operation_id=u.operation_id AND s.entry_id=u.entry_id AND s.task_id=u.task_id AND s.companion_id=u.companion_id
  AND s.preview_revision=u.preview_revision AND s.submitted_revision=u.submitted_revision AND s.expected_identity_revision=u.expected_identity_revision)
 WHEN 'shared_memory' THEN EXISTS(SELECT 1 FROM platform_memory_operations o WHERE o.user_id=u.user_id AND o.operation_id=u.operation_id
  AND o.memory_id=u.memory_id AND o.applied_revision=u.submitted_revision)
 ELSE false END AS source_owned FROM platform_safety_model_usage u`;
const relayQuery=`SELECT u.id,u.user_id,u.job_id,u.generation,u.request_id,u.provider,u.model,u.reserved_tokens,u.input_tokens,u.output_tokens,
 u.status,u.error_code,u.created_at,u.finished_at,EXISTS(SELECT 1 FROM platform_jobs j WHERE j.id=u.job_id AND j.user_id=u.user_id
 AND j.kind='cli' AND j.provider='cli' AND j.generation>=u.generation) AS source_owned
 FROM platform_model_relay_requests u`;
async function* rows(client:PoolClient,owner:string,kind:'safety'|'relay',signal?:AbortSignal){
 let after:string|null=null;const query=kind==='safety'?safetyQuery:relayQuery,key=kind==='safety'?'call_id':'id';
 for(;;){signal?.throwIfAborted();const found:Row[]=(await client.query(`${query} WHERE u.user_id=$1 AND ($2::uuid IS NULL OR u.${key}>$2) ORDER BY u.${key} LIMIT 100`,[owner,after])).rows;
  for(const row of found){signal?.throwIfAborted();if(row.user_id!==owner||row.source_owned!==true)throw unavailable();id(row.id);yield row;}
  if(found.length<100)break;after=id(found.at(-1)!.id);
 }
}
function source(row:Row){
 const common={kind:choice(row.source_kind,['onboarding','companion_name','shared_memory']),submissionId:id(row.submission_id),operationId:id(row.operation_id),submittedRevision:count(row.submitted_revision,1)};
 const empty=(keys:string[])=>{if(keys.some(key=>row[key]!==null))throw unavailable();};
 if(common.kind==='onboarding'){
  empty(['entry_id','task_id','companion_id','preview_revision','expected_identity_revision','memory_id']);count(row.submitted_revision,2);
  return {...common,draftId:id(row.draft_id),questionId:text(row.question_id,80)};
 }
 if(common.kind==='companion_name'){
  empty(['draft_id','question_id','memory_id']);if(row.preview_revision!==1)throw unavailable();
  return {...common,entryId:id(row.entry_id),taskId:id(row.task_id),companionId:id(row.companion_id),previewRevision:1,expectedIdentityRevision:count(row.expected_identity_revision)};
 }
 empty(['draft_id','question_id','entry_id','task_id','companion_id','preview_revision','expected_identity_revision']);
 return {...common,memoryId:id(row.memory_id)};
}
/** Counts-only archive of actual retained records. Never admits or settles a
 * call, treats missing usage as zero, or authorizes/retries a relay request. */
export async function* exportModelAuditInTransaction(client:PoolClient,value:FixedSessionContext,signal?:AbortSignal):AsyncGenerator<{section:ModelAuditExportSection;record:unknown}>{
 const raw=object(value,['userId','tokenHash']),who=Object.freeze({userId:id(raw.userId),tokenHash:raw.tokenHash as string});
 if(typeof who.tokenHash!=='string'||!/^[0-9a-f]{64}$/.test(who.tokenHash))throw new ApiError(401,'AUTH_REQUIRED','Sign in to continue.');
 await authorizeFixedSession(client,who,signal);
 try{
  for await(const row of rows(client,who.userId,'safety',signal)){
   const status=choice(row.status,['prepared','admitted','complete','failed','cancelled','interrupted']),usageStatus=choice(row.usage_status,['pending','reported','missing','invalid']);
   const createdAt=at(row.created_at)!,admittedAt=at(row.admitted_at,true),finishedAt=at(row.finished_at,true);
   if(row.purpose!=='safety_classify'||row.call_index!==1||admittedAt!==null&&admittedAt<createdAt||finishedAt!==null&&(finishedAt<createdAt||admittedAt!==null&&finishedAt<admittedAt)
    ||status==='prepared'&&(admittedAt!==null||finishedAt!==null||usageStatus!=='pending')
    ||status==='admitted'&&(admittedAt===null||finishedAt!==null||usageStatus!=='pending')
    ||!['prepared','admitted'].includes(status)&&(finishedAt===null||usageStatus==='pending')||status==='complete'&&admittedAt===null)throw unavailable();
   let inputTokens:number|null=null,outputTokens:number|null=null,cachedInputTokens:number|null=null,cacheWriteInputTokens:number|null=null;
   if(usageStatus==='reported'){
    inputTokens=count(row.input_tokens);outputTokens=count(row.output_tokens);
    cachedInputTokens=row.cached_input_tokens===null?null:count(row.cached_input_tokens);cacheWriteInputTokens=row.cache_write_input_tokens===null?null:count(row.cache_write_input_tokens);
    if((cachedInputTokens??0)+(cacheWriteInputTokens??0)>inputTokens)throw unavailable();
   }else if([row.input_tokens,row.output_tokens,row.cached_input_tokens,row.cache_write_input_tokens].some(x=>x!==null))throw unavailable();
   yield {section:'safetyModelUsage',record:{id:row.id,ownerId:who.userId,source:source(row),generation:count(row.generation,1),detectorRevision:count(row.detector_revision,1),
    callIndex:1,provider:text(row.provider,80),model:text(row.model,150),purpose:'safety_classify',status,usageStatus,inputTokens,outputTokens,cachedInputTokens,cacheWriteInputTokens,createdAt,admittedAt,finishedAt}};
  }
  for await(const row of rows(client,who.userId,'relay',signal)){
   const status=choice(row.status,['reserved','succeeded','failed','uncertain']),createdAt=at(row.created_at)!,finishedAt=at(row.finished_at,true),reservedTokens=count(row.reserved_tokens,1);
   const inputTokens=row.input_tokens===null?null:count(row.input_tokens),outputTokens=row.output_tokens===null?null:count(row.output_tokens);
   if(!/^[A-Za-z0-9_-]{1,100}$/.test(row.request_id)||finishedAt!==null&&finishedAt<createdAt
    ||status==='reserved'&&(finishedAt!==null||inputTokens!==null||outputTokens!==null||row.error_code!==null)
    ||status!=='reserved'&&finishedAt===null||status==='succeeded'&&(inputTokens===null||outputTokens===null||inputTokens+outputTokens>reservedTokens||row.error_code!==null)
    ||['failed','uncertain'].includes(status)&&(inputTokens!==null||outputTokens!==null||typeof row.error_code!=='string'||!/^[A-Z][A-Z0-9_]{0,99}$/.test(row.error_code)))throw unavailable();
   yield {section:'modelRelayRequests',record:{id:row.id,ownerId:who.userId,jobId:id(row.job_id),generation:count(row.generation,1),requestId:row.request_id,
    provider:choice(row.provider,['openai','ollama']),model:text(row.model,160),status,reservedTokens,inputTokens,outputTokens,
    usageStatus:status==='succeeded'?'reported':'not_reported',errorCode:row.error_code,createdAt,finishedAt}};
  }
 }catch{signal?.throwIfAborted();throw unavailable();}
 await authorizeFixedSession(client,who,signal);signal?.throwIfAborted();
}
