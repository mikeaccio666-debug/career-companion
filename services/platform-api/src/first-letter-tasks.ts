import {randomUUID} from 'node:crypto';
import type {PoolClient} from 'pg';
import {careerRecordId,careerRecordObject} from '@companion/platform-contracts';
import {authorizeFixedSession,type FixedSessionContext} from './auth.ts';
import type {Database} from './database.ts';
import type {PlatformConfig} from './config.ts';
import type {FirstLetterSources,FirstLetterSourceSnapshot} from './first-letter-sources.ts';
import {composeFirstLetter,snapshotFirstLetterSettings,type FirstLetterCompositionSettings,type FirstLetterPreparation} from './first-letter-composition.ts';
import {ApiError} from './errors.ts';

export interface FirstLetterTaskRow{
 id:string;user_id:string;companion_id:string;conversation_id:string;welcome_id:string;birth_receipt_id:string;
 source_id:string;preparation_id:string;policy_revision:number;status:string;preparation_ciphertext:Buffer;created_at:Date;
}
export interface FirstLetterTaskSnapshot{
 readonly schemaVersion:1;readonly taskId:string;readonly ownerId:string;readonly companionId:string;readonly conversationId:string;
 readonly welcomeId:string;readonly birthReceiptId:string;readonly sourceId:string;readonly preparationId:string;
 readonly policyRevision:1;readonly status:'prepared';readonly createdAt:string;
 readonly settings:Readonly<FirstLetterCompositionSettings>;
}
const unavailable=()=>new ApiError(503,'FIRST_LETTER_TASK_UNAVAILABLE','The saved first-letter task could not be confirmed.');
const changed=()=>new ApiError(409,'FIRST_LETTER_TASK_PREPARATION_CHANGED','The saved first-letter task needs a new preparation before execution.');
function fixed(value:FixedSessionContext):FixedSessionContext{
 try{const r=careerRecordObject(value,['userId','tokenHash']);
  if(typeof r.tokenHash!=='string'||!/^[a-f0-9]{64}$/.test(r.tokenHash)||r.tokenHash.length!==64)throw unavailable();
  return Object.freeze({userId:careerRecordId(r.userId),tokenHash:r.tokenHash});
 }catch{throw new ApiError(401,'AUTH_REQUIRED','Sign in to continue.');}
}
function coordinate(value:unknown,prefix:string):string{
 if(typeof value!=='string'||value.length!==prefix.length+64||!value.startsWith(prefix)||!/^[a-f0-9]{64}$/.test(value.slice(prefix.length)))throw unavailable();
 return value;
}
function stamp(value:unknown):string{
 if(!(value instanceof Date)||!Number.isFinite(value.getTime()))throw unavailable();return value.toISOString();
}
const binding=(ownerId:string,id:string)=>({table:'platform_first_letter_tasks',column:'preparation_ciphertext',
 rowId:id,ownerId,revision:1});
/** Retained metadata decoder for live task readers and authenticated owner export.
 * No current legal/provider/active-companion requirement is imposed by this
 * decoder. It does not establish current source or execution authority. */
export function readFirstLetterTaskSnapshot(row:FirstLetterTaskRow,crypto:PlatformConfig['dataCrypto'],ownerId:string):Readonly<FirstLetterTaskSnapshot>{
 try{
  if(!crypto||row.user_id!==ownerId)throw unavailable();
  const owner=careerRecordId(ownerId),id=careerRecordId(row.id);
  const raw=crypto.openUtf8(row.preparation_ciphertext,binding(owner,id));
  const payload=careerRecordObject(JSON.parse(raw),['schemaVersion','taskId','ownerId','companionId','conversationId','welcomeId',
   'birthReceiptId','sourceId','preparationId','policyRevision','status','createdAt','settings']);
  const result:Readonly<FirstLetterTaskSnapshot>=Object.freeze({
   schemaVersion:1,taskId:id,ownerId:owner,companionId:careerRecordId(row.companion_id),conversationId:careerRecordId(row.conversation_id),
   welcomeId:careerRecordId(row.welcome_id),birthReceiptId:careerRecordId(row.birth_receipt_id),
   sourceId:coordinate(row.source_id,'first_letter_source_'),preparationId:coordinate(row.preparation_id,'first_letter_preparation_'),
   policyRevision:1,status:'prepared',createdAt:stamp(row.created_at),settings:snapshotFirstLetterSettings(payload.settings as FirstLetterCompositionSettings)
  });
  if(row.policy_revision!==1||row.status!=='prepared'||JSON.stringify(result)!==raw)throw unavailable();
  return result;
 }catch{throw unavailable();}
}
function match(task:FirstLetterTaskSnapshot,source:FirstLetterSourceSnapshot,prepared:FirstLetterPreparation){
 if(task.ownerId!==source.ownerId||task.companionId!==source.companionId||task.conversationId!==source.conversationId
  ||task.welcomeId!==source.trigger.welcomeId||task.birthReceiptId!==source.trigger.birthReceiptId)throw unavailable();
 if(task.sourceId!==source.sourceId||task.preparationId!==prepared.preparationId||task.policyRevision!==prepared.policyRevision)throw changed();
}
/** A durable preparation identity, not a running job. All inputs are internal:
 * no client may supply a release roster, date, facts or execution callbacks.
 * Current admission/source checks run again on every live read. */
