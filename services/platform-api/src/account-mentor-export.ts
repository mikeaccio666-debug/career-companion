import {AccountMentorLedgerExport,MENTOR_LEDGER_EXPORT_TABLES,type MentorLedgerExportSection} from './account-mentor-ledger-export.ts';
import type {PoolClient} from 'pg';
import {careerRecordId as id,careerRecordObject as object,parseMentorIntentCommand,parseMentorMatchCommand,parseMentorSchedulingCommand,type MentorIntent} from '@companion/platform-contracts';
import {authorizeFixedSession,type FixedSessionContext} from './auth.ts';
import type {PlatformConfig} from './config.ts';
import {MentorIntentHistory,type SessionRow,type OperationRow,type Receipt} from './mentor-intent-history.ts';
import {decodeMentorRating,type MentorRatingRow} from './mentor-ratings.ts';
import {MentorLedgerCrypto} from './mentor-ledger-crypto.ts';
import {ApiError} from './errors.ts';

export const MENTOR_EXPORT_TABLES=Object.freeze(['platform_mentor_sessions','platform_mentor_intent_operations','platform_mentor_ratings',...MENTOR_LEDGER_EXPORT_TABLES] as const);
export type MentorExportSection='mentorSessions'|'mentorIntentOperations'|'mentorRatings'|MentorLedgerExportSection;
const unavailable=()=>new ApiError(503,'ACCOUNT_MENTOR_EXPORT_UNAVAILABLE','The saved mentor service history could not be confirmed.');
function sessionRecord(r:MentorIntent){
 const a=r.assignment;
 return {id:r.id,ownerId:r.ownerId,organizationId:r.organizationId,offerId:r.offerId,offerRevision:r.offerRevision,kind:r.kind,durationMin:r.durationMin,
  contactName:r.contactName,contactEmail:r.contactEmail,intentNote:r.intentNote,status:r.status,orderId:r.orderId,
  assignment:a?{mentorDisplayName:a.mentorDisplayName,startsAt:a.startsAt,endsAt:a.endsAt,timeZone:a.timeZone,matchedAt:a.matchedAt}:null,
  scheduled:r.scheduled?{confirmedAt:r.scheduled.confirmedAt,meetingUrl:r.scheduled.meetingUrl}:null,completedAt:r.completedAt??null,
  privacyVersion:r.privacyVersion,visibilityConfirmedAt:r.visibilityConfirmedAt,revision:r.revision,lastOperationId:r.lastOperationId,createdAt:r.createdAt,updatedAt:r.updatedAt};
}
function operationRecord(r:Receipt){
 let command:unknown;
 if(r.action==='create')command=parseMentorIntentCommand(r.command);
 else if(r.action==='cancel')command=object(r.command,['operationId','expectedRevision']);
 else if(r.action==='match'){
  const c=parseMentorMatchCommand(r.command);command={operationId:c.operationId,sessionId:c.sessionId,expectedRevision:c.expectedRevision,priceCents:c.priceCents};
 }else{
  const c=parseMentorSchedulingCommand(r.command);
  command={action:c.action,operationId:c.operationId,sessionId:c.sessionId,expectedRevision:c.expectedRevision,
   ...(c.action==='schedule'?{confirmedAt:c.confirmedAt,meetingUrl:c.meetingUrl}:c.action==='complete'?{completedAt:c.completedAt}:{occurredAt:c.occurredAt})};
 }
 return {ownerId:r.ownerId,organizationId:r.orgId,operationId:r.operationId,sessionId:r.sessionId,action:r.action,appliedRevision:r.appliedRevision,
  command,acceptedOffer:r.acceptedOffer,createdAt:r.createdAt};
}
/** Owner history, independent of current catalog/mentor availability and model
 * consent. Historical integrity readers are shared with normal fulfillment;
 * their internal staff proofs, capacity coordinates and attribution codes are not serialized. */
export class AccountMentorExport {
 private readonly ledgers:AccountMentorLedgerExport;private readonly history:MentorIntentHistory;private readonly crypto:MentorLedgerCrypto;
 constructor(config:Pick<PlatformConfig,'dataCrypto'>){this.ledgers=new AccountMentorLedgerExport(config);this.history=new MentorIntentHistory(config);this.crypto=new MentorLedgerCrypto(config);}
 async *exportInTransaction(client:PoolClient,value:FixedSessionContext,signal?:AbortSignal):AsyncGenerator<{section:MentorExportSection;record:unknown}>{
  const v=object(value,['userId','tokenHash']),who=Object.freeze({userId:id(v.userId),tokenHash:v.tokenHash as string});
  if(typeof who.tokenHash!=='string'||!/^[0-9a-f]{64}$/.test(who.tokenHash))throw new ApiError(401,'AUTH_REQUIRED','Sign in to continue.');
  await authorizeFixedSession(client,who,signal);
  try{
   const sessions=new Map<string,MentorIntent>();let after:string|null=null;
   for(;;){
    signal?.throwIfAborted();const rows=(await client.query<SessionRow>(`SELECT id,user_id,org_id,offer_id,offer_revision,kind,duration_min,status,mentor_id,order_id,packet_id,scheduled_at,review_id,
      revision,last_operation_id,created_at,updated_at,payload_ciphertext FROM platform_mentor_sessions
      WHERE user_id=$1 AND ($2::uuid IS NULL OR id>$2) ORDER BY id LIMIT 100`,[who.userId,after])).rows;
    for(const row of rows){signal?.throwIfAborted();if(row.user_id!==who.userId)throw unavailable();
     const saved=await this.history.decode(client,row);sessions.set(saved.id,saved);yield {section:'mentorSessions',record:sessionRecord(saved)};
    }
    if(rows.length<100)break;after=id(rows.at(-1)!.id);
   }
   after=null;
   for(;;){
    signal?.throwIfAborted();const rows=(await client.query<OperationRow>(`SELECT user_id,org_id,operation_id,session_id,action,applied_revision,created_at,receipt_ciphertext
      FROM platform_mentor_intent_operations WHERE user_id=$1 AND ($2::uuid IS NULL OR operation_id>$2) ORDER BY operation_id LIMIT 100`,[who.userId,after])).rows;
    for(const row of rows){signal?.throwIfAborted();const parent=sessions.get(row.session_id);
     if(row.user_id!==who.userId||!parent||row.org_id!==parent.organizationId||row.applied_revision>parent.revision)throw unavailable();
     yield {section:'mentorIntentOperations',record:operationRecord(this.history.receipt(row))};
    }
    if(rows.length<100)break;after=id(rows.at(-1)!.operation_id);
   }
   after=null;
   for(;;){
    signal?.throwIfAborted();const rows=(await client.query<MentorRatingRow>(`SELECT session_id,user_id,org_id,operation_id,created_at,payload_ciphertext
      FROM platform_mentor_ratings WHERE user_id=$1 AND ($2::uuid IS NULL OR session_id>$2) ORDER BY session_id LIMIT 100`,[who.userId,after])).rows;
    for(const row of rows){signal?.throwIfAborted();const parent=sessions.get(row.session_id);if(row.user_id!==who.userId||!parent)throw unavailable();
     yield {section:'mentorRatings',record:decodeMentorRating(this.crypto,row,parent)};
    }
    if(rows.length<100)break;after=id(rows.at(-1)!.session_id);
   }
   yield* this.ledgers.exportInTransaction(client,who.userId,sessions,signal);
  }catch{signal?.throwIfAborted();throw unavailable();}
  await authorizeFixedSession(client,who,signal);signal?.throwIfAborted();
 }
}
