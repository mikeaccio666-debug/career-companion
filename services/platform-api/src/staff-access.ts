import { randomUUID } from 'node:crypto';
import { STAFF_ROLES, type StaffRole, type StaffOrganization, type StaffMembership } from '@companion/platform-contracts';
import type { PoolClient } from 'pg';
import { authorizeFixedSession, type FixedSessionContext } from './auth.ts';
import type { Database } from './database.ts';
import { ApiError, identifier } from './errors.ts';

export const STAFF_AUDIT_ACTIONS = ['organization_viewed', 'staff_memberships_viewed', 'provider_details_viewed', 'org_license_registered', 'org_license_revoked', 'org_entitlement_changed', 'org_content_imported', 'org_content_published', 'org_content_withdrawn', 'org_sources_viewed'] as const;
export type StaffAuditAction = typeof STAFF_AUDIT_ACTIONS[number];
export interface StaffReadPolicy {
  readonly roles: readonly StaffRole[];
  readonly action: StaffAuditAction;
  readonly targetId?: string;
  /** Trusted operation policy; mutation takes UPDATE directly to avoid lock upgrades. */
  readonly exclusiveOrganization?: boolean;
}
export interface StaffReadResult<T> { readonly value: T; readonly recordCount: number; }
const privilegedRoles: readonly StaffRole[] = ['ops', 'org_admin'];
const denied = () => new ApiError(403, 'STAFF_ROLE_REQUIRED', 'Staff access is required.');
type DenialReason = 'student_account' | 'organization_missing' | 'organization_unavailable' | 'role_unavailable';
function captureSession(session: FixedSessionContext): FixedSessionContext {
  const fixed = Object.freeze({ userId: identifier(session.userId), tokenHash: session.tokenHash });
  if (typeof fixed.tokenHash !== 'string' || !/^[0-9a-f]{64}$/.test(fixed.tokenHash)) throw new ApiError(401, 'AUTH_REQUIRED', 'Sign in to continue.');
  return fixed;
}

/** Server-only policies and readers: request fields never select roles or audit actions. */
export class StaffAccess {
  constructor(private readonly db: Database) {}

  async recordDeniedAccess(session: FixedSessionContext, orgId: string | undefined, action: StaffAuditAction,
    reason: 'feature_disabled', signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    const fixed = captureSession(session), organizationId = orgId === undefined ? null : identifier(orgId);
    if (!STAFF_AUDIT_ACTIONS.includes(action) || reason !== 'feature_disabled') throw new Error('Invalid staff denial policy.');
    await this.db.withBoundedTransaction(async client => {
      await authorizeFixedSession(client, fixed, signal);
      await client.query(`INSERT INTO platform_staff_audit(id,user_id,org_id,action,outcome,reason,record_count)
        VALUES($1,$2,$3,$4,'deny',$5,0)`, [randomUUID(), fixed.userId, organizationId, action, reason]);
      await authorizeFixedSession(client, fixed, signal);
    });
    signal?.throwIfAborted();
  }

  async denyMissingOrganization(session: FixedSessionContext, action: StaffAuditAction, signal?: AbortSignal): Promise<never> {
    await this.readWithAccess(session, undefined, { roles: STAFF_ROLES, action }, async () => {
      throw new Error('A missing organization cannot reach a staff reader.');
    }, signal);
    throw denied();
  }

  async getOrganization(session: FixedSessionContext, orgId: string, signal?: AbortSignal): Promise<StaffOrganization> {
    return this.readWithAccess(session, orgId, { roles: STAFF_ROLES, action: 'organization_viewed', targetId: orgId }, async client => {
      const result = await client.query<StaffOrganization>('SELECT id,slug,display_name AS "displayName",status FROM platform_orgs WHERE id=$1', [orgId]);
      return { value: result.rows[0], recordCount: result.rowCount ?? 0 };
    }, signal);
  }

  async listMembers(session: FixedSessionContext, orgId: string, signal?: AbortSignal): Promise<StaffMembership[]> {
    return this.readWithAccess(session, orgId, { roles: privilegedRoles, action: 'staff_memberships_viewed', targetId: orgId }, async client => {
      const result = await client.query<StaffMembership>(`SELECT r.org_id AS "organizationId",r.user_id AS "userId",r.role
        FROM platform_org_roles r JOIN platform_users u ON u.id=r.user_id
        WHERE r.org_id=$1 AND r.status='active' AND u.account_kind='staff' ORDER BY r.user_id,r.role`, [orgId]);
      return { value: result.rows, recordCount: result.rowCount ?? 0 };
    }, signal);
  }