export class FirstLetterTasks{
 private readonly crypto:PlatformConfig['dataCrypto'];
 constructor(private readonly db:Database,config:Pick<PlatformConfig,'dataCrypto'>,
  private readonly sources:Pick<FirstLetterSources,'readInTransaction'>){this.crypto=config.dataCrypto;}
 private async complete(c:PoolClient,s:FixedSessionContext,source:FirstLetterSourceSnapshot,prepared:FirstLetterPreparation,
  row:FirstLetterTaskRow,signal?:AbortSignal){
  const task=readFirstLetterTaskSnapshot(row,this.crypto,s.userId);match(task,source,prepared);
  await authorizeFixedSession(c,s,signal);signal?.throwIfAborted();
  return Object.freeze({task,preparation:prepared});
 }
 async prepare(value:FixedSessionContext,settings:FirstLetterCompositionSettings,signal?:AbortSignal){
  const s=fixed(value),savedSettings=snapshotFirstLetterSettings(settings);
  return this.db.withBoundedTransaction(async c=>{
   const source=await this.sources.readInTransaction(c,s,signal),prepared=composeFirstLetter(source,savedSettings);
   if(!this.crypto)throw unavailable();
   // Source reader already holds the same owner lock as welcome/source writers.
   const existing=(await c.query<FirstLetterTaskRow>('SELECT * FROM platform_first_letter_tasks WHERE user_id=$1 AND welcome_id=$2 FOR UPDATE',
    [s.userId,source.trigger.welcomeId])).rows;
   if(existing.length>1)throw unavailable();
   if(existing.length)return this.complete(c,s,source,prepared,existing[0],signal);
   const taskId=randomUUID(),createdAt=stamp((await c.query('SELECT clock_timestamp() AS now')).rows[0].now);
   const snapshot:FirstLetterTaskSnapshot={schemaVersion:1,taskId,ownerId:s.userId,companionId:source.companionId,
    conversationId:source.conversationId,welcomeId:source.trigger.welcomeId,birthReceiptId:source.trigger.birthReceiptId,
    sourceId:source.sourceId,preparationId:prepared.preparationId,policyRevision:1,status:'prepared',createdAt,settings:savedSettings};
   const cipher=this.crypto.sealUtf8(JSON.stringify(snapshot),binding(s.userId,taskId));
   signal?.throwIfAborted();
   const row=(await c.query<FirstLetterTaskRow>(`INSERT INTO platform_first_letter_tasks
    (id,user_id,companion_id,conversation_id,welcome_id,birth_receipt_id,source_id,preparation_id,policy_revision,status,preparation_ciphertext,created_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,1,'prepared',$9,$10) RETURNING *`,[taskId,s.userId,source.companionId,source.conversationId,
    source.trigger.welcomeId,source.trigger.birthReceiptId,source.sourceId,prepared.preparationId,cipher,createdAt])).rows[0];
   return this.complete(c,s,source,prepared,row,signal);
  });
 }
 async read(value:FixedSessionContext,selection:unknown,settings:FirstLetterCompositionSettings,signal?:AbortSignal){
  const s=fixed(value),savedSettings=snapshotFirstLetterSettings(settings);
  let taskId:string;try{taskId=careerRecordId(careerRecordObject(selection,['taskId']).taskId);}
  catch{throw new ApiError(400,'FIRST_LETTER_TASK_INPUT_INVALID','Use the saved task identifier.');}
  return this.db.withBoundedTransaction(async c=>{
   const source=await this.sources.readInTransaction(c,s,signal),prepared=composeFirstLetter(source,savedSettings);
   const rows=(await c.query<FirstLetterTaskRow>('SELECT * FROM platform_first_letter_tasks WHERE user_id=$1 AND id=$2 FOR SHARE',[s.userId,taskId])).rows;
   if(!rows.length)throw new ApiError(404,'NOT_FOUND','The first-letter task was not found.');
   if(rows.length!==1)throw unavailable();
   return this.complete(c,s,source,prepared,rows[0],signal);
  });
 }
}
