import {planFirstLetterReview,type FirstLetterReviewOutcome,type FirstLetterReviewStage} from './first-letter-review.ts';
import {randomUUID} from 'node:crypto';
import type {PoolClient} from 'pg';
import {careerRecordObject,careerRecordId,parseModelCallUsage,type PlatformProviderRuntime,type ModelCallEvent,
 type ProviderRequestAdmission,type ProviderChatMessage,type ChatContext} from '@companion/platform-contracts';
import {authorizeFixedSession,type FixedSessionContext} from './auth.ts';
import type {Database} from './database.ts';
import type {PlatformConfig} from './config.ts';
import {FirstLetterTasks} from './first-letter-tasks.ts';
import {snapshotFirstLetterSettings,type FirstLetterCompositionSettings,type FirstLetterPreparation} from './first-letter-composition.ts';
import {CostGuard,type CostReservationBinding,type CostReserveInput} from './cost-guard.ts';
import {acquireRuntimeLease} from './runtime-leases.ts';
import {resolveModelRoute} from './model-routing.ts';
import {ApiError} from './errors.ts';
import {readFirstLetterStageRecord,firstLetterStageUnavailable as unavailable,stageBinding,stageTime,stageDigest,
 type FirstLetterStageRow,type FirstLetterCallReceipt,type FirstLetterStageRecord,type FirstLetterStageName,stageCostSource} from './first-letter-stage-record.ts';
type Config=Pick<PlatformConfig,'dataCrypto'|'modelRoutes'>;
type StageRequest={messages:readonly ProviderChatMessage[];background:NonNullable<ChatContext['background']>};
type Claim={row:FirstLetterStageRow;prepared:FirstLetterPreparation;settings:Readonly<FirstLetterCompositionSettings>;request:StageRequest};
const lost=()=>new ApiError(409,'FIRST_LETTER_EXECUTION_CHANGED','The first-letter execution is no longer current.');
const pending=()=>new ApiError(409,'FIRST_LETTER_RECOVERY_REQUIRED','Inspect the saved generation before continuing.');
function session(value:FixedSessionContext){
 try{const s=careerRecordObject(value,['userId','tokenHash']);if(typeof s.tokenHash!=='string'||!/^[a-f0-9]{64}$/.test(s.tokenHash)||s.tokenHash.length!==64)throw unavailable();
 return Object.freeze({userId:careerRecordId(s.userId),tokenHash:s.tokenHash});}
 catch{throw new ApiError(401,'AUTH_REQUIRED','Sign in to continue.');}
}
function selection(value:unknown){try{return {taskId:careerRecordId(careerRecordObject(value,['taskId']).taskId)};}
 catch{throw new ApiError(400,'FIRST_LETTER_TASK_INPUT_INVALID','Use the saved task identifier.');}}
/** Executes source-bound original/review/rewrite stages with genuine runtime
 * admission and CostGuard. No HTTP route, automatic worker or publication. */
