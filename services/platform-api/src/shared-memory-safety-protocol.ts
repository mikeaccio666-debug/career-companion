import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import { sharedMemoryId,type SharedMemoryRecord } from '@companion/platform-contracts';
import type { DataCrypto } from './data-crypto.ts';
import { ApiError } from './errors.ts';
export const memorySafetyUnavailable=()=>new ApiError(503,'MEMORY_SAFETY_UNAVAILABLE','The current memory classification could not be confirmed.');
export const memorySafetyChanged=()=>new ApiError(409,'MEMORY_SAFETY_CLAIM_CHANGED','The memory classification source has changed.');
export function memoryCanonical(x:unknown):string{return JSON.stringify(x,(_k,v)=>v&&typeof v==='object'&&!Array.isArray(v)?Object.fromEntries(Object.keys(v).sort().map(k=>[k,v[k]])):v);}
export const memoryTextDigest=(text:string)=>createHash('sha256').update(text,'utf8').digest('hex');
export function memoryObject(value:unknown,keys:readonly string[]):Record<string,any>{
 if(!value||typeof value!=='object'||![Object.prototype,null].includes(Object.getPrototypeOf(value)))throw memorySafetyUnavailable();const d=Object.getOwnPropertyDescriptors(value);
 if(Reflect.ownKeys(d).length!==keys.length||keys.some(k=>!d[k])||Reflect.ownKeys(d).some(k=>typeof k!=='string'||!keys.includes(k))||Object.values(d).some(x=>!('value' in x)||!x.enumerable))throw memorySafetyUnavailable();
 return Object.fromEntries(keys.map(k=>[k,d[k].value]));
}
export interface MemorySafetyClaim {readonly userId:string;readonly submissionId:string;readonly memoryId:string;readonly operationId:string;readonly submittedAtRevision:number;
 readonly generation:number;readonly authVersion:string;readonly leaseToken:string;readonly detectorRevision:number;}
