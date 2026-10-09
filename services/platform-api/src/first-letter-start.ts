import {careerRecordId,careerRecordObject,parseCompanionWelcomeChoice} from '@companion/platform-contracts';
import type {Database} from './database.ts';
import {authorizeFixedSession,type FixedSessionContext} from './auth.ts';
import type {PlatformConfig} from './config.ts';
import type {CompanionWelcomeService} from './companion-welcome.ts';
import type {FirstLetterTasks} from './first-letter-tasks.ts';
import {readFirstLetterTaskSnapshot,type FirstLetterTaskRow} from './first-letter-tasks.ts';
import type {FirstLetterDispatch} from './first-letter-dispatch.ts';
import type {FirstLetterSettings} from './first-letter-settings.ts';
import {decodeFirstLetterRequest,type FirstLetterRequestRow} from './first-letter-request.ts';
import {ApiError} from './errors.ts';
const unavailable=()=>new ApiError(503,'FIRST_LETTER_START_UNAVAILABLE','The accepted first-letter path could not be confirmed.');
/** C1 choice, preparation and execution intent commit together. Redis is a
 * later notification, so a queue outage cannot strand a committed choice. */
export class FirstLetterStart{
 constructor(private readonly db:Database,private readonly config:Pick<PlatformConfig,'dataCrypto'>,
  private readonly welcome:Pick<CompanionWelcomeService,'chooseInTransaction'>,
  private readonly settings:Pick<FirstLetterSettings,'readInTransaction'>,
  private readonly tasks:Pick<FirstLetterTasks,'prepareInTransaction'>,
  private readonly dispatch:Pick<FirstLetterDispatch,'acceptInTransaction'>){}
 async choose(value:FixedSessionContext,body:unknown,signal?:AbortSignal){
  let who:FixedSessionContext;
  try{const s=careerRecordObject(value,['userId','tokenHash']);
   if(typeof s.tokenHash!=='string'||!/^[a-f0-9]{64}$/.test(s.tokenHash)||s.tokenHash.length!==64)throw Error();
   who=Object.freeze({userId:careerRecordId(s.userId),tokenHash:s.tokenHash});
  }catch{throw new ApiError(401,'AUTH_REQUIRED','Sign in to continue.');}
  let command;
  try{command=parseCompanionWelcomeChoice(body);}catch{throw new ApiError(400,'INVALID_INPUT','Choose a documented next path.');}
  return this.db.withBoundedTransaction(async c=>{
   const choice=await this.welcome.chooseInTransaction(c,who,command,signal);
   if(choice.state.choice==='direct_letter'){
    if(choice.operation.replayed){
     // A lost HTTP response is observed without renewing the original session,
     // changing its date, or requiring today's model configuration.
     const row=(await c.query<FirstLetterRequestRow>('SELECT * FROM platform_first_letter_requests WHERE id=$1 AND user_id=$2 FOR SHARE',
      [choice.operation.id,who.userId])).rows[0];
     if(!row)throw unavailable();
     const saved=decodeFirstLetterRequest(row,this.config.dataCrypto);
     const taskRow=(await c.query<FirstLetterTaskRow>('SELECT * FROM platform_first_letter_tasks WHERE id=$1 AND user_id=$2 FOR SHARE',
      [saved.taskId,who.userId])).rows[0];
     if(!taskRow)throw unavailable();
     const task=readFirstLetterTaskSnapshot(taskRow,this.config.dataCrypto,who.userId);
     if(saved.welcomeId!==choice.state.id||saved.companionId!==choice.state.companionId||task.welcomeId!==saved.welcomeId
      ||task.companionId!==saved.companionId||task.sourceId!==saved.sourceId||task.preparationId!==saved.preparationId
      ||JSON.stringify(task.settings)!==JSON.stringify(saved.settings))throw unavailable();
     if((await c.query('SELECT 1 FROM platform_first_letter_outbox WHERE request_id=$1 AND user_id=$2 AND task_id=$3',
      [saved.requestId,who.userId,saved.taskId])).rowCount!==1)throw unavailable();
    }else{
     const settings=await this.settings.readInTransaction(c,who,signal);
     const prepared=await this.tasks.prepareInTransaction(c,who,settings,signal);
     if(prepared.task.welcomeId!==choice.state.id||prepared.task.companionId!==choice.state.companionId)throw unavailable();
     await this.dispatch.acceptInTransaction(c,who,{operationId:choice.operation.id,taskId:prepared.task.taskId,
      expectedPreparationId:prepared.task.preparationId},settings,signal);
    }
   }
   await authorizeFixedSession(c,who,signal);signal?.throwIfAborted();return choice;
  });
 }
}
