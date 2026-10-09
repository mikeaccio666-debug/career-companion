import type {PoolClient} from 'pg';
import {careerRecordId as id,careerRecordObject as object,STAFF_ROLES} from '@companion/platform-contracts';
import {authorizeFixedSession,type FixedSessionContext} from './auth.ts';
import {ApiError} from './errors.ts';
import {STAFF_AUDIT_ACTIONS} from './staff-access.ts';

export const ORGANIZATION_HISTORY_EXPORT_TABLES=Object.freeze(['platform_org_roles','platform_staff_audit'] as const);
export type OrganizationHistoryExportSection='organizationMemberships'|'organizationAccessEvents';
type Row=Record<string,any>;
const unavailable=()=>new ApiError(503,'ACCOUNT_ORGANIZATION_HISTORY_EXPORT_UNAVAILABLE','The original organization history could not be confirmed.');
const at=(d:Date)=>{if(!(d instanceof Date)||!Number.isFinite(d.getTime()))throw unavailable();return d.toISOString();};
const nullableId=(value:unknown)=>value===null?null:id(value);
/** Original student-linked metadata only. Shared corpus bodies, entitlement
 * values, staff identities, proof digests and authority credentials are excluded.
 * The account capture owns the repeatable-read transaction and release boundary. */
export class AccountOrganizationHistoryExport {
 async *exportInTransaction(client:PoolClient,value:FixedSessionContext,signal?:AbortSignal):AsyncGenerator<{section:OrganizationHistoryExportSection;record:unknown}>{
  const raw=object(value,['userId','tokenHash']),who={userId:id(raw.userId),tokenHash:raw.tokenHash as string};
  if(typeof who.tokenHash!=='string'||!/^[0-9a-f]{64}$/.test(who.tokenHash))throw new ApiError(401,'AUTH_REQUIRED','Sign in to continue.');
  await authorizeFixedSession(client,who,signal);
  try{
   const account=(await client.query('SELECT account_kind FROM platform_users WHERE id=$1',[who.userId])).rows[0];
   if(account?.account_kind!=='student')throw unavailable();
   let roleAfter:readonly[string,string]|null=null,roleCount=0,auditCount=0;
   for(;;){
    signal?.throwIfAborted();
    const page:Row[]=(await client.query(`SELECT * FROM platform_org_roles WHERE user_id=$1 AND ($2::uuid IS NULL OR (org_id,role)>($2::uuid,$3::text))
     ORDER BY org_id,role LIMIT 100`,[who.userId,roleAfter?.[0]??null,roleAfter?.[1]??null])).rows;
    for(const r of page){
     if(r.user_id!==who.userId||!STAFF_ROLES.includes(r.role)||!['active','revoked'].includes(r.status)
      ||(r.status==='active')!==(r.revoked_at===null)||r.revoked_at!==null&&r.revoked_at<r.granted_at)throw unavailable();
     roleCount++;yield {section:'organizationMemberships',record:{ownerId:who.userId,organizationId:id(r.org_id),role:r.role,status:r.status,
      grantedAt:at(r.granted_at),revokedAt:r.revoked_at===null?null:at(r.revoked_at),kind:'stored_membership_metadata'}};
    }
    if(page.length<100)break;roleAfter=[id(page.at(-1)!.org_id),page.at(-1)!.role];
   }
   // Staff actions are related only by actual target coordinates. A bulk
   // staff read with no per-student target cannot be turned into a personal view receipt.
   const related=`a.user_id=$1 OR (a.action='org_entitlement_changed' AND a.target_id=$1)
    OR (a.action IN ('mentor_intent_matched','mentor_payment_recorded','mentor_schedule_recorded')
     AND EXISTS(SELECT 1 FROM platform_mentor_sessions s WHERE s.user_id=$1 AND s.id=a.target_id AND s.org_id=a.org_id))`;
   let after:string|null=null;
   for(;;){
    signal?.throwIfAborted();
    const page:Row[]=(await client.query(`SELECT a.* FROM platform_staff_audit a WHERE (${related}) AND ($2::uuid IS NULL OR a.id>$2) ORDER BY a.id LIMIT 100`,[who.userId,after])).rows;
    for(const r of page){
     if(!STAFF_AUDIT_ACTIONS.includes(r.action)||!Number.isSafeInteger(r.record_count)||r.record_count<0||r.record_count>2147483647)throw unavailable();
     const allowed=r.outcome==='allow'&&r.reason==='authorized'&&STAFF_ROLES.includes(r.role)&&r.org_id!==null;
     const denied=r.outcome==='deny'&&r.role===null&&r.record_count===0
      &&['student_account','organization_missing','organization_unavailable','role_unavailable','feature_disabled'].includes(r.reason);
     if(!allowed&&!denied)throw unavailable();
     let relation:'own_action'|'account'|'mentor_session';
     if(r.user_id===who.userId)relation='own_action';
     else if(r.action==='org_entitlement_changed'&&r.target_id===who.userId)relation='account';
     else{
      if(!['mentor_intent_matched','mentor_payment_recorded','mentor_schedule_recorded'].includes(r.action))throw unavailable();
      const target=(await client.query('SELECT id FROM platform_mentor_sessions WHERE id=$1 AND user_id=$2 AND org_id=$3',[r.target_id,who.userId,r.org_id])).rows;
      if(target.length!==1||target[0].id!==r.target_id)throw unavailable();relation='mentor_session';
     }
     auditCount++;yield {section:'organizationAccessEvents',record:{id:id(r.id),ownerId:who.userId,actor:r.user_id===who.userId?'self':'other_account',
      relation,organizationId:nullableId(r.org_id),action:r.action,outcome:r.outcome,reason:r.reason,
      targetId:nullableId(r.target_id),recordCount:r.record_count,recordedAt:at(r.created_at)}};
    }
    if(page.length<100)break;after=id(page.at(-1)!.id);
   }
   const audit=(await client.query(`SELECT
    (SELECT count(*)::int FROM platform_org_roles WHERE user_id=$1) AS roles,
    (SELECT count(*)::int FROM platform_staff_audit a WHERE (${related})) AS events,
    EXISTS(SELECT 1 FROM platform_org_roles WHERE user_id=$1 AND (granted_at>clock_timestamp() OR revoked_at>clock_timestamp())
     UNION ALL SELECT 1 FROM platform_staff_audit a WHERE (${related}) AND created_at>clock_timestamp()) AS future`,[who.userId])).rows[0];
   if(!audit||audit.roles!==roleCount||audit.events!==auditCount||audit.future)throw unavailable();
  }catch{signal?.throwIfAborted();throw unavailable();}
  await authorizeFixedSession(client,who,signal);signal?.throwIfAborted();
 }
}