export interface MemorySafetySource {readonly id:string;readonly ownerId:string;readonly memoryId:string;readonly operationId:string;readonly submittedAtRevision:number;readonly contentDigest:string;readonly capturedAt:string;readonly policyRevision:number;readonly policyDigest:string;readonly policyReviewDigest:string;}
export interface MemorySafetyDecision {readonly level:'L0'|'L1'|'L2';readonly mode:'full'|'keyword_only';}
export function parseMemorySafetyClaim(value:unknown):Readonly<MemorySafetyClaim>{
 const v=memoryObject(value,['userId','submissionId','memoryId','operationId','submittedAtRevision','generation','authVersion','leaseToken','detectorRevision']);
 for(const k of ['userId','submissionId','memoryId','operationId','leaseToken'])v[k]=sharedMemoryId(v[k]);
 for(const k of ['submittedAtRevision','generation','detectorRevision'])if(!Number.isSafeInteger(v[k])||v[k]<1||v[k]>2147483647)throw memorySafetyChanged();
 if(typeof v.authVersion!=='string'||!/^(0|[1-9][0-9]*)$/.test(v.authVersion))throw memorySafetyChanged();return Object.freeze(v) as Readonly<MemorySafetyClaim>;
}
export function parseMemorySafetyDecision(value:unknown):Readonly<MemorySafetyDecision>{
 const v=memoryObject(value,['level','mode']);if(!['L0','L1','L2'].includes(v.level)||!['full','keyword_only'].includes(v.mode)||v.level==='L0'&&v.mode!=='full')throw memorySafetyUnavailable();return Object.freeze(v) as Readonly<MemorySafetyDecision>;
}
export function memoryClaim(row:any){return parseMemorySafetyClaim({userId:row.user_id,submissionId:row.id,memoryId:row.memory_id,operationId:row.operation_id,submittedAtRevision:row.submitted_revision,generation:row.generation,authVersion:String(row.auth_version),leaseToken:row.lease_token,detectorRevision:row.detector_revision});}
export function openMemorySource(crypto:DataCrypto,row:any):Readonly<MemorySafetySource>{
 try{const text=crypto.openUtf8(row.source_ciphertext,{table:'platform_memory_safety_sources',column:'source_ciphertext',rowId:row.id,ownerId:row.user_id,revision:row.submitted_revision});
 const v=memoryObject(JSON.parse(text),['id','ownerId','memoryId','operationId','submittedAtRevision','contentDigest','capturedAt','policyRevision','policyDigest','policyReviewDigest']);
 if(memoryCanonical(v)!==text||v.id!==row.id||v.ownerId!==row.user_id||v.memoryId!==row.memory_id||v.operationId!==row.operation_id||v.submittedAtRevision!==row.submitted_revision||v.capturedAt!==row.created_at.toISOString()||v.policyRevision!==row.captured_detector_revision||![v.contentDigest,v.policyDigest,v.policyReviewDigest].every(x=>typeof x==='string'&&/^[0-9a-f]{64}$/.test(x)))throw memorySafetyUnavailable();
 return Object.freeze(v) as Readonly<MemorySafetySource>;}catch{throw memorySafetyUnavailable();}
}
export async function memoryCompletedUsage(client:PoolClient,row:any,lock=true){
 const found=await client.query(`SELECT call_id,provider,model,usage_status,input_tokens,output_tokens,EXTRACT(EPOCH FROM admitted_at)::text admitted_exact,EXTRACT(EPOCH FROM finished_at)::text finished_exact
  FROM platform_safety_model_usage WHERE source_kind='shared_memory' AND submission_id=$1 AND user_id=$2 AND operation_id=$3 AND memory_id=$4
   AND submitted_revision=$5 AND generation=$6 AND auth_version=$7 AND detector_revision=$8 AND memory_execution_token=$9
   AND purpose='safety_classify' AND call_index=1 AND status='complete' AND admitted_at IS NOT NULL AND finished_at IS NOT NULL AND admitted_at<=finished_at AND finished_at<=clock_timestamp() ${lock?"FOR SHARE":""}`,
 [row.id,row.user_id,row.operation_id,row.memory_id,row.submitted_revision,row.generation,row.auth_version,row.detector_revision,row.execution_token]);
 if(found.rows.length!==1)throw memorySafetyUnavailable();const u=found.rows[0];return {callId:u.call_id,provider:u.provider,model:u.model,usageStatus:u.usage_status,inputTokens:u.input_tokens,outputTokens:u.output_tokens,admittedAt:u.admitted_exact,finishedAt:u.finished_exact};
}
export async function memorySafetyResult(client:PoolClient,crypto:DataCrypto,row:any,source:MemorySafetySource,lock=true){
 try{if(row.status!=='detected')throw memorySafetyUnavailable();const text=crypto.openUtf8(row.result_ciphertext,{table:'platform_memory_safety_sources',column:'result_ciphertext',rowId:row.id,ownerId:row.user_id,revision:row.generation});
 const v=memoryObject(JSON.parse(text),['claim','executionToken','source','decision','policy','modelUsage']);const claim=memoryClaim(row),decision=parseMemorySafetyDecision(v.decision);
 if(memoryCanonical(v)!==text||memoryCanonical(v.claim)!==memoryCanonical(claim)||v.executionToken!==row.execution_token||memoryCanonical(v.source)!==memoryCanonical(source)||decision.level!==row.level||decision.mode!==row.detector_mode)throw memorySafetyUnavailable();
 const usage=decision.mode==='full'?await memoryCompletedUsage(client,row,lock):null;if(memoryCanonical(v.modelUsage)!==memoryCanonical(usage))throw memorySafetyUnavailable();
 const policy=memoryObject(v.policy,['revision','digest','reviewDigest']);if(policy.revision!==row.detector_revision||policy.revision!==source.policyRevision||policy.digest!==source.policyDigest||policy.reviewDigest!==source.policyReviewDigest||![policy.digest,policy.reviewDigest].every(x=>typeof x==='string'&&/^[0-9a-f]{64}$/.test(x)))throw memorySafetyUnavailable();
 return Object.freeze({decision,policy:Object.freeze(policy)});}catch{throw memorySafetyUnavailable();}
}
/** Authenticates a retained block without requiring its original memory to still exist.
 * Archive readers use lock=false within their repeatable-read snapshot. */
