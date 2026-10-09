import {createHash} from 'node:crypto';
import type {PoolClient} from 'pg';
import {careerRecordId,careerRecordObject,parseModelCallUsage,type ModelCallUsage} from '@companion/platform-contracts';
import type {PlatformConfig} from './config.ts';
import {readFirstLetterTaskSnapshot,type FirstLetterTaskRow} from './first-letter-tasks.ts';
import {estimateTokenCost,reportedTokenCost} from './cost-guard.ts';
import {ApiError} from './errors.ts';
export type FirstLetterStageName='write_original'|'review_original'|'rewrite'|'review_rewrite';
export type FirstLetterStageRow={
 id:string;task_id:string;user_id:string;stage:string;provider:string;model:string;auth_version:string;
 status:string;lease_token:string|null;runtime_lease_id:string|null;lease_until:Date|null;
 start_ciphertext:Buffer;call_id:string|null;reservation_id:string|null;call_status:string|null;
 admitted_at:Date|null;call_finished_at:Date|null;receipt_ciphertext:Buffer|null;output_ciphertext:Buffer|null;
 created_at:Date;finished_at:Date|null;predecessor_id:string|null;predecessor_digest:string|null;request_digest:string|null;
};
export const firstLetterStageUnavailable=()=>new ApiError(503,'FIRST_LETTER_STAGE_UNAVAILABLE','The first-letter generation record could not be confirmed.');
export const stageBinding=(row:Pick<FirstLetterStageRow,'id'|'user_id'>,column:string)=>
 ({table:'platform_first_letter_stages',column,rowId:row.id,ownerId:row.user_id,revision:1});
export const stageDigest=(value:string)=>createHash('sha256').update(value).digest('hex');
export function stageTime(value:Date|null):string|null{
 if(value===null)return null;if(!(value instanceof Date)||!Number.isFinite(value.getTime()))throw firstLetterStageUnavailable();
 return value.toISOString();
}
export interface FirstLetterCallReceipt {
 callId:string;reservationId:string;provider:string;model:string;purpose:'first_letter_generation';
 status:'complete'|'failed'|'cancelled'|'interrupted';admittedAt:string|null;finishedAt:string;
 usage:ModelCallUsage;structuredOutcome:'invalid_format'|null;launched:boolean;costMicros:string|null;estimated:boolean|null;
}
export interface FirstLetterStageRecord{
 readonly id:string;readonly taskId:string;readonly ownerId:string;readonly stage:FirstLetterStageName;readonly preparationId:string;
 readonly provider:string;readonly model:string;readonly status:string;readonly createdAt:string;readonly finishedAt:string|null;
 readonly predecessorId:string|null;readonly predecessorDigest:string|null;readonly requestDigest:string|null;
 readonly call:Readonly<{id:string;reservationId:string;status:string;receipt:Readonly<FirstLetterCallReceipt>|null}>|null;
 readonly output:Readonly<{text:string;assurance:'unreviewed_model_output'}>|null;
}
export const stageCostSource=(row:Pick<FirstLetterStageRow,'id'|'task_id'|'stage'>)=>row.stage==='write_original'?row.task_id:row.id;
function equivalent(a:Record<string,unknown>,b:Record<string,unknown>){
 return Object.keys(a).length===Object.keys(b).length&&Object.keys(a).every(k=>a[k]===b[k]);
}
/** Same decoder for current reads and historical account export. Current
 * authorization and lease checks belong to the executor, never this decoder. */
