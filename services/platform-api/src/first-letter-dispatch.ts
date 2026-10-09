import {careerRecordId,careerRecordObject,type PlatformProviderRuntime} from '@companion/platform-contracts';
import {DatabaseOperationTimeout,type Database} from './database.ts';
import {DatabaseError} from 'pg';
import {authorizeFixedSession,type FixedSessionContext} from './auth.ts';
import type {PlatformConfig} from './config.ts';
import type {FirstLetterTasks} from './first-letter-tasks.ts';
import type {FirstLetterGeneration} from './first-letter-generation.ts';
import {snapshotFirstLetterSettings,type FirstLetterCompositionSettings} from './first-letter-composition.ts';
import {resolveModelRoute} from './model-routing.ts';
import {ApiError} from './errors.ts';
import {decodeFirstLetterRequest,firstLetterRequestBinding,firstLetterRequestDigest,firstLetterRequestUnavailable,
 firstLetterNotification,projectFirstLetterRequest,type FirstLetterRequestRow,type FirstLetterRequestSnapshot} from './first-letter-request.ts';
const changed=()=>new ApiError(409,'FIRST_LETTER_ACCEPTED_SOURCE_CHANGED','The accepted letter preparation or route changed.');
export class FirstLetterNotificationReadUnavailable extends Error{}
export class FirstLetterDispatch{
 constructor(readonly db:Database,readonly config:PlatformConfig,private readonly runtime:PlatformProviderRuntime,
  private readonly tasks:Pick<FirstLetterTasks,'readInTransaction'>,private readonly generation:FirstLetterGeneration){}
 async accept(who:FixedSessionContext,input:unknown,settings:FirstLetterCompositionSettings,signal?:AbortSignal){
  let requestId:string,taskId:string,expectedPreparationId:string;
  try{
   const v=careerRecordObject(input,['operationId','taskId','expectedPreparationId']);
   requestId=careerRecordId(v.operationId);taskId=careerRecordId(v.taskId);
   if(typeof v.expectedPreparationId!=='string'||!/^first_letter_preparation_[a-f0-9]{64}$/.test(v.expectedPreparationId)||v.expectedPreparationId.length!==89)throw changed();
   expectedPreparationId=v.expectedPreparationId;
  }catch{throw new ApiError(400,'FIRST_LETTER_REQUEST_INPUT_INVALID','Use the saved task and observed preparation.');}
  const current=snapshotFirstLetterSettings(settings);
  return this.db.withBoundedTransaction(async c=>{
   const {task}=await this.tasks.readInTransaction(c,who,{taskId},current,signal);
   if(task.preparationId!==expectedPreparationId)throw changed();
   const prior=(await c.query<FirstLetterRequestRow>('SELECT * FROM platform_first_letter_requests WHERE id=$1 OR (user_id=$2 AND task_id=$3) FOR UPDATE',[requestId,who.userId,taskId])).rows;
   if(prior.length){
    if(prior.length!==1||prior[0].id!==requestId||prior[0].user_id!==who.userId||prior[0].task_id!==taskId)throw changed();
    const saved=decodeFirstLetterRequest(prior[0],this.config.dataCrypto);
    if(saved.preparationId!==task.preparationId||saved.sourceId!==task.sourceId)throw changed();
    const outbox=await c.query('SELECT 1 FROM platform_first_letter_outbox WHERE request_id=$1 AND user_id=$2 AND task_id=$3',[requestId,who.userId,taskId]);
    if(outbox.rowCount!==1)throw firstLetterRequestUnavailable();
    await authorizeFixedSession(c,who,signal);signal?.throwIfAborted();
    return Object.freeze({request:projectFirstLetterRequest(saved),replayed:true});
   }
   // Existing attempts are not retroactively authorized by creating a queue request.
   const used=(await c.query(`SELECT EXISTS(SELECT 1 FROM platform_first_letter_stages WHERE task_id=$1)
    OR EXISTS(SELECT 1 FROM platform_cost_reservations WHERE source_kind='job' AND source_id=$1)
    OR EXISTS(SELECT 1 FROM platform_cost_ledger WHERE source_kind='job' AND source_id=$1) AS used`,[taskId])).rows[0].used;
   if(used!==false)throw changed();
   const route=resolveModelRoute(this.config,this.runtime,'first_letter_generation');
   const version=String((await c.query('SELECT auth_version FROM platform_users WHERE id=$1',[who.userId])).rows[0].auth_version);
   const acceptedAt=(await c.query('SELECT clock_timestamp() AS now')).rows[0].now.toISOString();
   const saved:FirstLetterRequestSnapshot={schemaVersion:1,requestId,ownerId:who.userId,taskId,companionId:task.companionId,
    welcomeId:task.welcomeId,preparationId:task.preparationId,sourceId:task.sourceId,tokenHash:who.tokenHash,authVersion:version,
    settings:current,provider:route.provider,model:route.model,acceptedAt};
   if(!this.config.dataCrypto)throw firstLetterRequestUnavailable();
   const raw=JSON.stringify(saved),cipher=this.config.dataCrypto.sealUtf8(raw,firstLetterRequestBinding({id:requestId,user_id:who.userId}));
   const row=(await c.query<FirstLetterRequestRow>(`INSERT INTO platform_first_letter_requests
    (id,user_id,task_id,preparation_id,auth_version,payload_digest,payload_ciphertext,accepted_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,[requestId,who.userId,taskId,task.preparationId,version,firstLetterRequestDigest(raw),cipher,acceptedAt])).rows[0];
   await c.query('INSERT INTO platform_first_letter_outbox(request_id,user_id,task_id,created_at) VALUES($1,$2,$3,$4)',[requestId,who.userId,taskId,acceptedAt]);
   const result=decodeFirstLetterRequest(row,this.config.dataCrypto);
   await authorizeFixedSession(c,who,signal);signal?.throwIfAborted();
   return Object.freeze({request:projectFirstLetterRequest(result),replayed:false});
  });
 }
 async executeNotification(input:unknown,settings:FirstLetterCompositionSettings,signal?:AbortSignal){
  const notification=firstLetterNotification(input),current=snapshotFirstLetterSettings(settings);
  const accepted=await this.db.withBoundedTransaction(async c=>{
   const found=(await c.query<FirstLetterRequestRow>('SELECT * FROM platform_first_letter_requests WHERE id=$1 AND task_id=$2',
    [notification.requestId,notification.taskId])).rows[0];
   if(!found)throw firstLetterRequestUnavailable();
   const initial=decodeFirstLetterRequest(found,this.config.dataCrypto),who={userId:initial.ownerId,tokenHash:initial.tokenHash};
   const {task}=await this.tasks.readInTransaction(c,who,{taskId:initial.taskId},current,signal);
   const row=(await c.query<FirstLetterRequestRow>(`SELECT r.* FROM platform_first_letter_requests r JOIN platform_first_letter_outbox o
    ON o.request_id=r.id AND o.user_id=r.user_id AND o.task_id=r.task_id
    WHERE r.id=$1 AND r.task_id=$2 FOR UPDATE OF r,o`,[notification.requestId,notification.taskId])).rows[0];
   if(!row||row.payload_digest!==found.payload_digest)throw firstLetterRequestUnavailable();
   const saved=decodeFirstLetterRequest(row,this.config.dataCrypto);
   const version=String((await c.query('SELECT auth_version FROM platform_users WHERE id=$1',[who.userId])).rows[0].auth_version);
   if(saved.authVersion!==version||saved.preparationId!==task.preparationId||saved.sourceId!==task.sourceId
    ||saved.companionId!==task.companionId||saved.welcomeId!==task.welcomeId||JSON.stringify(saved.settings)!==JSON.stringify(current))throw changed();
   const route=resolveModelRoute(this.config,this.runtime,'first_letter_generation');
   if(route.provider!==saved.provider||route.model!==saved.model)throw changed();
   await authorizeFixedSession(c,who,signal);signal?.throwIfAborted();return {who,taskId:task.taskId};
  }).catch(error=>{
   if(error instanceof DatabaseOperationTimeout||error instanceof DatabaseError&&error.code==='57014')
    throw new FirstLetterNotificationReadUnavailable('Initial letter request verification needs another delivery.');
   throw error;
  });
  const pick={taskId:accepted.taskId};
  let original=await this.generation.recover(accepted.who,pick,current,signal);
  if(original?.status==='running')return {kind:'waiting' as const};
  if(original?.status==='uncertain'||original?.status==='failed'&&original.call)return {kind:'held' as const,reason:'terminal' as const};
  if(!original||original.status==='failed')original=await this.generation.generate(accepted.who,pick,current,signal);
  let review=await this.generation.recoverReview(accepted.who,pick,current,signal);
  if(review.kind==='needs_stage'){
   if(review.status==='running')return {kind:'waiting' as const};
   if(review.status==='uncertain')return {kind:'held' as const,reason:'terminal' as const};
   review=await this.generation.review(accepted.who,pick,current,signal);
  }
  return {kind:review.kind==='reviewed_draft'?'reviewed' as const:'held' as const,reason:'terminal' as const};
 }
}