  async readWithAccess<T>(session: FixedSessionContext, orgId: string | undefined, policy: StaffReadPolicy,
    reader: (client: PoolClient) => Promise<StaffReadResult<T>>, signal?: AbortSignal): Promise<T> {
    signal?.throwIfAborted();
    // Capture values before the first await. A later cookie, object or policy mutation cannot rebind this read.
    const fixed = captureSession(session);
    const organizationId = orgId === undefined ? null : identifier(orgId), action = policy.action;
    if (!STAFF_AUDIT_ACTIONS.includes(action) || !Array.isArray(policy.roles) || policy.roles.length === 0
      || policy.roles.some(role => !STAFF_ROLES.includes(role))) throw new Error('Invalid staff read policy.');
    if (policy.exclusiveOrganization !== undefined && typeof policy.exclusiveOrganization !== 'boolean') throw new Error('Invalid organization lock policy.');
    const exclusive = policy.exclusiveOrganization === true;
    const roles = [...new Set(policy.roles)].filter(role => action === 'organization_viewed' || action === 'org_sources_viewed' || action === 'org_content_imported' && role === 'content_editor' || action === 'org_content_published' && role === 'content_reviewer' || privilegedRoles.includes(role));
    const targetId = policy.targetId === undefined ? null : identifier(policy.targetId);
    const outcome = await this.db.withBoundedTransaction(async client => {
      // Keep password reset's user -> session order, then organization -> membership -> audit.
      await authorizeFixedSession(client, fixed, signal);
      const deny = async (reason: DenialReason) => {
        await authorizeFixedSession(client, fixed, signal);
        await client.query(`INSERT INTO platform_staff_audit(id,user_id,org_id,action,outcome,reason,target_id,record_count)
          VALUES($1,$2,$3,$4,'deny',$5,$6,0)`, [randomUUID(), fixed.userId, organizationId, action, reason, targetId]);
        await authorizeFixedSession(client, fixed, signal);
        return { allowed: false as const };
      };
      const account = await client.query('SELECT account_kind FROM platform_users WHERE id=$1', [fixed.userId]);
      if (account.rows[0]?.account_kind !== 'staff') return deny('student_account');
      if (organizationId === null) return deny('organization_missing');
      const org = await client.query(exclusive ? "SELECT id FROM platform_orgs WHERE id=$1 AND status='active' FOR UPDATE" : "SELECT id FROM platform_orgs WHERE id=$1 AND status='active' FOR SHARE", [organizationId]);
      signal?.throwIfAborted(); if (!org.rowCount) return deny('organization_unavailable');
      const membership = await client.query<{role: StaffRole}>(`SELECT role FROM platform_org_roles
        WHERE org_id=$1 AND user_id=$2 AND status='active' AND role=ANY($3::text[]) ORDER BY role LIMIT 1 FOR SHARE`,
      [organizationId, fixed.userId, roles]);
      signal?.throwIfAborted(); if (!membership.rowCount) return deny('role_unavailable');
      // SHARE makes concurrent revocation wait for this accepted read; a revocation that wins first is denied.
      const result = await reader(client);
      signal?.throwIfAborted();
      if (!Number.isSafeInteger(result.recordCount) || result.recordCount < 0 || result.recordCount > 2_147_483_647) throw new Error('Invalid staff record count.');
      await authorizeFixedSession(client, fixed, signal); // Database clock can advance while the reader awaits.
      await client.query(`INSERT INTO platform_staff_audit(id,user_id,org_id,role,action,outcome,reason,target_id,record_count)
        VALUES($1,$2,$3,$4,$5,'allow','authorized',$6,$7)`, [randomUUID(), fixed.userId, organizationId, membership.rows[0].role, action, targetId, result.recordCount]);
      await authorizeFixedSession(client, fixed, signal);
      return { allowed: true as const, value: result.value };
    }); // COMMIT (including the audit) must succeed before the caller receives any data.
    signal?.throwIfAborted();
    if (!outcome.allowed) throw denied();
    return outcome.value;
  }
}
