import type { PoolClient } from 'pg';
import { authorizeFixedSession,type FixedSessionContext } from './auth.ts';
import { ApiError } from './errors.ts';
/** Internal helper for a caller-owned StaffAccess transaction; no fake actor, nested transaction or audit bypass route. */
export async function authorizeMentorStaffSource(c:PoolClient,session:FixedSessionContext,org:string,signal?:AbortSignal){
 await authorizeFixedSession(c,session,signal);
 const r=await c.query(`SELECT r.user_id FROM platform_org_roles r JOIN platform_users u ON u.id=r.user_id JOIN platform_orgs o ON o.id=r.org_id
  WHERE r.org_id=$1 AND r.user_id=$2 AND r.role IN ('ops','org_admin') AND r.status='active' AND o.status='active' AND u.account_kind='staff' FOR SHARE OF r,u,o`,[org,session.userId]);
 if(!r.rowCount)throw new ApiError(403,'STAFF_ROLE_REQUIRED','Staff access is required.');signal?.throwIfAborted();
}
