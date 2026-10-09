import type {PoolClient} from 'pg';
import type {PlatformProviderRuntime} from '@companion/platform-contracts';
import type {FirstLetterSettings} from './first-letter-settings.ts';
import {readFirstLetterRequestStatus} from './first-letter-request-status.ts';
import {resolveModelRoute} from './model-routing.ts';
import type {FirstLetterProgress as Progress} from '@companion/platform-contracts';
import {parseFirstLetterProgress} from '@companion/platform-contracts';
import {authorizeFixedSession,type FixedSessionContext} from './auth.ts';
import type {Database} from './database.ts';
import type {PlatformConfig} from './config.ts';
import type {FirstLetterSources} from './first-letter-sources.ts';
import {readFirstLetterTaskSnapshot,type FirstLetterTaskRow} from './first-letter-tasks.ts';
import type {FirstLetterGeneration} from './first-letter-generation.ts';
import {readFirstLetterStageRecord,type FirstLetterStageRow} from './first-letter-stage-record.ts';
import {ApiError} from './errors.ts';
const unavailable=()=>new ApiError(503,'FIRST_LETTER_PROGRESS_UNAVAILABLE','The saved letter progress could not be confirmed.');
/** Authenticated metadata only: never launches, recovers, refreshes preparation,
 * returns an unreviewed body, or advances welcome. No current model is needed. */
export class FirstLetterProgressService{
 constructor(private readonly db:Database,private readonly config:Pick<PlatformConfig,'dataCrypto'>,
  private readonly sources:Pick<FirstLetterSources,'readInTransaction'>,
  private readonly generation:Pick<FirstLetterGeneration,'readReviewInTransaction'>,
  private readonly execution?:{settings:Pick<FirstLetterSettings,'readInTransaction'>;
   config:Pick<PlatformConfig,'modelRoutes'>;runtime:Pick<PlatformProviderRuntime,'capabilities'>}){}
 private async waitingState(c:PoolClient,who:FixedSessionContext,state:Progress['state'],
  accepted:NonNullable<Awaited<ReturnType<typeof readFirstLetterRequestStatus>>>,signal?:AbortSignal):Promise<Progress['state']>{
  const {request,outbox}=accepted;
  if(outbox.hold==='storage'||outbox.hold==='terminal')return 'interrupted';
  const authorized=(await c.query(`SELECT 1 FROM platform_sessions s JOIN platform_users u ON u.id=s.user_id
   WHERE s.user_id=$1 AND s.token_hash=$2 AND s.auth_version=u.auth_version AND u.auth_version=$3
    AND s.expires_at>clock_timestamp()`,[request.ownerId,request.tokenHash,request.authVersion])).rowCount===1;
  if(!authorized||outbox.hold==='authorization')return 'authorization_required';
  if(this.execution){
   try{
    const current=await this.execution.settings.readInTransaction(c,who,signal);
    if(JSON.stringify(current)!==JSON.stringify(request.settings))return 'settings_changed';
    const route=resolveModelRoute(this.execution.config,this.execution.runtime,'first_letter_generation');
    if(route.provider!==request.provider||route.model!==request.model)return 'settings_changed';
   }catch(error){
    signal?.throwIfAborted();
    if(error instanceof ApiError&&['FIRST_LETTER_RELEASE_UNAVAILABLE','MODEL_ROUTE_UNAVAILABLE'].includes(error.code))return 'service_unavailable';
    if(error instanceof ApiError&&error.code==='DAILY_SETTINGS_REQUIRED')return 'settings_changed';
    throw error;
   }
  }
  if(outbox.hold==='configuration')return 'service_unavailable';
  if(outbox.hold==='source_changed')return 'settings_changed';
  return state==='prepared'?'queued':state;
 }
 async read(who:FixedSessionContext,signal?:AbortSignal):Promise<Readonly<Progress>>{
  return this.db.withBoundedTransaction(async c=>{
   const source=await this.sources.readInTransaction(c,who,signal);
   const capturedAt=(await c.query('SELECT clock_timestamp() AS now')).rows[0].now.toISOString();
   const tasks=(await c.query<FirstLetterTaskRow>('SELECT * FROM platform_first_letter_tasks WHERE user_id=$1 AND welcome_id=$2 FOR SHARE',[source.ownerId,source.trigger.welcomeId])).rows;
   if(tasks.length>1)throw unavailable();
   let state:Progress['state']='not_started';
   if(tasks.length){
    const task=readFirstLetterTaskSnapshot(tasks[0],this.config.dataCrypto,source.ownerId);
    if(task.companionId!==source.companionId||task.conversationId!==source.conversationId
     ||task.birthReceiptId!==source.trigger.birthReceiptId||task.welcomeId!==source.trigger.welcomeId)throw unavailable();
    const accepted=await readFirstLetterRequestStatus(c,this.config.dataCrypto,task);
    const rows=(await c.query<FirstLetterStageRow>(`SELECT * FROM platform_first_letter_stages WHERE user_id=$1 AND task_id=$2
     ORDER BY CASE stage WHEN 'write_original' THEN 0 WHEN 'review_original' THEN 1 WHEN 'rewrite' THEN 2 ELSE 3 END FOR SHARE`,
     [source.ownerId,task.taskId])).rows;
    if(rows.length>4)throw unavailable();
    const records=[];
    for(const row of rows)records.push(await readFirstLetterStageRecord(c,this.config.dataCrypto,source.ownerId,row));
    if(task.sourceId!==source.sourceId)state='interrupted';
    else if(!records.length)state='prepared';
    else{
     const first=records[0];if(first.stage!=='write_original')throw unavailable();
     if(!['draft_saved','invalid_format'].includes(first.status)){
      if(records.length!==1)throw unavailable();
      state=first.status==='running'&&rows[0].lease_until&&rows[0].lease_until.toISOString()>capturedAt?'writing':'interrupted';
     }else{
      const review=await this.generation.readReviewInTransaction(c,who,{taskId:task.taskId},task.settings,signal);
      if(review.kind==='reviewed_draft')state='reviewed';
      else if(review.kind==='failed')state='interrupted';
      else{
       const latest=rows.at(-1)!;
       state=review.status==='not_started'?'draft_saved':
        review.status==='running'&&latest.lease_until&&latest.lease_until.toISOString()>capturedAt?'checking':'interrupted';
      }
     }
    }
    // A saved terminal result or a live lease outranks old notification metadata.
    // Paid/uncertain failures cannot be relabeled as ordinary queued work.
    if(accepted&&task.sourceId===source.sourceId&&!['reviewed','writing','checking'].includes(state)
     &&!records.some(r=>r.status==='uncertain'||r.status==='failed'&&r.call))
     state=await this.waitingState(c,who,state,accepted,signal);

   }
   await authorizeFixedSession(c,who,signal);signal?.throwIfAborted();
   return parseFirstLetterProgress({ownerId:source.ownerId,companionId:source.companionId,welcomeId:source.trigger.welcomeId,state,capturedAt,delivered:false});
  });
 }
}
