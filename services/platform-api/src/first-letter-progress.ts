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
  private readonly generation:Pick<FirstLetterGeneration,'readReviewInTransaction'>){}
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

   }
   await authorizeFixedSession(c,who,signal);signal?.throwIfAborted();
   return parseFirstLetterProgress({ownerId:source.ownerId,companionId:source.companionId,welcomeId:source.trigger.welcomeId,state,capturedAt,delivered:false});
  });
 }
}