export async function readMemorySafetyBlock(client:PoolClient,crypto:DataCrypto,ownerId:string,row:any,lock=true){
 try{
  const text=crypto.openUtf8(row.receipt_ciphertext,{table:'platform_memory_safety_blocks',column:'receipt_ciphertext',rowId:row.id,ownerId,revision:1});
  const v=memoryObject(JSON.parse(text),['id','ownerId','memoryId','operationId','sourceId','detectedAt','result']);
  if(memoryCanonical(v)!==text||v.id!==row.id||v.ownerId!==ownerId||v.memoryId!==row.memory_id||v.operationId!==row.operation_id||v.sourceId!==row.source_id||v.detectedAt!==row.detected_at.toISOString())throw memorySafetyUnavailable();
  const result=memoryObject(v.result,['claim','executionToken','source','decision','policy','modelUsage']),claim=parseMemorySafetyClaim(result.claim),decision=parseMemorySafetyDecision(result.decision);
  if(claim.userId!==ownerId||claim.memoryId!==v.memoryId||claim.operationId!==v.operationId||claim.submissionId!==v.sourceId||decision.level!==row.level||decision.mode!==row.detector_mode||decision.level==='L0')throw memorySafetyUnavailable();
  const source=memoryObject(result.source,['id','ownerId','memoryId','operationId','submittedAtRevision','contentDigest','capturedAt','policyRevision','policyDigest','policyReviewDigest']);
  const policy=memoryObject(result.policy,['revision','digest','reviewDigest']);
  if(source.id!==claim.submissionId||source.ownerId!==ownerId||source.memoryId!==claim.memoryId||source.operationId!==claim.operationId||source.submittedAtRevision!==claim.submittedAtRevision
   ||source.policyRevision!==claim.detectorRevision||policy.revision!==source.policyRevision||policy.digest!==source.policyDigest||policy.reviewDigest!==source.policyReviewDigest)throw memorySafetyUnavailable();
  const op=(await client.query(`SELECT applied_revision FROM platform_memory_operations WHERE user_id=$1 AND memory_id=$2 AND operation_id=$3 ${lock?"FOR SHARE":""}`,[ownerId,claim.memoryId,claim.operationId])).rows[0];
  if(op?.applied_revision!==claim.submittedAtRevision)throw memorySafetyUnavailable();
  const usage=decision.mode==='full'?await memoryCompletedUsage(client,{id:claim.submissionId,user_id:ownerId,operation_id:claim.operationId,memory_id:claim.memoryId,submitted_revision:claim.submittedAtRevision,generation:claim.generation,auth_version:claim.authVersion,detector_revision:claim.detectorRevision,execution_token:result.executionToken},lock):null;
  if(memoryCanonical(usage)!==memoryCanonical(result.modelUsage))throw memorySafetyUnavailable();
  return {id:v.id,ownerId,memoryId:v.memoryId,operationId:v.operationId,sourceId:v.sourceId,detectedAt:v.detectedAt,
   source,decision,policy,modelUsage:usage};
 }catch{throw memorySafetyUnavailable();}
}
/** Historical content-free risk receipts remain blocking after edits or forgetting.
 * Only the future genuine presentation/followup path can establish handling. */
export async function memorySafetyBlockedInTransaction(client:PoolClient,crypto:DataCrypto,ownerId:string,signal?:AbortSignal):Promise<boolean>{
 const rows=(await client.query('SELECT * FROM platform_memory_safety_blocks WHERE user_id=$1 ORDER BY detected_at,id FOR SHARE',[ownerId])).rows;
 for(const row of rows){signal?.throwIfAborted();await readMemorySafetyBlock(client,crypto,ownerId,row);}
 return rows.length>0;
}
/** Actual current state comes only from SharedMemories' authenticated owner reader.
 * No grades, source rows or classifications are initialized by this read. */
export async function confirmedMemorySafetyInTransaction(client:PoolClient,crypto:DataCrypto,record:SharedMemoryRecord,signal?:AbortSignal):Promise<boolean>{
 if(record.kind!=='memory'||record.deletedAt!==null||await memorySafetyBlockedInTransaction(client,crypto,record.ownerId,signal))return false;
 const rows=(await client.query('SELECT * FROM platform_memory_safety_sources WHERE user_id=$1 AND memory_id=$2 ORDER BY submitted_revision,id FOR SHARE',[record.ownerId,record.id])).rows;
 const policy=(await client.query('SELECT revision,content_digest,review_digest FROM platform_safety_detector_policy WHERE singleton=true FOR SHARE')).rows[0];
 let full=false;const digest=memoryTextDigest(record.content);
 for(const row of rows){signal?.throwIfAborted();const source=openMemorySource(crypto,row);if(source.contentDigest!==digest)continue;
  const op=(await client.query('SELECT applied_revision FROM platform_memory_operations WHERE user_id=$1 AND memory_id=$2 AND operation_id=$3 FOR SHARE',[record.ownerId,record.id,source.operationId])).rows[0];
  if(!op||op.applied_revision!==source.submittedAtRevision||source.submittedAtRevision>record.revision)throw memorySafetyUnavailable();
  if(row.status!=='detected')continue;const result=await memorySafetyResult(client,crypto,row,source);
  if(result.decision.level!=='L0')return false;const p=result.policy;
  if(result.decision.mode==='full'&&policy&&p.revision===policy.revision&&p.digest===policy.content_digest&&p.reviewDigest===policy.review_digest)full=true;
 }return full;
}
