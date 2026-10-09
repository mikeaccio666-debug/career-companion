import {readFirstLetterStageRecord,type FirstLetterStageRow} from './first-letter-stage-record.ts';
import {readFirstLetterTaskSnapshot,type FirstLetterTaskRow} from './first-letter-tasks.ts';
import type {PoolClient} from 'pg';
import {careerRecordId,careerRecordObject} from '@companion/platform-contracts';
import {authorizeFixedSession,type FixedSessionContext} from './auth.ts';
import type {PlatformConfig} from './config.ts';
import {readWelcomeSnapshot,type WelcomeRow} from './companion-welcome-snapshot.ts';
import {ApiError} from './errors.ts';

export const WELCOME_EXPORT_TABLES=Object.freeze(['platform_companion_welcome','platform_companion_welcome_operations','platform_first_letter_tasks','platform_first_letter_stages'] as const);
export type WelcomeExportSection='companionWelcomes'|'companionWelcomeOperations'|'firstLetterTasks'|'firstLetterStages';
/** Owner export reads retained snapshots, including non-current companions.
 * It does not reopen C1, advance onboarding or require active model consent. */
export class AccountWelcomeExport {
 private readonly crypto:PlatformConfig['dataCrypto'];
 constructor(config:Pick<PlatformConfig,'dataCrypto'>){this.crypto=config.dataCrypto;}
 async *exportInTransaction(client:PoolClient,value:FixedSessionContext,signal?:AbortSignal):AsyncGenerator<{section:WelcomeExportSection;record:unknown}>{
  const raw=careerRecordObject(value,['userId','tokenHash']),who=Object.freeze({userId:careerRecordId(raw.userId),tokenHash:raw.tokenHash as string});
  if(typeof who.tokenHash!=='string'||!/^[a-f0-9]{64}$/.test(who.tokenHash))throw new ApiError(401,'AUTH_REQUIRED','Sign in to continue.');
  await authorizeFixedSession(client,who,signal);let after:string|null=null;
  for(;;){
   signal?.throwIfAborted();
   const rows:WelcomeRow[]=(await client.query<WelcomeRow>(`SELECT * FROM platform_companion_welcome WHERE user_id=$1
    AND ($2::uuid IS NULL OR id>$2) ORDER BY id LIMIT 100`,[who.userId,after])).rows;
   for(const row of rows){
    signal?.throwIfAborted();const snapshot=await readWelcomeSnapshot(client,this.crypto,who.userId,row,false);signal?.throwIfAborted();
    yield {section:'companionWelcomes',record:{...snapshot.state,birthReceiptId:row.birth_receipt_id}};
    if(snapshot.operation)yield {section:'companionWelcomeOperations',record:snapshot.operation};
   }
   if(rows.length<100)break;after=rows.at(-1)!.id;
  }
  after=null;
  for(;;){
   signal?.throwIfAborted();
   const tasks:FirstLetterTaskRow[]=(await client.query<FirstLetterTaskRow>(
    'SELECT * FROM platform_first_letter_tasks WHERE user_id=$1 AND ($2::uuid IS NULL OR id>$2) ORDER BY id LIMIT 100',[who.userId,after])).rows;
   for(const row of tasks){
    signal?.throwIfAborted();
    const task=readFirstLetterTaskSnapshot(row,this.crypto,who.userId);
    // Export preparation metadata/configuration only. No prompt, source-body
    // duplication, ciphertext, credentials or execution permission is stored.
    yield {section:'firstLetterTasks',record:task};
   }
   if(tasks.length<100)break;after=tasks.at(-1)!.id;
  }
  after=null;
  for(;;){
   signal?.throwIfAborted();
   const stages:FirstLetterStageRow[]=(await client.query<FirstLetterStageRow>(
    'SELECT * FROM platform_first_letter_stages WHERE user_id=$1 AND ($2::uuid IS NULL OR id>$2) ORDER BY id LIMIT 100',[who.userId,after])).rows;
   for(const row of stages){signal?.throwIfAborted();yield {section:'firstLetterStages',record:await readFirstLetterStageRecord(client,this.crypto,who.userId,row)};}
   if(stages.length<100)break;after=stages.at(-1)!.id;
  }
  await authorizeFixedSession(client,who,signal);signal?.throwIfAborted();
 }
}