export class FirstLetterGeneration{
 private readonly costs:CostGuard;
 constructor(private readonly db:Database,private readonly config:Config,private readonly runtime:PlatformProviderRuntime,
  private readonly tasks:Pick<FirstLetterTasks,'readInTransaction'>){this.costs=new CostGuard(db);}
 private row(c:PoolClient,taskId:string,ownerId:string,stage:FirstLetterStageName='write_original'){
  return c.query<FirstLetterStageRow>("SELECT * FROM platform_first_letter_stages WHERE task_id=$1 AND user_id=$2 AND stage=$3 FOR UPDATE",[taskId,ownerId,stage]);
 }
 async read(value:FixedSessionContext,input:unknown,settings:FirstLetterCompositionSettings,signal?:AbortSignal){
  const who=session(value),pick=selection(input),saved=snapshotFirstLetterSettings(settings);
  return this.db.withBoundedTransaction(async c=>{
   await this.tasks.readInTransaction(c,who,pick,saved,signal);
   const row=(await this.row(c,pick.taskId,who.userId)).rows[0];
   const record=row?await readFirstLetterStageRecord(c,this.config.dataCrypto,who.userId,row):null;
   await authorizeFixedSession(c,who,signal);signal?.throwIfAborted();return record;
  });
 }
 /** Rebuild the exact next step from authenticated history under the owner lock. */
 private async continuation(c:PoolClient,who:FixedSessionContext,prepared:FirstLetterPreparation,taskId:string){
  const rows=(await c.query<FirstLetterStageRow>(`SELECT * FROM platform_first_letter_stages WHERE task_id=$1 AND user_id=$2
   ORDER BY CASE stage WHEN 'write_original' THEN 0 WHEN 'review_original' THEN 1 WHEN 'rewrite' THEN 2 ELSE 3 END FOR UPDATE`,
   [taskId,who.userId])).rows;
  if(!rows.length||rows[0].stage!=='write_original')throw new ApiError(409,'FIRST_LETTER_ORIGINAL_REQUIRED','Save the original draft before reviewing it.');
  const records:Readonly<FirstLetterStageRecord>[]=[];
  for(const row of rows)records.push(await readFirstLetterStageRecord(c,this.config.dataCrypto,who.userId,row));
  const original=records[0];
  if(!['draft_saved','invalid_format'].includes(original.status))throw pending();
  const raw=original.status==='invalid_format'?null:original.output!.text;
  const history:FirstLetterReviewOutcome[]=[];let plan=planFirstLetterReview(prepared,raw,history),predecessor=original;
  for(let i=1;i<records.length;i++){
   const record=records[i];
   if(plan.kind!=='next'||record.stage!==plan.stage||record.predecessorId!==predecessor.id
    ||record.requestDigest!==stageDigest(JSON.stringify({messages:plan.messages,background:plan.background})))throw unavailable();
   if(!['draft_saved','invalid_format'].includes(record.status)){
    if(i!==records.length-1)throw unavailable();return {plan,predecessor,records,held:record};
   }
   if(!record.call?.receipt)throw unavailable();
   history.push({stage:record.stage as FirstLetterReviewStage,kind:record.status==='invalid_format'?'invalid_format':'complete',
    ...(record.output?{text:record.output.text}:{}),callId:record.call.id,provider:record.provider,model:record.model});
   predecessor=record;plan=planFirstLetterReview(prepared,raw,history);
  }
  return {plan,predecessor,records,held:null};
 }
 async readReview(value:FixedSessionContext,input:unknown,settings:FirstLetterCompositionSettings,signal?:AbortSignal){
  return this.db.withBoundedTransaction(c=>this.readReviewInTransaction(c,value,input,settings,signal));
 }
 /** Reconstruct the saved review under the caller's existing owner lock. */
 async readReviewInTransaction(c:PoolClient,value:FixedSessionContext,input:unknown,settings:FirstLetterCompositionSettings,signal?:AbortSignal){
  const who=session(value),pick=selection(input),saved=snapshotFirstLetterSettings(settings);
   const {preparation}=await this.tasks.readInTransaction(c,who,pick,saved,signal);
   const state=await this.continuation(c,who,preparation,pick.taskId);
   await authorizeFixedSession(c,who,signal);signal?.throwIfAborted();
   if(state.plan.kind==='next')return Object.freeze({kind:'needs_stage' as const,stage:state.plan.stage,status:state.held?.status??'not_started'});
   const evidence=Object.freeze(state.records.map(r=>Object.freeze({stageId:r.id,stage:r.stage,callId:r.call!.id,
    preparationId:r.preparationId,predecessorId:r.predecessorId,predecessorDigest:r.predecessorDigest,requestDigest:r.requestDigest})));
   return Object.freeze({...state.plan,evidence,...(state.plan.kind==='reviewed_draft'?{assurance:'durable_model_judgment' as const}:{})});
 }
 /** At most the three review/rewrite slots; every iteration reconstructs SQL
  * history. A restarted caller never resets the rewrite count or invents calls. */
 async review(value:FixedSessionContext,input:unknown,settings:FirstLetterCompositionSettings,signal?:AbortSignal){
  const who=session(value),pick=selection(input),saved=snapshotFirstLetterSettings(settings);
  for(let i=0;i<=3;i++){
   const state=await this.readReview(who,pick,saved,signal);
   if(state.kind!=='needs_stage')return state;
   if(i===3)throw unavailable();
   await this.execute(who,pick,saved,state.stage,signal);
  }
  throw unavailable();
 }
 async generate(value:FixedSessionContext,input:unknown,settings:FirstLetterCompositionSettings,signal?:AbortSignal){
  return this.execute(value,input,settings,'write_original',signal);
 }
 private async execute(value:FixedSessionContext,input:unknown,settings:FirstLetterCompositionSettings,stage:FirstLetterStageName,signal?:AbortSignal){
  const who=session(value),pick=selection(input),saved=snapshotFirstLetterSettings(settings);
  const work=await this.db.withBoundedTransaction(async c=>{
   const {task,preparation}=await this.tasks.readInTransaction(c,who,pick,saved,signal);
   const existing=(await this.row(c,pick.taskId,who.userId,stage)).rows[0];
   if(existing&&['draft_saved','invalid_format'].includes(existing.status)){
    const record=await readFirstLetterStageRecord(c,this.config.dataCrypto,who.userId,existing);
    await authorizeFixedSession(c,who,signal);signal?.throwIfAborted();return {record};
   }
   let request:StageRequest={messages:preparation.messages,background:preparation.background};
   let predecessor:Readonly<FirstLetterStageRecord>|null=null;
   if(stage!=='write_original'){
    const continuation=await this.continuation(c,who,preparation,pick.taskId);
    if(continuation.plan.kind!=='next'||continuation.plan.stage!==stage)throw unavailable();
    request={messages:continuation.plan.messages,background:continuation.plan.background};predecessor=continuation.predecessor;
   }
   if(existing){
    const record=await readFirstLetterStageRecord(c,this.config.dataCrypto,who.userId,existing);
    await authorizeFixedSession(c,who,signal);signal?.throwIfAborted();
    if(['draft_saved','invalid_format'].includes(record.status))return {record};
    // A failed claim with no persisted call AND no money intent can be retried
    // without erasing a call receipt or resetting an attempted original stage.
    if(existing.status==='failed'&&!existing.call_id){
     const money=await c.query("SELECT 1 FROM platform_cost_reservations WHERE user_id=$1 AND source_kind='job' AND source_id=$2 AND purpose='first_letter_generation'",[who.userId,stageCostSource(existing)]);
     if(money.rowCount)throw pending();
     const route=resolveModelRoute(this.config,this.runtime,'first_letter_generation');
     if(route.provider!==existing.provider||route.model!==existing.model)throw pending();
     const runtimeLease=await acquireRuntimeLease(c,who.userId,'background',randomUUID(),60),lease=randomUUID();
     const row=(await c.query<FirstLetterStageRow>(`UPDATE platform_first_letter_stages SET status='running',finished_at=NULL,
      lease_token=$2,runtime_lease_id=$3,lease_until=clock_timestamp()+interval '60 seconds'
      WHERE id=$1 AND status='failed' AND call_id IS NULL RETURNING *`,[existing.id,lease,runtimeLease])).rows[0];
     if(!row)throw pending();const claim={row,prepared:preparation,settings:saved,request};
     await this.current(c,who,claim,signal);return {claim};
    }
    throw pending();
   }
   if(!this.config.dataCrypto)throw unavailable();
   const route=resolveModelRoute(this.config,this.runtime,'first_letter_generation');
   const version=String((await c.query('SELECT auth_version FROM platform_users WHERE id=$1',[who.userId])).rows[0].auth_version);
   const runtimeLease=await acquireRuntimeLease(c,who.userId,'background',randomUUID(),60),id=randomUUID(),lease=randomUUID();
   const createdAt=stageTime((await c.query('SELECT clock_timestamp() AS now')).rows[0].now)!;
   if(predecessor&&(predecessor.provider!==route.provider||predecessor.model!==route.model))throw unavailable();
   const dependencies=predecessor?{predecessorId:predecessor.id,predecessorDigest:stageDigest(JSON.stringify(predecessor)),requestDigest:stageDigest(JSON.stringify(request))}:null;
   const start={stageId:id,taskId:task.taskId,ownerId:who.userId,stage,preparationId:task.preparationId,
    sourceId:task.sourceId,provider:route.provider,model:route.model,authVersion:version,createdAt,...(dependencies??{})};
   const cipher=this.config.dataCrypto.sealUtf8(JSON.stringify(start),stageBinding({id,user_id:who.userId},'start_ciphertext'));
   const row=(await c.query<FirstLetterStageRow>(`INSERT INTO platform_first_letter_stages
    (id,task_id,user_id,stage,provider,model,auth_version,status,lease_token,runtime_lease_id,lease_until,start_ciphertext,created_at,predecessor_id,predecessor_digest,request_digest)
    VALUES($1,$2,$3,$11,$4,$5,$6,'running',$7,$8,clock_timestamp()+interval '60 seconds',$9,$10,$12,$13,$14) RETURNING *`,
    [id,task.taskId,who.userId,route.provider,route.model,version,lease,runtimeLease,cipher,createdAt,stage,dependencies?.predecessorId??null,dependencies?.predecessorDigest??null,dependencies?.requestDigest??null])).rows[0];
   const claim={row,prepared:preparation,settings:saved,request};await this.current(c,who,claim,signal);return {claim};
  });
  if(work.record)return work.record;
  return this.consume(who,work.claim!,signal);
 }
 private async current(c:PoolClient,who:FixedSessionContext,claim:Claim,signal?:AbortSignal){
  const {task}=await this.tasks.readInTransaction(c,who,{taskId:claim.row.task_id},claim.settings,signal);
  if(task.preparationId!==claim.prepared.preparationId)throw lost();
  if(claim.row.stage!=='write_original'){
   const state=await this.continuation(c,who,claim.prepared,claim.row.task_id);
   if(state.plan.kind!=='next'||state.plan.stage!==claim.row.stage
    ||stageDigest(JSON.stringify({messages:state.plan.messages,background:state.plan.background}))!==claim.row.request_digest
    ||stageDigest(JSON.stringify(claim.request))!==claim.row.request_digest)throw lost();
  }
  const rows=(await c.query<FirstLetterStageRow>(`SELECT s.* FROM platform_first_letter_stages s
   JOIN platform_runtime_leases l ON l.id=s.runtime_lease_id AND l.user_id=s.user_id AND l.kind='background'
   JOIN platform_users u ON u.id=s.user_id
   WHERE s.id=$1 AND s.user_id=$2 AND s.status='running' AND s.lease_token=$3 AND s.runtime_lease_id=$4
    AND s.auth_version=$5 AND u.auth_version=s.auth_version
    AND s.lease_until>clock_timestamp() AND l.expires_at>clock_timestamp() FOR UPDATE OF s,l`,
   [claim.row.id,who.userId,claim.row.lease_token,claim.row.runtime_lease_id,claim.row.auth_version])).rows;
  if(rows.length!==1)throw lost();
  await readFirstLetterStageRecord(c,this.config.dataCrypto,who.userId,rows[0]);
  await authorizeFixedSession(c,who,signal);signal?.throwIfAborted();return rows[0];
 }
 private async renew(c:PoolClient,who:FixedSessionContext,claim:Claim,signal:AbortSignal){
  await this.current(c,who,claim,signal);
  await c.query("UPDATE platform_runtime_leases SET expires_at=clock_timestamp()+interval '60 seconds' WHERE id=$1 AND user_id=$2",[claim.row.runtime_lease_id,who.userId]);
  await c.query("UPDATE platform_first_letter_stages SET lease_until=clock_timestamp()+interval '60 seconds' WHERE id=$1 AND lease_token=$2",[claim.row.id,claim.row.lease_token]);
  await this.current(c,who,claim,signal);
 }
 /** Last statement before launch: retained locks protect mutation; this checks
  * expiry again because time is not frozen by those locks. */
 private async grant(c:PoolClient,who:FixedSessionContext,claim:Claim,callId:string,signal:AbortSignal){
  const changed=await c.query(`UPDATE platform_first_letter_stages s SET call_status='admitted',admitted_at=clock_timestamp()
   FROM platform_cost_reservations r
   WHERE s.id=$1 AND s.user_id=$2 AND s.call_id=$3 AND s.call_status='prepared'
    AND s.status='running' AND s.lease_token=$4 AND s.runtime_lease_id=$5 AND s.auth_version=$6 AND s.lease_until>clock_timestamp()
    AND r.id=s.reservation_id AND r.user_id=s.user_id AND r.source_id=CASE WHEN s.stage='write_original' THEN s.task_id ELSE s.id END AND r.source_kind='job'
    AND r.purpose='first_letter_generation' AND r.capability='background' AND r.provider=s.provider AND r.model=s.model
    AND r.status='admitted' AND r.expires_at>clock_timestamp() AND r.pricing_revision=2
    AND EXISTS(SELECT 1 FROM platform_runtime_leases l WHERE l.id=s.runtime_lease_id AND l.user_id=s.user_id
     AND l.kind='background' AND l.expires_at>clock_timestamp())
    AND EXISTS(SELECT 1 FROM platform_users u JOIN platform_sessions v ON v.user_id=u.id
     WHERE u.id=s.user_id AND u.auth_version=s.auth_version AND v.auth_version=u.auth_version AND v.token_hash=$7 AND v.expires_at>clock_timestamp())
    AND EXISTS(SELECT 1 FROM platform_cost_global_policy g JOIN platform_cost_user_policy p ON p.user_id=s.user_id
     WHERE g.singleton=true AND g.approved_by IS NOT NULL AND p.approved_by IS NOT NULL
      AND g.approved_at<=clock_timestamp() AND p.approved_at<=clock_timestamp()
      AND g.effective_from<=clock_timestamp() AND p.effective_from<=clock_timestamp()
      AND(g.effective_to IS NULL OR g.effective_to>clock_timestamp()) AND(p.effective_to IS NULL OR p.effective_to>clock_timestamp()))
    AND(SELECT count(*) FROM platform_model_prices p WHERE p.provider=r.provider AND p.model=r.model AND p.capability='background'
      AND p.unit IN ('input_token','output_token','cached_input_token','cache_write_input_token')
      AND p.effective_from<=clock_timestamp() AND(p.effective_to IS NULL OR p.effective_to>clock_timestamp()))=4
    AND(SELECT count(*) FROM platform_model_prices p WHERE p.provider=r.provider AND p.model=r.model AND p.capability='background'
      AND p.effective_from<=clock_timestamp() AND(p.effective_to IS NULL OR p.effective_to>clock_timestamp())
      AND((p.id=r.input_price_id AND p.unit='input_token' AND p.micros_per_unit=r.input_micros_per_unit)
       OR(p.id=r.output_price_id AND p.unit='output_token' AND p.micros_per_unit=r.output_micros_per_unit)
       OR(p.id=r.cached_input_price_id AND p.unit='cached_input_token' AND p.micros_per_unit=r.cached_input_micros_per_unit)
       OR(p.id=r.cache_write_input_price_id AND p.unit='cache_write_input_token' AND p.micros_per_unit=r.cache_write_input_micros_per_unit)))=4
   RETURNING s.id`,[claim.row.id,who.userId,callId,claim.row.lease_token,claim.row.runtime_lease_id,claim.row.auth_version,who.tokenHash]);
  signal.throwIfAborted();if(changed.rowCount!==1)throw lost();
 }
 private async consume(who:FixedSessionContext,claim:Claim,parent?:AbortSignal){
  const stop=new AbortController(),signal=AbortSignal.any([stop.signal,...(parent?[parent]:[])]);
  let renewal:Promise<void>|undefined,closing=false;
  const heartbeat=setInterval(()=>{
   if(closing||renewal||signal.aborted)return;
   const work=this.db.withBoundedTransaction(c=>this.renew(c,who,claim,signal));renewal=work;
   void work.catch(e=>stop.abort(e)).finally(()=>{if(renewal===work)renewal=undefined;});
  },15000);heartbeat.unref();
  const deadline=setTimeout(()=>stop.abort(unavailable()),40000);deadline.unref();
  let callId:string|undefined,binding:CostReservationBinding|undefined,launched=false,admitted=false,finished:string|undefined,outcome:string|undefined;
  const reserveId=randomUUID(),route={provider:claim.row.provider,model:claim.row.model};
  const input={...route,mode:'chat' as const,messages:claim.request.messages.map(m=>({...m}))};
  const reserve:CostReserveInput={userId:who.userId,sourceKind:'job',sourceId:stageCostSource(claim.row),capability:'background',
   purpose:'first_letter_generation',...route,maxInputTokens:Buffer.byteLength(JSON.stringify(input))+Buffer.byteLength(JSON.stringify(claim.request.background.responseFormat.schema))+8192,
   maxOutputTokens:1536,ttlSeconds:120,reservationId:reserveId};
  const onModelCall=async(event:ModelCallEvent)=>{
   if(event.type==='started'){
    if(callId||event.index!==1||event.provider!==route.provider||event.model!==route.model||event.purpose!=='first_letter_generation')throw unavailable();
    const id=careerRecordId(event.callId);
    const saved=await this.db.withBoundedTransaction(async c=>{
     const row=await this.current(c,who,claim,signal);if(row.call_id)throw unavailable();
     const budget=await this.costs.reserveInTransaction(c,reserve,signal);
     if(budget.decision!=='ok')throw new ApiError(503,'FIRST_LETTER_BUDGET_UNAVAILABLE','The first-letter generation budget is unavailable.');
     await c.query("UPDATE platform_first_letter_stages SET call_id=$2,reservation_id=$3,call_status='prepared' WHERE id=$1",[row.id,id,reserveId]);
     await this.costs.markDispatchRiskInTransaction(c,budget.reservation.binding,signal);
     await this.current(c,who,claim,signal);return budget.reservation.binding;
    });callId=id;binding=saved;return;
   }
   if(event.type!=='finished'||!callId||!binding||finished||event.callId!==callId
    ||!['complete','failed','cancelled','interrupted'].includes(event.status)||event.status==='complete'&&(!admitted||!launched))throw unavailable();
   const usage=parseModelCallUsage(event.usage),status=event.status,structured=event.structuredOutcome;
   if(structured!==undefined&&(structured!=='invalid_format'||status!=='failed'||!admitted||!launched))throw unavailable();
   await this.db.withBoundedTransaction(async c=>{
    // Costs survive revoked identity, cancellation and expired execution leases.
    const user=await c.query('SELECT id FROM platform_users WHERE id=$1 FOR NO KEY UPDATE',[who.userId]);if(!user.rowCount)throw unavailable();
    const row=(await this.row(c,claim.row.task_id,who.userId,claim.row.stage as FirstLetterStageName)).rows[0];
    if(!row||row.id!==claim.row.id||row.call_id!==callId||row.reservation_id!==binding!.id||!['prepared','admitted'].includes(row.call_status??''))throw unavailable();
    await readFirstLetterStageRecord(c,this.config.dataCrypto,who.userId,row);
    let settlement:{costMicros:string;estimated:boolean}|null=null;
    if(launched)settlement=await this.costs.settleDispatchRiskInTransaction(c,binding!,usage);
    else{
     if(usage.status==='reported'&&(usage.inputTokens!==0||usage.outputTokens!==0))throw unavailable();
     await this.costs.releaseRiskInTransaction(c,binding!);
    }
    const now=stageTime((await c.query('SELECT clock_timestamp() AS now')).rows[0].now)!;
    const receipt:FirstLetterCallReceipt={callId:callId!,reservationId:binding!.id,...route,purpose:'first_letter_generation',
     status,admittedAt:stageTime(row.admitted_at),finishedAt:now,usage,structuredOutcome:structured??null,
     launched,costMicros:settlement?.costMicros??null,estimated:settlement?.estimated??null};
    const cipher=this.config.dataCrypto!.sealUtf8(JSON.stringify(receipt),stageBinding(row,'receipt_ciphertext'));
    await c.query('UPDATE platform_first_letter_stages SET call_status=$2,call_finished_at=$3,receipt_ciphertext=$4 WHERE id=$1',[row.id,status,now,cipher]);
   });finished=status;outcome=structured;
  };
  const admission:ProviderRequestAdmission=async<T>(launch:(signal:AbortSignal)=>Promise<T>,requestSignal?:AbortSignal):Promise<T>=>{
   if(!callId||!binding||launched||admitted||finished)throw unavailable();
   const io=AbortSignal.any([signal,...(requestSignal?[requestSignal]:[])]);let pendingResponse:Promise<T>|undefined;
   try{
    const result=await this.db.withBoundedTransaction(async c=>{
     const row=await this.current(c,who,claim,io);
     const current=resolveModelRoute(this.config,this.runtime,'first_letter_generation');
     if(current.provider!==route.provider||current.model!==route.model||row.call_id!==callId||row.call_status!=='prepared')throw unavailable();
     const decision=await this.costs.reserveInTransaction(c,reserve,io);if(decision.decision!=='ok')throw unavailable();
     await this.current(c,who,claim,io);await this.costs.admitInTransaction(c,binding!,io);
     await this.grant(c,who,claim,callId!,io);io.throwIfAborted();
     launched=true;pendingResponse=Promise.resolve(launch(io));pendingResponse.catch(()=>{});return {pendingResponse};
    });
    admitted=true;const response=await result.pendingResponse;io.throwIfAborted();return response;
   }catch(error){
    stop.abort(error);
    void pendingResponse?.then(value=>{if(value instanceof Response&&!value.body?.locked)return value.body?.cancel().catch(()=>{});}).catch(()=>{});
    throw error;
   }
  };
  try{
   let text='',error:unknown;
   try{for await(const event of this.runtime.streamChat(input,{signal,requestAdmission:admission,onModelCall,background:claim.request.background})){
    signal.throwIfAborted();
    if(event.type==='delta'){if(finished!=='complete'||!admitted)throw unavailable();text+=event.text;if(Buffer.byteLength(text)>16384)throw unavailable();}
    else if(event.type!=='usage')throw unavailable();
   }}catch(e){error=e;}
   signal.throwIfAborted();
   const invalidFormat=finished==='failed'&&outcome==='invalid_format'&&error&&typeof error==='object'&&'code' in error
    &&error.code==='PROVIDER_STRUCTURED_VALIDATION_FAILED'&&!text;
   if(!callId||!binding||!launched||!admitted||!finished||!invalidFormat&&(error||finished!=='complete'||!text))throw unavailable();
   return await this.db.withBoundedTransaction(async c=>{
    const row=await this.current(c,who,claim,signal);
    const record=await readFirstLetterStageRecord(c,this.config.dataCrypto,who.userId,row);
    if(!record.call?.receipt||record.call.id!==callId)throw unavailable();
    const cipher=invalidFormat?null:this.config.dataCrypto!.sealUtf8(JSON.stringify({preparationId:claim.prepared.preparationId,
     receiptDigest:stageDigest(this.config.dataCrypto!.openUtf8(row.receipt_ciphertext!,stageBinding(row,'receipt_ciphertext'))),text}),stageBinding(row,'output_ciphertext'));
    const saved=(await c.query<FirstLetterStageRow>(`UPDATE platform_first_letter_stages SET status=$2,output_ciphertext=$3,
     lease_token=NULL,runtime_lease_id=NULL,lease_until=NULL,finished_at=clock_timestamp() WHERE id=$1 AND lease_token=$4 RETURNING *`,
     [row.id,invalidFormat?'invalid_format':'draft_saved',cipher,claim.row.lease_token])).rows[0];
    if(!saved)throw lost();
    await c.query('DELETE FROM platform_runtime_leases WHERE id=$1 AND user_id=$2',[claim.row.runtime_lease_id,who.userId]);
    const result=await readFirstLetterStageRecord(c,this.config.dataCrypto,who.userId,saved);
    await authorizeFixedSession(c,who,signal);signal.throwIfAborted();return result;
   });
  }catch(error){
   await this.db.withBoundedTransaction(async c=>{
    await c.query('SELECT id FROM platform_users WHERE id=$1 FOR NO KEY UPDATE',[who.userId]);
    const changed=await c.query(`UPDATE platform_first_letter_stages SET status=CASE
     WHEN call_id IS NOT NULL AND(call_status IN ('prepared','admitted','complete')) THEN 'uncertain' ELSE 'failed' END,
     lease_token=NULL,runtime_lease_id=NULL,lease_until=NULL,finished_at=clock_timestamp()
     WHERE id=$1 AND user_id=$2 AND status='running' AND lease_token=$3 RETURNING id`,[claim.row.id,who.userId,claim.row.lease_token]);
    if(changed.rowCount)await c.query('DELETE FROM platform_runtime_leases WHERE id=$1 AND user_id=$2',[claim.row.runtime_lease_id,who.userId]);
   }).catch(()=>{});
   if(parent?.aborted)throw parent.reason;
   if(error instanceof ApiError&&['FIRST_LETTER_BUDGET_UNAVAILABLE','AUTH_REQUIRED','MODEL_ROUTE_UNAVAILABLE'].includes(error.code))throw error;
   throw unavailable();
  }finally{closing=true;clearInterval(heartbeat);clearTimeout(deadline);await renewal?.catch(()=>{});}
 }
 /** Classify expired/failed work and reconcile money. Never re-dispatch an
  * uncertain call or reset its one original-writing slot. */
 async recoverReview(value:FixedSessionContext,input:unknown,settings:FirstLetterCompositionSettings,signal?:AbortSignal){
  const who=session(value),pick=selection(input),saved=snapshotFirstLetterSettings(settings);
  const state=await this.readReview(who,pick,saved,signal);
  if(state.kind==='needs_stage'&&state.status!=='not_started')await this.recoverStage(who,pick,saved,state.stage,signal);
  return this.readReview(who,pick,saved,signal);
 }
 async recover(value:FixedSessionContext,input:unknown,settings:FirstLetterCompositionSettings,signal?:AbortSignal){
  return this.recoverStage(value,input,settings,'write_original',signal);
 }
 private async recoverStage(value:FixedSessionContext,input:unknown,settings:FirstLetterCompositionSettings,stage:FirstLetterStageName,signal?:AbortSignal){
  const who=session(value),pick=selection(input),saved=snapshotFirstLetterSettings(settings);
  return this.db.withBoundedTransaction(async c=>{
   await this.tasks.readInTransaction(c,who,pick,saved,signal);
   let row=(await this.row(c,pick.taskId,who.userId,stage)).rows[0];if(!row)return null;
   await readFirstLetterStageRecord(c,this.config.dataCrypto,who.userId,row);
   const expired=row.status==='running'&&(await c.query('SELECT $1::timestamptz<=clock_timestamp() AS expired',[row.lease_until])).rows[0].expired;
   if(expired){
    const oldLease=row.runtime_lease_id;
    row=(await c.query<FirstLetterStageRow>(`UPDATE platform_first_letter_stages SET status=CASE WHEN call_id IS NULL THEN 'failed' ELSE 'uncertain' END,
     lease_token=NULL,runtime_lease_id=NULL,lease_until=NULL,finished_at=clock_timestamp() WHERE id=$1 RETURNING *`,[row.id])).rows[0];
    await c.query('DELETE FROM platform_runtime_leases WHERE id=$1 AND user_id=$2',[oldLease,who.userId]);
   }
   if(row.status==='uncertain'||row.status==='failed')await this.costs.reconcileInTransaction(c,signal);
   const record=await readFirstLetterStageRecord(c,this.config.dataCrypto,who.userId,row);
   await authorizeFixedSession(c,who,signal);signal?.throwIfAborted();return record;
  });
 }
}
