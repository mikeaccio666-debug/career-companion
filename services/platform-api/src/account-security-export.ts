import type {PoolClient} from 'pg';
import {careerRecordId as id,careerRecordObject as object} from '@companion/platform-contracts';
import {authorizeFixedSession,type FixedSessionContext} from './auth.ts';
import {invitationEmailDigest} from './student-entry.ts';
import {ApiError} from './errors.ts';

export const SECURITY_EXPORT_TABLES=Object.freeze(['platform_account_actions','platform_account_email_outbox','platform_account_action_limits',
 'platform_account_reauthentications','platform_request_limits','platform_runtime_leases','platform_invites'] as const);
export type SecurityExportSection='accountActions'|'accountEmailDeliveries'|'accountActionLimits'|'accountReauthentications'|'requestLimits'|'runtimeLeases'|'invitations';
type Row=Record<string,any>;
const unavailable=()=>new ApiError(503,'ACCOUNT_SECURITY_EXPORT_UNAVAILABLE','The saved account security metadata could not be confirmed.');
const purposes=['password-reset','verify-email'] as const;
function at(value:unknown,nullable=false):string|null{if(value===null&&nullable)return null;if(!(value instanceof Date)||!Number.isFinite(value.getTime()))throw unavailable();return value.toISOString();}
function choice(value:unknown,values:readonly string[]):string{if(typeof value!=='string'||!values.includes(value))throw unavailable();return value;}
function count(value:unknown,min=0,max=2147483647):number{if(!Number.isSafeInteger(value)||Object.is(value,-0)||(value as number)<min||(value as number)>max)throw unavailable();return value as number;}
function hash(value:unknown):string{if(typeof value!=='string'||!/^[0-9a-f]{64}$/.test(value))throw unavailable();return value;}
const specs={
 platform_account_actions:{columns:'id,user_id,purpose,created_at,expires_at,consumed_at',keys:['id'],owner:'user_id'},
 platform_account_email_outbox:{columns:'id,action_id,user_id,status,attempts,created_at,expires_at,next_attempt_at,lease_until,error_code,finished_at',keys:['id'],owner:'user_id'},
 platform_account_action_limits:{columns:'target_hash,user_id,purpose,request_count,expires_at',keys:['target_hash','purpose'],owner:'user_id'},
 platform_account_reauthentications:{columns:'user_id,session_hash,purpose,verified_at,expires_at,consumed_at',keys:['session_hash','purpose'],owner:'user_id'},
 platform_request_limits:{columns:'owner_id,subject_type,subject_key,scope,request_count,expires_at',keys:['scope'],owner:'owner_id'},
 platform_runtime_leases:{columns:'id,user_id,kind,created_at,expires_at',keys:['id'],owner:'user_id'},
 platform_invites:{columns:'code_hash,email_digest,batch,expires_at,redeemed_at,redeemed_user_id',keys:['code_hash'],owner:null},
} as const;
/** Only fixed column/table names enter SQL. Cursor hashes stay private and mail
 * payloads, proofs and execution tokens are never fetched by this reader. */
async function* rows(client:PoolClient,owner:string,table:typeof SECURITY_EXPORT_TABLES[number],emailDigest:string,signal?:AbortSignal){
 const spec=specs[table],keys:readonly string[]=spec.keys;let after:string[]|null=null;
 const predicate=table==='platform_invites'?'(redeemed_user_id=$1 OR (redeemed_user_id IS NULL AND email_digest=$2))':
  `${spec.owner}=$1`+(table==='platform_request_limits'?" AND subject_type='user' AND subject_key=$1::text":'');
 for(;;){
  signal?.throwIfAborted();const values:unknown[]=table==='platform_invites'?[owner,emailDigest]:[owner];
  let cursor='';if(after){const params=after.map(value=>{values.push(value);return '$'+values.length;});cursor=` AND (${keys.join(',')})>(${params.join(',')})`;}
  const found:Row[]=(await client.query(`SELECT ${spec.columns} FROM ${table} WHERE ${predicate}${cursor} ORDER BY ${keys.join(',')} LIMIT 100`,values)).rows;
  for(const row of found){signal?.throwIfAborted();if(spec.owner&&row[spec.owner]!==owner)throw unavailable();yield row;}
  if(found.length<100)break;
  after=keys.map(key=>{const value=found.at(-1)![key];if(typeof value!=='string'||!value.length)throw unavailable();return value;});
 }
}
/** A historical projection, not a login audit trail or executable grant. The
 * caller owns the repeatable-read transaction and password-proof consumption. */