export async function readFirstLetterStageRecord(c:PoolClient,crypto:PlatformConfig['dataCrypto'],ownerId:string,row:FirstLetterStageRow,depth=0):Promise<Readonly<FirstLetterStageRecord>>{
 try{
  if(!crypto||row.user_id!==ownerId||depth>3||!['write_original','review_original','rewrite','review_rewrite'].includes(row.stage))throw firstLetterStageUnavailable();
  careerRecordId(row.id);
  const parent=(await c.query<FirstLetterTaskRow>('SELECT * FROM platform_first_letter_tasks WHERE id=$1 AND user_id=$2',[row.task_id,ownerId])).rows[0];
  if(!parent)throw firstLetterStageUnavailable();
  const task=readFirstLetterTaskSnapshot(parent,crypto,ownerId);
  const start=crypto.openUtf8(row.start_ciphertext,stageBinding(row,'start_ciphertext'));
  const expected={stageId:row.id,taskId:row.task_id,ownerId,stage:row.stage,preparationId:task.preparationId,
   sourceId:task.sourceId,provider:row.provider,model:row.model,authVersion:String(row.auth_version),createdAt:stageTime(row.created_at),
   ...(row.stage==='write_original'?{}:{predecessorId:row.predecessor_id,predecessorDigest:row.predecessor_digest,requestDigest:row.request_digest})};
  if(start!==JSON.stringify(expected))throw firstLetterStageUnavailable();
  if(row.stage==='write_original'){
   if(row.predecessor_id||row.predecessor_digest||row.request_digest)throw firstLetterStageUnavailable();
  }else{
   if(!row.predecessor_id||!/^[a-f0-9]{64}$/.test(row.predecessor_digest??'')||!/^[a-f0-9]{64}$/.test(row.request_digest??''))throw firstLetterStageUnavailable();
   const prior=(await c.query<FirstLetterStageRow>('SELECT * FROM platform_first_letter_stages WHERE id=$1 AND user_id=$2 AND task_id=$3',
    [row.predecessor_id,ownerId,row.task_id])).rows[0];
   const allowed=row.stage==='review_original'?['write_original']:row.stage==='rewrite'?['write_original','review_original']:['rewrite'];
   if(!prior||!allowed.includes(prior.stage)||!['draft_saved','invalid_format'].includes(prior.status))throw firstLetterStageUnavailable();
   const predecessor=await readFirstLetterStageRecord(c,crypto,ownerId,prior,depth+1);
   if(row.predecessor_digest!==stageDigest(JSON.stringify(predecessor))||predecessor.provider!==row.provider||predecessor.model!==row.model)throw firstLetterStageUnavailable();
  }
  const active=row.status==='running';
  if(!['running','draft_saved','invalid_format','failed','uncertain'].includes(row.status)
   ||active&&(!row.lease_token||!row.runtime_lease_id||!row.lease_until||row.finished_at)
   ||!active&&(row.lease_token||row.runtime_lease_id||row.lease_until||!row.finished_at))throw firstLetterStageUnavailable();
  let receipt:FirstLetterCallReceipt|null=null,receiptRaw:string|null=null;
  if(row.receipt_ciphertext){
   receiptRaw=crypto.openUtf8(row.receipt_ciphertext,stageBinding(row,'receipt_ciphertext'));
   const obj=careerRecordObject(JSON.parse(receiptRaw),['callId','reservationId','provider','model','purpose','status','admittedAt',
    'finishedAt','usage','structuredOutcome','launched','costMicros','estimated']);
   const usage=parseModelCallUsage(obj.usage);
   if(obj.callId!==row.call_id||obj.reservationId!==row.reservation_id||obj.provider!==row.provider||obj.model!==row.model
    ||obj.purpose!=='first_letter_generation'||obj.status!==row.call_status||obj.admittedAt!==stageTime(row.admitted_at)
    ||obj.finishedAt!==stageTime(row.call_finished_at)||!['complete','failed','cancelled','interrupted'].includes(String(obj.status))
    ||typeof obj.launched!=='boolean'||obj.structuredOutcome!==null&&obj.structuredOutcome!=='invalid_format'
    ||obj.structuredOutcome==='invalid_format'&&(obj.status!=='failed'||!row.admitted_at||!obj.launched)
    ||obj.status==='complete'&&(!row.admitted_at||!obj.launched)
    ||!obj.launched&&(row.admitted_at||obj.costMicros!==null||obj.estimated!==null))throw firstLetterStageUnavailable();
   receipt={...obj,usage} as unknown as FirstLetterCallReceipt;
  }
  if(row.call_id){
   careerRecordId(row.call_id);careerRecordId(row.reservation_id);
   const reservation=(await c.query('SELECT * FROM platform_cost_reservations WHERE id=$1',[row.reservation_id])).rows[0];
   const ledger=(await c.query('SELECT * FROM platform_cost_ledger WHERE reservation_id=$1',[row.reservation_id])).rows[0];
   const matches=(r:any)=>r&&r.user_id===ownerId&&r.source_kind==='job'&&r.source_id===stageCostSource(row)
    &&r.capability==='background'&&r.purpose==='first_letter_generation'&&r.provider===row.provider&&r.model===row.model;
   if(!matches(reservation)||reservation.pricing_revision!==2
    ||estimateTokenCost(reservation,reservation.max_input_tokens,reservation.max_output_tokens)!==reservation.estimate_micros)throw firstLetterStageUnavailable();
   const prices=(await c.query('SELECT * FROM platform_model_prices WHERE id=ANY($1::uuid[])',[
    [reservation.input_price_id,reservation.output_price_id,reservation.cached_input_price_id,reservation.cache_write_input_price_id]])).rows;
   for(const [unit,key] of [['input_token','input'],['output_token','output'],['cached_input_token','cached_input'],['cache_write_input_token','cache_write_input']]){
    const price=prices.find(p=>p.id===reservation[key+'_price_id']);
    if(!price||price.unit!==unit||price.provider!==row.provider||price.model!==row.model||price.capability!=='background'
     ||price.micros_per_unit!==reservation[key+'_micros_per_unit'])throw firstLetterStageUnavailable();
   }
   if(prices.length!==4)throw firstLetterStageUnavailable();
   if(receipt){
    if(receipt.launched){
     const calculated=receipt.usage.status==='reported'?reportedTokenCost(reservation,receipt.usage)
      :{units:{maxInputTokens:reservation.max_input_tokens,maxOutputTokens:reservation.max_output_tokens},costMicros:reservation.estimate_micros,estimated:true};
     if(reservation.status!=='committed'||!reservation.dispatch_intent_at||!matches(ledger)||ledger.usage_status!==receipt.usage.status
      ||!equivalent(ledger.units,calculated.units)||ledger.cost_micros!==calculated.costMicros||ledger.estimated!==calculated.estimated
      ||receipt.costMicros!==calculated.costMicros||receipt.estimated!==calculated.estimated)throw firstLetterStageUnavailable();
    }else if(reservation.status!=='released'||reservation.dispatch_intent_at||ledger
     ||receipt.usage.status==='reported'&&(receipt.usage.inputTokens!==0||receipt.usage.outputTokens!==0))throw firstLetterStageUnavailable();
   }else{
    if(!['prepared','admitted'].includes(row.call_status??'')||row.call_finished_at
     ||!reservation.dispatch_intent_at||!['reserved','admitted','committed'].includes(reservation.status)
     ||row.call_status==='prepared'&&row.admitted_at||row.call_status==='admitted'&&(!row.admitted_at||reservation.status==='reserved'))throw firstLetterStageUnavailable();
    if(reservation.status==='committed'){
     if(!matches(ledger)||!ledger.estimated||!['dispatch_uncertain','expired'].includes(ledger.usage_status)
      ||ledger.cost_micros!==reservation.estimate_micros
      ||!equivalent(ledger.units,{maxInputTokens:reservation.max_input_tokens,maxOutputTokens:reservation.max_output_tokens}))throw firstLetterStageUnavailable();
    }else if(ledger)throw firstLetterStageUnavailable();
   }
  }else if(row.reservation_id||row.call_status||row.admitted_at||row.call_finished_at||receipt)throw firstLetterStageUnavailable();
  let output:Readonly<{text:string;assurance:'unreviewed_model_output'}>|null=null;
  if(row.output_ciphertext){
   const raw=crypto.openUtf8(row.output_ciphertext,stageBinding(row,'output_ciphertext'));
   const obj=careerRecordObject(JSON.parse(raw),['preparationId','receiptDigest','text']);
   if(row.status!=='draft_saved'||!receipt||receipt.status!=='complete'||obj.preparationId!==task.preparationId
    ||obj.receiptDigest!==stageDigest(receiptRaw!)||typeof obj.text!=='string'||!obj.text||Buffer.byteLength(obj.text)>16384)throw firstLetterStageUnavailable();
   output=Object.freeze({text:obj.text,assurance:'unreviewed_model_output'});
  }else if(row.status==='draft_saved')throw firstLetterStageUnavailable();
  if(row.status==='invalid_format'&&receipt?.structuredOutcome!=='invalid_format')throw firstLetterStageUnavailable();
  if(receipt){Object.freeze(receipt.usage);Object.freeze(receipt);}
  return Object.freeze({id:row.id,taskId:row.task_id,ownerId,stage:row.stage as FirstLetterStageName,preparationId:task.preparationId,
   predecessorId:row.predecessor_id,predecessorDigest:row.predecessor_digest,requestDigest:row.request_digest,
   provider:row.provider,model:row.model,status:row.status,createdAt:stageTime(row.created_at)!,finishedAt:stageTime(row.finished_at),
   call:row.call_id?Object.freeze({id:row.call_id,reservationId:row.reservation_id!,status:row.call_status!,receipt}):null,output});
 }catch{throw firstLetterStageUnavailable();}
}
