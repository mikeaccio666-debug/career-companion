import type { PoolClient } from 'pg';
import { careerRecordObject,careerRecordId,parseMentorRatingCommand,parseMentorRating,type MentorIntent,type MentorRating } from '@companion/platform-contracts';
import type { Database } from './database.ts';
import type { PlatformConfig } from './config.ts';
import type { LegalBundle } from './legal-documents.ts';
import type { FixedSessionContext } from './auth.ts';
import type { MentorIntents } from './mentor-intents.ts';
import { OnboardingStorage } from './onboarding-storage.ts';
import { MentorLedgerCrypto,mentorLedgerDigest as digest } from './mentor-ledger-crypto.ts';
import { ApiError } from './errors.ts';
const missing=()=>new ApiError(404,'NOT_FOUND','没有找到这次会后反馈。');
const unavailable=()=>new ApiError(503,'MENTOR_RATING_STORAGE_UNAVAILABLE','暂时无法确认会后反馈，请重新读取。');
export interface MentorRatingRow {session_id:string;user_id:string;org_id:string;operation_id:string;created_at:Date;payload_ciphertext:Buffer;}
export function decodeMentorRating(crypto:MentorLedgerCrypto,row:MentorRatingRow,session:MentorIntent):Readonly<MentorRating>{
  try{const p=careerRecordObject(crypto.open('mentor_rating',row.session_id,row.user_id,1,row.payload_ciphertext),['schemaVersion','organizationId','acceptedAuthVersion','commandDigest','rating']);
   const rating=parseMentorRating(p.rating);
   const command=rating.action==='skip'?parseMentorRatingCommand({operationId:rating.operationId,action:'skip'}):parseMentorRatingCommand({operationId:rating.operationId,action:'rate',score:rating.score,comment:rating.comment});
   if(p.schemaVersion!==1||p.organizationId!==row.org_id||row.org_id!==session.organizationId||rating.sessionId!==row.session_id||rating.sessionId!==session.id||
    rating.ownerId!==row.user_id||rating.ownerId!==session.ownerId||rating.operationId!==row.operation_id||rating.createdAt!==row.created_at.toISOString()||
    rating.createdAt<session.updatedAt||session.status!=='completed'||typeof p.acceptedAuthVersion!=='string'||!/^\d+$/.test(p.acceptedAuthVersion)||p.commandDigest!==digest(command))throw Error();
   return rating;
  }catch{throw unavailable();}
 }

/** A single owner-authored private decision; it neither changes fulfillment nor becomes shared memory/evidence. */
export class MentorRatings {
 private readonly store:OnboardingStorage;private readonly crypto:MentorLedgerCrypto;
 constructor(private readonly db:Database,config:Pick<PlatformConfig,'dataCrypto'|'requireVerifiedEmail'>,legal:LegalBundle|null,
  private readonly intents:Pick<MentorIntents,'ownedInTransaction'>){this.store=new OnboardingStorage(config,legal);this.crypto=new MentorLedgerCrypto(config);}
 private fixed(input:FixedSessionContext){
  try{const v=careerRecordObject(input,['userId','tokenHash']);if(typeof v.tokenHash!=='string'||!/^[0-9a-f]{64}$/.test(v.tokenHash))throw Error();
   return Object.freeze({userId:careerRecordId(v.userId),tokenHash:v.tokenHash});}catch{throw new ApiError(401,'AUTH_REQUIRED','请重新登录。');}
 }
 private decode(row:MentorRatingRow,session:MentorIntent):Readonly<MentorRating>{return decodeMentorRating(this.crypto,row,session);}
 private async current(c:PoolClient,owner:string,session:MentorIntent){
  const row=(await c.query<MentorRatingRow>('SELECT * FROM platform_mentor_ratings WHERE user_id=$1 AND session_id=$2 FOR SHARE',[owner,session.id])).rows[0];
  return row?this.decode(row,session):null;
 }
 async get(input:FixedSessionContext,id:string,signal?:AbortSignal){
  const context=this.fixed(input),key=careerRecordId(id);return this.db.withBoundedTransaction(async c=>{
   await this.store.authorizeSession(c,context,signal);const session=await this.intents.ownedInTransaction(c,context,key,signal);
   if(session.status!=='completed')throw new ApiError(409,'MENTOR_RATING_UNAVAILABLE','实际完成服务后才可以留下反馈。');
   const rating=await this.current(c,context.userId,session);await this.store.authorizeSession(c,context,signal);signal?.throwIfAborted();return Object.freeze({session,rating});
  });
 }
 async decide(input:FixedSessionContext,id:string,value:unknown,signal?:AbortSignal){
  const context=this.fixed(input),key=careerRecordId(id);let command;try{command=parseMentorRatingCommand(value);}catch{throw new ApiError(400,'MENTOR_RATING_INPUT_INVALID','请选择 1–5 分或跳过；一句话反馈可以留空。');}
  return this.db.withBoundedTransaction(async c=>{
   const authVersion=await this.store.authorizeSession(c,context,signal);const session=await this.intents.ownedInTransaction(c,context,key,signal);
   if(session.status!=='completed')throw new ApiError(409,'MENTOR_RATING_UNAVAILABLE','实际完成服务后才可以留下反馈。');
   const original=(await c.query<MentorRatingRow>('SELECT * FROM platform_mentor_ratings WHERE user_id=$1 AND operation_id=$2 FOR SHARE',[context.userId,command.operationId])).rows[0];
   if(original&&original.session_id!==key)throw new ApiError(409,'MENTOR_RATING_OPERATION_CONFLICT','操作编号已用于另一场服务。');
   const current=await this.current(c,context.userId,session);
   if(current){
    const previous=current.action==='skip'?{operationId:current.operationId,action:'skip'}:{operationId:current.operationId,action:'rate',score:current.score,comment:current.comment};
    if(current.operationId!==command.operationId||digest(previous)!==digest(command))throw new ApiError(409,'MENTOR_RATING_ALREADY_RECORDED','这次反馈已记录，不会再次邀请你评分。');
    await this.store.authorizeSession(c,context,signal);signal?.throwIfAborted();return Object.freeze({session,rating:current,operation:Object.freeze({id:command.operationId,replayed:true})});
   }
   const at=(await c.query('SELECT clock_timestamp() AS at')).rows[0].at.toISOString();
   if(at<session.updatedAt)throw unavailable();
   const rating=parseMentorRating({sessionId:key,ownerId:context.userId,operationId:command.operationId,action:command.action,
    score:command.action==='rate'?command.score:null,comment:command.action==='rate'?command.comment:null,createdAt:at});
   const proof={schemaVersion:1,organizationId:session.organizationId,acceptedAuthVersion:authVersion,commandDigest:digest(command),rating};
   await c.query('INSERT INTO platform_mentor_ratings(session_id,user_id,org_id,operation_id,created_at,payload_ciphertext) VALUES($1,$2,$3,$4,$5,$6)',
    [key,context.userId,session.organizationId,command.operationId,at,this.crypto.seal('mentor_rating',key,context.userId,1,proof)]);
   await this.store.authorizeSession(c,context,signal);signal?.throwIfAborted();return Object.freeze({session,rating,operation:Object.freeze({id:command.operationId,replayed:false})});
  });
 }
 async observe(input:FixedSessionContext,id:string,operationId:string,signal?:AbortSignal){
  const key=careerRecordId(operationId),result=await this.get(input,id,signal);
  if(!result.rating||result.rating.operationId!==key)throw missing();return Object.freeze({...result,operation:Object.freeze({id:key,replayed:true})});
 }
}
