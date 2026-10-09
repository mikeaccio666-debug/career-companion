import {Worker} from 'bullmq';
import {DatabaseError} from 'pg';
import {FirstLetterDispatch,FirstLetterNotificationReadUnavailable} from './first-letter-dispatch.ts';
import {firstLetterNotification} from './first-letter-request.ts';
import type {FirstLetterCompositionSettings} from './first-letter-composition.ts';
import {ApiError} from './errors.ts';
import {ProducerQueue,connectionFromUrl,QUEUE_DISPATCH_TIMEOUT_MS,QUEUE_RECONCILE_INTERVAL_MS} from './queue-connection.ts';
export const firstLetterQueueName=(name:string)=>name+'-first-letter';
/** Redis receives IDs only. The database request carries the original private
 * authority, and the stage service decides whether any call can execute. */
export class FirstLetterQueue{
 private producer?:ProducerQueue;private timer?:NodeJS.Timeout;private inFlight?:Promise<void>;private closed=false;
 constructor(readonly entry:FirstLetterDispatch){}
 get queue(){
  if(this.closed)throw new ApiError(503,'QUEUE_CLOSED','Letter notifications have stopped.');
  return this.producer??=new ProducerQueue(firstLetterQueueName(this.entry.config.queueName),this.entry.config.redisUrl);
 }
 dispatch():Promise<void>{
  if(this.closed)return Promise.reject(new ApiError(503,'QUEUE_CLOSED','Letter notifications have stopped.'));
  if(this.inFlight)return this.inFlight;
  const work=this.runDispatch();this.inFlight=work;
  void work.then(()=>{if(this.inFlight===work)this.inFlight=undefined;},()=>{if(this.inFlight===work)this.inFlight=undefined;});return work;
 }
 private async runDispatch(){
  const queue=this.queue;let expired=false,closing:Promise<void>|undefined;
  const stop=()=>{expired=true;closing??=queue.close();void closing.catch(()=>{});};
  const timer=setTimeout(stop,QUEUE_DISPATCH_TIMEOUT_MS);timer.unref();
  const check=()=>{if(expired||this.closed)throw new ApiError(503,'QUEUE_UNAVAILABLE','Letter notifications could not be confirmed.');};
  try{
   await this.entry.db.withBoundedTransaction(async c=>{
    await c.query("SET LOCAL lock_timeout='250ms'");
    if(!(await c.query('SELECT pg_try_advisory_xact_lock(hashtext($1)) AS acquired',['first-letter-outbox:'+this.entry.config.queueName])).rows[0].acquired)return;
    const rows=(await c.query<{request_id:string;task_id:string}>(`SELECT o.request_id,o.task_id FROM platform_first_letter_outbox o
     JOIN platform_first_letter_requests r ON r.id=o.request_id AND r.user_id=o.user_id AND r.task_id=o.task_id
     WHERE (o.held_reason IS NULL OR o.held_reason='configuration')
      AND (o.dispatched_at IS NULL OR o.dispatched_at<clock_timestamp()-$1::integer*interval '1 millisecond')
      AND NOT EXISTS(SELECT 1 FROM platform_first_letter_stages s WHERE s.task_id=o.task_id AND s.user_id=o.user_id
       AND s.status='running' AND s.lease_until>clock_timestamp())
     ORDER BY o.dispatched_at ASC NULLS FIRST,o.created_at,o.request_id LIMIT 25 FOR UPDATE OF o SKIP LOCKED`,[QUEUE_RECONCILE_INTERVAL_MS])).rows;
    for(const row of rows){
     check();const notification=firstLetterNotification({requestId:row.request_id,taskId:row.task_id});
     const existing=await queue.getJob(row.request_id);check();let add=!existing;
     if(existing){
      let actual;try{actual=firstLetterNotification(existing.data);}catch{}
      if(!actual||actual.requestId!==row.request_id||actual.taskId!==row.task_id||existing.name!=='first-letter'){
       await c.query("UPDATE platform_first_letter_outbox SET held_reason='storage',dispatched_at=clock_timestamp() WHERE request_id=$1 AND task_id=$2",[row.request_id,row.task_id]);continue;
      }
      const state=await existing.getState();check();
      if(['completed','failed','unknown'].includes(state)){await existing.remove();check();add=true;}
      else if(!['waiting','active','delayed','prioritized','waiting-children','paused'].includes(state))throw new ApiError(503,'QUEUE_UNAVAILABLE','Letter queue state is unavailable.');
     }
     if(add){await queue.add('first-letter',notification,{jobId:row.request_id,attempts:1,removeOnComplete:{age:86400},removeOnFail:{age:604800}});check();}
     await c.query('UPDATE platform_first_letter_outbox SET dispatched_at=clock_timestamp() WHERE request_id=$1 AND task_id=$2',[row.request_id,row.task_id]);
    }check();
   });
  }catch(error){
   stop();await closing;if(this.producer===queue)this.producer=undefined;
   throw error instanceof ApiError?error:new ApiError(503,'QUEUE_UNAVAILABLE','Saved letter requests remain in the database.');
  }finally{clearTimeout(timer);if(closing)await closing;}
 }
 start(){if(this.timer||this.closed)return;this.timer=setInterval(()=>void this.dispatch().catch(()=>{}),1000);this.timer.unref();}
 async close(){this.closed=true;if(this.timer)clearInterval(this.timer);this.timer=undefined;await this.producer?.close();await this.inFlight?.catch(()=>{});await this.producer?.close();}
}
function reason(error:unknown){
 if(!(error instanceof ApiError))return 'storage';
 if(['AUTH_REQUIRED','STUDENT_ACCOUNT_REQUIRED','EMAIL_VERIFICATION_REQUIRED','TERMS_CONFIRMATION_REQUIRED','LEGAL_DOCUMENTS_UNAVAILABLE'].includes(error.code))return 'authorization';
 if(['FIRST_LETTER_ACCEPTED_SOURCE_CHANGED','FIRST_LETTER_TASK_PREPARATION_CHANGED','FIRST_LETTER_TRIGGER_REQUIRED'].includes(error.code))return 'source_changed';
 if(['MODEL_ROUTE_UNAVAILABLE','FIRST_LETTER_BUDGET_UNAVAILABLE','FIRST_LETTER_RELEASE_UNAVAILABLE','FIRST_LETTER_SETTINGS_UNAVAILABLE'].includes(error.code))return 'configuration';
 return 'storage';
}
/** The settings callback is trusted server configuration, never Redis data. */
export function createFirstLetterWorker(entry:FirstLetterDispatch,settings?:()=>FirstLetterCompositionSettings){
 const worker=new Worker(firstLetterQueueName(entry.config.queueName),async job=>{
  let notification;try{notification=firstLetterNotification(job.data);}catch{throw Error('Letter notification could not be verified.');}
  if(job.id!==notification.requestId||job.name!=='first-letter')throw Error('Letter notification could not be verified.');
  let held:string|null=null;
  try{
   const outcome=await entry.executeNotification(notification,settings?.());
   if(outcome.kind!=='waiting')held='terminal';
  }catch(error){
   if(error instanceof FirstLetterNotificationReadUnavailable||error instanceof DatabaseError&&['55P03','40001','40P01'].includes(error.code??''))
    throw Error('Letter notification is waiting for database contention to clear.');
   held=reason(error);
  }
  await entry.db.withBoundedTransaction(async c=>{
   await c.query(`UPDATE platform_first_letter_outbox o SET held_reason=$3 FROM platform_first_letter_requests r
    WHERE r.id=o.request_id AND r.user_id=o.user_id AND r.task_id=o.task_id AND r.id=$1 AND r.task_id=$2`,
    [notification.requestId,notification.taskId,held]);
  });
 },{connection:connectionFromUrl(entry.config.redisUrl),concurrency:2});
 worker.on('error',()=>process.stderr.write('First-letter worker connection interrupted; waiting for recovery.\n'));
 return worker;
}