export async function* exportSecurityInTransaction(client:PoolClient,value:FixedSessionContext,signal?:AbortSignal):AsyncGenerator<{section:SecurityExportSection;record:unknown}>{
 const session=object(value,['userId','tokenHash']),who=Object.freeze({userId:id(session.userId),tokenHash:hash(session.tokenHash)});
 await authorizeFixedSession(client,who,signal);
 try{
  const user=(await client.query('SELECT email FROM platform_users WHERE id=$1',[who.userId])).rows[0];
  if(typeof user?.email!=='string'||!user.email)throw unavailable();const digest=invitationEmailDigest(user.email),ownerId=who.userId;
  const read=(table:typeof SECURITY_EXPORT_TABLES[number])=>rows(client,ownerId,table,digest,signal),actions=new Set<string>();
  for await(const row of read('platform_account_actions')){
   const key=id(row.id);actions.add(key);
   yield {section:'accountActions',record:{id:key,ownerId,purpose:choice(row.purpose,purposes),createdAt:at(row.created_at),expiresAt:at(row.expires_at),consumedAt:at(row.consumed_at,true)}};
  }
  for await(const row of read('platform_account_email_outbox')){
   if(!actions.has(id(row.action_id)))throw unavailable();
   const status=choice(row.status,['pending','sending','sent','expired','revoked','failed']),leaseUntil=at(row.lease_until,true);
   if((status==='sending')!==(leaseUntil!==null))throw unavailable();
   yield {section:'accountEmailDeliveries',record:{id:id(row.id),actionId:row.action_id,ownerId,status,attempts:count(row.attempts),
    createdAt:at(row.created_at),expiresAt:at(row.expires_at),nextAttemptAt:at(row.next_attempt_at),leaseUntil,
    errorCode:row.error_code===null?null:choice(row.error_code,['ACCOUNT_EMAIL_SEND_FAILED','ACCOUNT_EMAIL_PAYLOAD_INVALID']),finishedAt:at(row.finished_at,true)}};
  }
  for await(const row of read('platform_account_action_limits')){
   hash(row.target_hash);
   yield {section:'accountActionLimits',record:{ownerId,purpose:choice(row.purpose,purposes),requestCount:count(row.request_count,1,3),expiresAt:at(row.expires_at)}};
  }
  for await(const row of read('platform_account_reauthentications')){
   yield {section:'accountReauthentications',record:{ownerId,purpose:choice(row.purpose,['account_export','account_delete']),currentSession:hash(row.session_hash)===who.tokenHash,
    verifiedAt:at(row.verified_at),expiresAt:at(row.expires_at),consumedAt:at(row.consumed_at,true)}};
  }
  for await(const row of read('platform_request_limits')){
   if(row.subject_type!=='user'||row.subject_key!==ownerId)throw unavailable();
   yield {section:'requestLimits',record:{ownerId,scope:choice(row.scope,['api','chat','speech','transcription','realtime','control','org-knowledge','account-reauth']),requestCount:count(row.request_count,1),expiresAt:at(row.expires_at)}};
  }
  for await(const row of read('platform_runtime_leases')){
   id(row.id);yield {section:'runtimeLeases',record:{ownerId,kind:choice(row.kind,['chat','voice','background']),createdAt:at(row.created_at),expiresAt:at(row.expires_at)}};
  }
  for await(const row of read('platform_invites')){
   hash(row.code_hash);hash(row.email_digest);
   const redeemed=row.redeemed_user_id===ownerId;
   if(!redeemed&&(row.redeemed_user_id!==null||row.email_digest!==digest)||redeemed&&row.redeemed_at===null)throw unavailable();
   yield {section:'invitations',record:{ownerId,batch:choice(row.batch,['B0','B1','B2','B3']),recipientMatch:redeemed?'redeemed_account':'current_email',expiresAt:at(row.expires_at),redeemedAt:at(row.redeemed_at,true)}};
  }
 }catch(error){signal?.throwIfAborted();throw unavailable();}
 await authorizeFixedSession(client,who,signal);signal?.throwIfAborted();
}
