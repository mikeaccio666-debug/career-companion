import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import type { PoolClient } from 'pg';
import { STAFF_ROLES, type StaffRole } from '@companion/platform-contracts';
import { Database } from '../src/database.ts';
import { readConfig } from '../src/config.ts';
import { tokenHash, type FixedSessionContext } from '../src/auth.ts';
import { ApiError } from '../src/errors.ts';
import { StaffAccess, type StaffAuditAction } from '../src/staff-access.ts';

const config = readConfig(), schema = `staff_access_${randomUUID().replaceAll('-', '')}`;
const admin = new Database(config.databaseUrl), url = new URL(config.databaseUrl);
url.searchParams.set('options', `-c search_path=${schema}`);
const db = new Database(url.toString()), service = new StaffAccess(db);
let created = false;
before(async () => {
  assert(['localhost', '127.0.0.1', '[::1]'].includes(url.hostname), 'This write fixture requires a loopback database.');
  await admin.query(`CREATE SCHEMA ${schema}`); created = true; await db.migrate();
  await db.query('CREATE TABLE staff_read_probe(id uuid PRIMARY KEY)');
});
after(async () => { await db.close(); if (created) await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.close(); });
const roleRequired = (error: unknown) => error instanceof ApiError && error.status === 403 && error.code === 'STAFF_ROLE_REQUIRED';
const authRequired = (error: unknown) => error instanceof ApiError && error.status === 401 && error.code === 'AUTH_REQUIRED';
async function actor(kind: 'student' | 'staff' = 'staff'): Promise<FixedSessionContext> {
  const userId = randomUUID(), token = randomBytes(32).toString('base64url');
  if (kind === 'student') await db.query('INSERT INTO platform_users(id,email,name,password_hash) VALUES($1,$2,$3,$4)',
    [userId, `${userId}@example.invalid`, 'Synthetic student', 'synthetic-unused-password-hash']);
  else await db.query("INSERT INTO platform_users(id,email,name,password_hash,account_kind) VALUES($1,$2,$3,$4,'staff')",
    [userId, `${userId}@example.invalid`, 'Synthetic employee', 'synthetic-unused-password-hash']);
  await db.query("INSERT INTO platform_sessions(token_hash,user_id,expires_at,auth_version) VALUES($1,$2,now()+interval '1 hour',0)", [tokenHash(token), userId]);
  return { userId, tokenHash: tokenHash(token) };
}
async function organization() {
  const id = randomUUID(), slug = `fixture_${id.replaceAll('-', '')}`;
  await db.query('INSERT INTO platform_orgs(id,slug,display_name) VALUES($1,$2,$3)', [id, slug, 'Synthetic organization']);
  return { id, slug, displayName: 'Synthetic organization', status: 'active' };
}
async function grant(user: FixedSessionContext, orgId: string, role: StaffRole = 'ops', by = user.userId) {
  await db.query('INSERT INTO platform_org_roles(org_id,user_id,role,granted_by) VALUES($1,$2,$3,$4)', [orgId, user.userId, role, by]);
}
async function audits(user: FixedSessionContext) {
  return (await db.query('SELECT user_id,org_id,role,action,outcome,reason,target_id,record_count FROM platform_staff_audit WHERE user_id=$1 ORDER BY created_at,id', [user.userId])).rows;
}
async function pid(client: PoolClient) { return Number((await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid); }
async function waitForBlocker(blocker: number) {
  const until = Date.now() + 350;
  while (Date.now() < until) {
    const result = await db.query('SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND $1=ANY(pg_blocking_pids(pid))) AS blocked', [blocker]);
    if (result.rows[0].blocked) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail('The owned operation did not reach its expected PostgreSQL row lock.');
}
const detailsPolicy = { roles: ['ops', 'org_admin'] as const, action: 'provider_details_viewed' as const };

// These tests use real PostgreSQL identity/locks, not a mocked authorization callback or provider.
test('existing accounts migrate to student and new accounts cannot gain staff by default', async () => {
  const oldSchema = `staff_backfill_${randomUUID().replaceAll('-', '')}`, oldUrl = new URL(config.databaseUrl);
  oldUrl.searchParams.set('options', `-c search_path=${oldSchema}`); const oldDb = new Database(oldUrl.toString()); let own = false;
  try {
    await admin.query(`CREATE SCHEMA ${oldSchema}`); own = true;
    await oldDb.query(await fs.readFile(new URL('../migrations/001_platform.sql', import.meta.url), 'utf8'));
    const id = randomUUID(); await oldDb.query('INSERT INTO platform_users(id,email,name,password_hash) VALUES($1,$2,$3,$4)', [id, 'old-staff-fixture@example.invalid', 'Legacy synthetic account', 'unused-synthetic-hash']);
    await oldDb.migrate(); await oldDb.migrate();
    assert.equal((await oldDb.query('SELECT account_kind FROM platform_users WHERE id=$1', [id])).rows[0].account_kind, 'student');
  } finally { await oldDb.close(); if (own) await admin.query(`DROP SCHEMA ${oldSchema} CASCADE`); }
  const student = await actor('student'); assert.equal((await db.query('SELECT account_kind FROM platform_users WHERE id=$1', [student.userId])).rows[0].account_kind, 'student');
});

test('a student with an active role row remains a student and the denial is durably audited', async () => {
  const student = await actor('student'), org = await organization(); await grant(student, org.id);
  await assert.rejects(service.getOrganization(student, org.id), roleRequired);
  assert.deepEqual(await audits(student), [{ user_id: student.userId, org_id: org.id, role: null, action: 'organization_viewed', outcome: 'deny', reason: 'student_account', target_id: org.id, record_count: 0 }]);
});

test('all six real roles can read their active organization with an allow receipt', async () => {
  for (const role of STAFF_ROLES) {
    const user = await actor(), org = await organization(); await grant(user, org.id, role);
    assert.deepEqual(await service.getOrganization(user, org.id), org);
    const [audit] = await audits(user); assert.equal(audit.outcome, 'allow'); assert.equal(audit.role, role); assert.equal(audit.record_count, 1);
  }
});

test('member reads return only active staff identities and closed roles in the owned organization', async () => {
  const user = await actor(), peer = await actor(), student = await actor('student'), revoked = await actor(), other = await organization(), org = await organization();
  await grant(user, org.id); await grant(peer, org.id, 'mentor'); await grant(student, org.id, 'ops'); await grant(revoked, org.id, 'mentor'); await grant(peer, other.id, 'org_admin');
  await db.query("UPDATE platform_org_roles SET status='revoked',revoked_at=now() WHERE org_id=$1 AND user_id=$2", [org.id, revoked.userId]);
  const members = await service.listMembers(user, org.id);
  assert.deepEqual(members.map(x => x.userId).sort(), [user.userId, peer.userId].sort());
  for (const member of members) assert.deepEqual(Object.keys(member).sort(), ['organizationId', 'role', 'userId']);
  const [audit] = await audits(user); assert.equal(audit.action, 'staff_memberships_viewed'); assert.equal(audit.record_count, 2);
});

test('non-privileged staff cannot access directory or provider details even under a wider supplied role policy', async () => {
  const user = await actor(), org = await organization(); await grant(user, org.id, 'content_editor'); let reads = 0;
  await assert.rejects(service.listMembers(user, org.id), roleRequired);
  await assert.rejects(service.readWithAccess(user, org.id, { roles: STAFF_ROLES, action: 'provider_details_viewed' }, async () => { reads++; return { value: ['Synthetic secret'], recordCount: 1 }; }), roleRequired);
  assert.equal(reads, 0); assert((await audits(user)).every(x => x.outcome === 'deny' && x.reason === 'role_unavailable'));
});

test('missing, disabled, foreign and revoked organization grants deny without running the reader', async () => {
  const user = await actor(), org = await organization(), foreign = await organization(); await grant(user, org.id);
  for (const target of [foreign.id, randomUUID()]) await assert.rejects(service.getOrganization(user, target), roleRequired);
  await db.query("UPDATE platform_orgs SET status='disabled' WHERE id=$1", [org.id]); await assert.rejects(service.getOrganization(user, org.id), roleRequired);
  await db.query("UPDATE platform_orgs SET status='active' WHERE id=$1", [org.id]);
  await db.query("UPDATE platform_org_roles SET status='revoked',revoked_at=now() WHERE org_id=$1 AND user_id=$2", [org.id, user.userId]);
  await assert.rejects(service.getOrganization(user, org.id), roleRequired);
  assert.equal((await audits(user)).length, 4); assert((await audits(user)).every(x => x.outcome === 'deny' && x.record_count === 0));
});

test('missing organization context receives a durable denial through the real fixed session', async () => {
  const user = await actor(); await assert.rejects(service.denyMissingOrganization(user, 'provider_details_viewed'), roleRequired);
  const [audit] = await audits(user); assert.equal(audit.org_id, null); assert.equal(audit.reason, 'organization_missing'); assert.equal(audit.outcome, 'deny');
});

test('foreign, deleted, expired and reset sessions never run a reader or create an allow receipt', async () => {
  const owner = await actor(), other = await actor(), org = await organization(); await grant(owner, org.id);
  await assert.rejects(service.getOrganization({ userId: owner.userId, tokenHash: other.tokenHash }, org.id), authRequired);
  await db.query("UPDATE platform_sessions SET expires_at=clock_timestamp()-interval '1 second' WHERE token_hash=$1", [owner.tokenHash]);
  await assert.rejects(service.getOrganization(owner, org.id), authRequired);
  await db.query("UPDATE platform_sessions SET expires_at=now()+interval '1 hour' WHERE token_hash=$1", [owner.tokenHash]);
  await db.query('UPDATE platform_users SET auth_version=auth_version+1 WHERE id=$1', [owner.userId]);
  await assert.rejects(service.getOrganization(owner, org.id), authRequired);
  await db.query('DELETE FROM platform_sessions WHERE token_hash=$1', [owner.tokenHash]);
  await assert.rejects(service.getOrganization(owner, org.id), authRequired); assert.deepEqual(await audits(owner), []);
});

test('fixed identity and policy are captured before waits, not rebound by later context mutation', async () => {
  const user = await actor(), other = await actor(), org = await organization(); await grant(user, org.id); await grant(other, org.id);
  const blocker = await db.pool.connect(); let pending: Promise<unknown> | undefined;
  try {
    await blocker.query('BEGIN'); await blocker.query('SELECT id FROM platform_users WHERE id=$1 FOR UPDATE', [user.userId]);
    const context = { ...user }, policy = { roles: ['ops'] as StaffRole[], action: 'provider_details_viewed' as const };
    pending = service.readWithAccess(context, org.id, policy, async client => ({ value: (await client.query('SELECT id FROM platform_orgs WHERE id=$1', [org.id])).rows, recordCount: 1 }));
    await waitForBlocker(await pid(blocker)); context.userId = other.userId; context.tokenHash = other.tokenHash; policy.roles.splice(0);
    await blocker.query('COMMIT'); await pending;
    assert.equal((await audits(user)).length, 1); assert.deepEqual(await audits(other), []);
  } finally { await blocker.query('ROLLBACK'); blocker.release(); await pending; }
});

test('logout committed while the fixed-session lock waits rejects the read', async () => {
  const user = await actor(), org = await organization(); await grant(user, org.id); const blocker = await db.pool.connect(); let pending: Promise<void> | undefined;
  try {
    await blocker.query('BEGIN'); await blocker.query('DELETE FROM platform_sessions WHERE token_hash=$1', [user.tokenHash]);
    pending = assert.rejects(service.getOrganization(user, org.id), authRequired);
    await waitForBlocker(await pid(blocker)); await blocker.query('COMMIT'); await pending; assert.deepEqual(await audits(user), []);
  } finally { await blocker.query('ROLLBACK'); blocker.release(); await pending; }
});

test('database-clock expiry during an accepted reader rejects without an allow receipt', async () => {
  const user = await actor(), org = await organization(); await grant(user, org.id); let entered = false;
  await assert.rejects(service.readWithAccess(user, org.id, detailsPolicy, async client => {
    entered = true; await client.query("UPDATE platform_sessions SET expires_at=clock_timestamp()+interval '30 milliseconds' WHERE token_hash=$1", [user.tokenHash]);
    await client.query('SELECT pg_sleep(0.06)'); return { value: 'Synthetic confidential fixture', recordCount: 1 };
  }), authRequired);
  assert(entered); assert.deepEqual(await audits(user), []);
});

test('a revocation that holds the role lock first wins over a pending read', async () => {
  const user = await actor(), org = await organization(); await grant(user, org.id); const blocker = await db.pool.connect(); let pending: Promise<void> | undefined;
  try {
    await blocker.query('BEGIN'); await blocker.query("UPDATE platform_org_roles SET status='revoked',revoked_at=now() WHERE org_id=$1 AND user_id=$2", [org.id, user.userId]);
    pending = assert.rejects(service.getOrganization(user, org.id), roleRequired);
    await waitForBlocker(await pid(blocker)); await blocker.query('COMMIT'); await pending;
    assert.equal((await audits(user))[0].reason, 'role_unavailable');
  } finally { await blocker.query('ROLLBACK'); blocker.release(); await pending; }
});

test('organization disablement that holds the organization lock first wins over a pending read', async () => {
  const user = await actor(), org = await organization(); await grant(user, org.id); const blocker = await db.pool.connect(); let pending: Promise<void> | undefined;
  try {
    await blocker.query('BEGIN'); await blocker.query("UPDATE platform_orgs SET status='disabled' WHERE id=$1", [org.id]);
    pending = assert.rejects(service.listMembers(user, org.id), roleRequired);
    await waitForBlocker(await pid(blocker)); await blocker.query('COMMIT'); await pending;
    assert.equal((await audits(user))[0].reason, 'organization_unavailable');
  } finally { await blocker.query('ROLLBACK'); blocker.release(); await pending; }
});

test('an accepted read holds its grant until audit commits, then revocation prevents later reads', { timeout: 5000 }, async () => {
  const user = await actor(), org = await organization(); await grant(user, org.id);
  let enter!: () => void, release!: () => void, readerPid = 0;
  const entered = new Promise<void>(resolve => { enter = resolve; }), hold = new Promise<void>(resolve => { release = resolve; });
  const read = service.readWithAccess(user, org.id, detailsPolicy, async client => { readerPid = await pid(client); enter(); await hold; return { value: 'Synthetic result', recordCount: 1 }; });
  const writer = await db.pool.connect(); let revoke: Promise<unknown> | undefined;
  try {
    await entered; await writer.query('BEGIN'); revoke = writer.query("UPDATE platform_org_roles SET status='revoked',revoked_at=now() WHERE org_id=$1 AND user_id=$2", [org.id, user.userId]);
    await waitForBlocker(readerPid); assert.deepEqual(await audits(user), []);
    release(); assert.equal(await read, 'Synthetic result'); await revoke; await writer.query('COMMIT');
    await assert.rejects(service.getOrganization(user, org.id), roleRequired);
    assert.deepEqual((await audits(user)).map(x => x.outcome), ['allow', 'deny']);
  } finally { release(); await read; if (revoke) await revoke; await writer.query('ROLLBACK'); writer.release(); }
});

test('allow-audit failure rolls back the transaction and never returns the prepared data', async () => {
  const user = await actor(), org = await organization(); await grant(user, org.id); const probe = randomUUID(); let delivered = false;
  await db.query("ALTER TABLE platform_staff_audit ADD CONSTRAINT synthetic_audit_failure CHECK (action<>'provider_details_viewed') NOT VALID");
  try {
    await assert.rejects(service.readWithAccess(user, org.id, detailsPolicy, async client => {
      await client.query('INSERT INTO staff_read_probe(id) VALUES($1)', [probe]); return { value: 'Synthetic secret never delivered', recordCount: 1 };
    }).then(value => { delivered = Boolean(value); }), (error: unknown) => typeof error === 'object' && error !== null && 'code' in error && error.code === '23514');
    assert.equal(delivered, false); assert.equal((await db.query('SELECT id FROM staff_read_probe WHERE id=$1', [probe])).rowCount, 0); assert.deepEqual(await audits(user), []);
  } finally { await db.query('ALTER TABLE platform_staff_audit DROP CONSTRAINT synthetic_audit_failure'); }
});

test('deny-audit failure is a real database failure, not a falsely confirmed 403', async () => {
  const user = await actor('student'), org = await organization();
  await db.query('ALTER TABLE platform_staff_audit ADD CONSTRAINT synthetic_deny_failure CHECK (outcome<>\'deny\') NOT VALID');
  try { await assert.rejects(service.getOrganization(user, org.id), (error: unknown) => !(error instanceof ApiError) && typeof error === 'object' && error !== null && 'code' in error && error.code === '23514'); assert.deepEqual(await audits(user), []); }
  finally { await db.query('ALTER TABLE platform_staff_audit DROP CONSTRAINT synthetic_deny_failure'); }
});

test('abort before or during the reader never yields data or an allow receipt', async () => {
  const user = await actor(), org = await organization(); await grant(user, org.id); const cancelled = new AbortController(); cancelled.abort();
  await assert.rejects(service.getOrganization(user, org.id, cancelled.signal), { name: 'AbortError' });
  const pending = new AbortController(); await assert.rejects(service.readWithAccess(user, org.id, detailsPolicy, async () => { pending.abort(); return { value: 'Synthetic discarded data', recordCount: 1 }; }, pending.signal), { name: 'AbortError' });
  assert.deepEqual(await audits(user), []);
});

test('schema and service reject unrecognized account kinds, roles, actions and nonnumeric audit counts', async () => {
  const user = await actor(), org = await organization(); await grant(user, org.id);
  await assert.rejects(db.query("UPDATE platform_users SET account_kind='admin' WHERE id=$1", [user.userId]), { code: '23514' });
  await assert.rejects(db.query("INSERT INTO platform_org_roles(org_id,user_id,role,granted_by) VALUES($1,$2,'admin',$2)", [org.id, user.userId]), { code: '23514' });
  let entered = false;
  const reader = async () => { entered = true; return { value: 'Not returned', recordCount: 1 }; };
  await assert.rejects(service.readWithAccess(user, org.id, { roles: ['admin' as StaffRole], action: 'organization_viewed' }, reader), /Invalid staff read policy/);
  await assert.rejects(service.readWithAccess(user, org.id, { roles: ['ops'], action: 'body_exported' as StaffAuditAction }, reader), /Invalid staff read policy/);
  assert.equal(entered, false);
  await assert.rejects(service.readWithAccess(user, org.id, detailsPolicy, async () => ({ value: 'Not returned', recordCount: Number.NaN })), /Invalid staff record count/);
  assert.deepEqual(await audits(user), []);
});

test('password reset committed while the account lock waits invalidates the captured session', async () => {
  const user = await actor(), org = await organization(); await grant(user, org.id); const blocker = await db.pool.connect(); let pending: Promise<void> | undefined;
  try {
    await blocker.query('BEGIN'); await blocker.query('UPDATE platform_users SET auth_version=auth_version+1 WHERE id=$1', [user.userId]);
    await blocker.query('DELETE FROM platform_sessions WHERE user_id=$1', [user.userId]);
    pending = assert.rejects(service.getOrganization(user, org.id), authRequired);
    await waitForBlocker(await pid(blocker)); await blocker.query('COMMIT'); await pending; assert.deepEqual(await audits(user), []);
  } finally { await blocker.query('ROLLBACK'); blocker.release(); await pending; }
});

test('staff-to-student change committed before the captured account lock denies even with a surviving role', async () => {
  const user = await actor(), org = await organization(); await grant(user, org.id); const blocker = await db.pool.connect(); let pending: Promise<void> | undefined;
  try {
    await blocker.query('BEGIN'); await blocker.query("UPDATE platform_users SET account_kind='student' WHERE id=$1", [user.userId]);
    pending = assert.rejects(service.getOrganization(user, org.id), roleRequired);
    await waitForBlocker(await pid(blocker)); await blocker.query('COMMIT'); await pending;
    assert.equal((await audits(user))[0].reason, 'student_account');
  } finally { await blocker.query('ROLLBACK'); blocker.release(); await pending; }
});

test('expiry while the allow-audit insert waits is revalidated before commit and data return', async () => {
  const user = await actor(), org = await organization(); await grant(user, org.id);
  await db.query(`CREATE FUNCTION staff_slow_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_sleep(0.4); RETURN NEW; END $$`);
  await db.query('CREATE TRIGGER staff_slow_audit BEFORE INSERT ON platform_staff_audit FOR EACH ROW EXECUTE FUNCTION staff_slow_audit()');
  try {
    const started = performance.now();
    await assert.rejects(service.readWithAccess(user, org.id, detailsPolicy, async client => {
      await client.query("UPDATE platform_sessions SET expires_at=clock_timestamp()+interval '300 milliseconds' WHERE token_hash=$1", [user.tokenHash]);
      return { value: 'Synthetic late data must be withheld', recordCount: 1 };
    }), authRequired);
    assert(performance.now() - started >= 350); assert.deepEqual(await audits(user), []);
  } finally { await db.query('DROP TRIGGER staff_slow_audit ON platform_staff_audit'); await db.query('DROP FUNCTION staff_slow_audit()'); }
});

test('audit fields contain only IDs, closed enums and counts, never the read payload or user contact data', async () => {
  const user = await actor(), org = await organization(); await grant(user, org.id);
  const secret = 'Synthetic private body not for audit'; assert.equal(await service.readWithAccess(user, org.id, detailsPolicy, async () => ({ value: secret, recordCount: 1 })), secret);
  const row = (await db.query('SELECT * FROM platform_staff_audit WHERE user_id=$1', [user.userId])).rows[0];
  assert.deepEqual(Object.keys(row).sort(), ['action', 'created_at', 'id', 'org_id', 'outcome', 'reason', 'record_count', 'role', 'target_id', 'user_id']);
  assert(!JSON.stringify(row).includes(secret)); assert(!JSON.stringify(row).includes('@example.invalid'));
});

test('feature-disabled denial is durable for a valid student session without granting or reading any role', async () => {
  const user = await actor('student'), requestedOrg = randomUUID();
  await service.recordDeniedAccess(user, requestedOrg, 'provider_details_viewed', 'feature_disabled');
  await service.recordDeniedAccess(user, undefined, 'provider_details_viewed', 'feature_disabled');
  const rows = await audits(user); assert.equal(rows.length, 2);
  assert(rows.every(row => row.outcome === 'deny' && row.reason === 'feature_disabled' && row.role === null && row.record_count === 0));
  assert.deepEqual(rows.map(row => row.org_id), [requestedOrg, null]);
  await db.query('DELETE FROM platform_sessions WHERE token_hash=$1', [user.tokenHash]);
  await assert.rejects(service.recordDeniedAccess(user, requestedOrg, 'provider_details_viewed', 'feature_disabled'), authRequired);
  assert.equal((await audits(user)).length, 2);
});

test('disabled-feature audit failure is not silently converted to a successful denial receipt', async () => {
  const user = await actor();
  await db.query("ALTER TABLE platform_staff_audit ADD CONSTRAINT synthetic_feature_failure CHECK (reason<>'feature_disabled') NOT VALID");
  try {
    await assert.rejects(service.recordDeniedAccess(user, undefined, 'provider_details_viewed', 'feature_disabled'), { code: '23514' });
    assert.deepEqual(await audits(user), []);
  } finally { await db.query('ALTER TABLE platform_staff_audit DROP CONSTRAINT synthetic_feature_failure'); }
});

test('staff migration can be rerun without altering existing accounts, roles or audit receipts', async () => {
  const user = await actor(), org = await organization(); await grant(user, org.id); await service.getOrganization(user, org.id);
  const previous = await audits(user);
  await db.query(await fs.readFile(new URL('../migrations/024_staff_access.sql', import.meta.url), 'utf8'));
  assert.deepEqual(await audits(user), previous); assert.equal((await db.query('SELECT account_kind FROM platform_users WHERE id=$1', [user.userId])).rows[0].account_kind, 'staff');
  assert.equal((await db.query('SELECT status FROM platform_org_roles WHERE org_id=$1 AND user_id=$2', [org.id, user.userId])).rows[0].status, 'active');
});
