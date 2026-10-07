import { FICTIONAL_LEGAL, fictionalRegistration, seedFictionalActiveLegal } from './fixtures/student-entry.ts';
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { PlatformProviderRuntime, StaffRole } from '@companion/platform-contracts';
import { PLATFORM_ACCOUNT_HEADER } from '@companion/platform-contracts';
import { buildApp } from '../src/app.ts';
import { readConfig } from '../src/config.ts';
import { Database } from '../src/database.ts';

const origin = 'http://localhost:4321', prefix = '/api/platform';
const base = readConfig({ ...process.env, NODE_ENV: 'development', PLATFORM_ENABLE_WORKBENCH: '1', PLATFORM_EXPOSE_PROVIDER_DETAILS: '1' ,PLATFORM_REQUIRE_INVITE:'1'});
const schema = `staff_routes_${randomUUID().replaceAll('-', '')}`, admin = new Database(base.databaseUrl), url = new URL(base.databaseUrl);
url.searchParams.set('options', `-c search_path=${schema}`);
const db = new Database(url.toString());
let schemaCreated = false, runtimeReads = 0;
const noModel = async (): Promise<never> => { throw new Error('This access fixture never calls a model.'); };
const runtime: PlatformProviderRuntime = {
  capabilities() {
    runtimeReads++;
    return [{ id: 'fictional-access-runtime', name: 'Fictional access runtime', enabled: false, keyConfigured: false,
      capabilities: ['chat'], models: ['fictional-access-model'], envVariables: ['FICTIONAL_CONFIG_NAME'] }];
  },
  async *streamChat() { await noModel(); }, executeJob: noModel, createVoiceSession: noModel, transcribe: noModel, speech: noModel,
};
let system: Awaited<ReturnType<typeof buildApp>>, closed: typeof system;
type Actor = { id: string; cookie: string };

before(async () => {
  await admin.query(`CREATE SCHEMA ${schema}`); schemaCreated = true; await db.migrate(); await seedFictionalActiveLegal(db);
  const config = { ...base, databaseUrl: url.toString(), mcp: undefined };
  system = await buildApp({legalBundle:FICTIONAL_LEGAL, db, config, runtime, enableQueue: false });
  closed = await buildApp({legalBundle:FICTIONAL_LEGAL, db, config: { ...config, exposeProviderDetails: false }, runtime, enableQueue: false });
});
after(async () => {
  await Promise.all([system?.app.close(), closed?.app.close()]); await db.close();
  if (schemaCreated) await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.close();
});
let registrationAddress=0;
async function actor(extra: Record<string, unknown> = {}): Promise<Actor> {
  const response = await system.app.inject({ method: 'POST', url: prefix + '/auth/register', remoteAddress:'127.13.0.'+(++registrationAddress), headers: { origin },
    payload: await fictionalRegistration(db,{ email: `${randomUUID()}@example.invalid`, name: 'Fictional access fixture', password: 'fictional-staff-access-password', ...extra }) });
  assert.equal(response.statusCode, 201, response.body);
  return { id: response.json().user.id, cookie: String(response.headers['set-cookie']).split(';')[0] };
}
async function organization() {
  const id = randomUUID();
  await db.query('INSERT INTO platform_orgs(id,slug,display_name) VALUES($1,$2,$3)', [id, `fixture_${id.replaceAll('-', '')}`, 'Fictional organization']);
  return id;
}
async function grant(who: Actor, orgId: string, role: StaffRole, staff = true) {
  if (staff) await db.query("UPDATE platform_users SET account_kind='staff' WHERE id=$1", [who.id]);
  await db.query('INSERT INTO platform_org_roles(org_id,user_id,role,granted_by) VALUES($1,$2,$3,$2)', [orgId, who.id, role]);
}
function request(who: Actor, route: string, headers: Record<string, string> = {}, target = system) {
  return target.app.inject({ method: 'GET', url: prefix + route,
    headers: { origin, cookie: who.cookie, [PLATFORM_ACCOUNT_HEADER]: who.id, ...headers } });
}
async function audits(who: Actor) {
  return (await db.query('SELECT * FROM platform_staff_audit WHERE user_id=$1 ORDER BY created_at,id', [who.id])).rows;
}

test('public registration and forged staff headers cannot create a staff identity, even with a role row', async () => {
  const forgedEmail=randomUUID()+'@example.invalid';
  const forged=await system.app.inject({method:'POST',url:prefix+'/auth/register',remoteAddress:'127.13.1.1',headers:{origin},payload:await fictionalRegistration(db,{email:forgedEmail,name:'Fictional rejected self-promotion',password:'fictional-staff-access-password',account_kind:'staff',role:'org_admin',isAdmin:true})});
  assert.equal(forged.statusCode,400,forged.body);assert.equal(forged.json().error.code,'INVALID_INPUT');
  assert.equal((await db.query('SELECT id FROM platform_users WHERE email=$1',[forgedEmail])).rowCount,0);
  const who = await actor(), orgId = await organization();
  await grant(who, orgId, 'org_admin', false);
  const current = await db.query('SELECT account_kind FROM platform_users WHERE id=$1', [who.id]);
  assert.equal(current.rows[0].account_kind, 'student');
  const reads = runtimeReads;
  for (const route of [`/staff/orgs/${orgId}`, `/staff/orgs/${orgId}/members`, `/capabilities/details?orgId=${orgId}`]) {
    const response = await request(who, route, { 'x-companion-role': 'org_admin', 'x-companion-staff': 'true' });
    assert.equal(response.statusCode, 403, response.body); assert.equal(response.json().error.code, 'STAFF_ROLE_REQUIRED');
    assert.equal(response.headers['cache-control'], 'private, no-store');
  }
  assert.equal(runtimeReads, reads, 'Denied diagnostic requests must not read provider details.');
  const records = await audits(who); assert.equal(records.length, 3);
  assert(records.every(row => row.outcome === 'deny' && row.reason === 'student_account' && row.record_count === 0));
});

test('staff routes retain real cookie and account assertion requirements', async () => {
  const who = await actor(), orgId = await organization(); await grant(who, orgId, 'ops');
  const route = `/staff/orgs/${orgId}`;
  assert.equal((await system.app.inject({ url: prefix + route })).statusCode, 401);
  assert.equal((await system.app.inject({ url: prefix + route, headers: { cookie: who.cookie } })).statusCode, 409);
  assert.equal((await request(who, route, { [PLATFORM_ACCOUNT_HEADER]: randomUUID() })).statusCode, 409);
  assert.equal((await request(who, route, { [PLATFORM_ACCOUNT_HEADER]: 'invalid' })).statusCode, 400);
  const duplicate = await request(who, route, { [PLATFORM_ACCOUNT_HEADER]: `${who.id}, ${who.id}` });
  assert.equal(duplicate.statusCode, 400);
  assert.equal((await audits(who)).length, 0, 'These requests never reached authenticated staff access.');
});

test('ops can read scoped organization, safe membership metadata and diagnostics, with one receipt per read', async () => {
  const who = await actor(), mentor = await actor(), student = await actor(), orgId = await organization();
  await grant(who, orgId, 'ops'); await grant(mentor, orgId, 'mentor'); await grant(student, orgId, 'ops', false);
  const org = await request(who, `/staff/orgs/${orgId}`);
  assert.equal(org.statusCode, 200, org.body);
  assert.deepEqual(Object.keys(org.json().organization).sort(), ['displayName', 'id', 'slug', 'status']);
  assert.equal(org.json().organization.id, orgId);
  const members = await request(who, `/staff/orgs/${orgId}/members`);
  assert.equal(members.statusCode, 200, members.body); assert.equal(members.json().memberships.length, 2);
  for (const member of members.json().memberships) {
    assert.deepEqual(Object.keys(member).sort(), ['organizationId', 'role', 'userId']);
    assert.equal(member.organizationId, orgId); assert.notEqual(member.userId, student.id);
  }
  for (let index = 0; index < 2; index++) {
    const details = await request(who, `/capabilities/details?orgId=${orgId}`);
    assert.equal(details.statusCode, 200, details.body);
    assert.equal(details.json().providers[0].id, 'fictional-access-runtime');
    assert.equal(details.headers['cache-control'], 'private, no-store');
  }
  const records = await audits(who); assert.equal(records.length, 4);
  assert(records.every(row => row.outcome === 'allow' && row.role === 'ops' && row.org_id === orgId));
  assert.deepEqual(records.map(row => row.record_count).sort(), [1, 1, 1, 2]);
  const serialized = JSON.stringify(records);
  for (const forbidden of ['Fictional', 'fictional-access', 'example.invalid', 'FICTIONAL_CONFIG_NAME', who.cookie]) assert(!serialized.includes(forbidden));
});

test('content roles can read their organization but cannot borrow ops privileges or another organization', async () => {
  const who = await actor(), orgId = await organization(), elsewhere = await organization();
  await grant(who, orgId, 'content_editor'); await grant(who, elsewhere, 'ops');
  assert.equal((await request(who, `/staff/orgs/${orgId}`)).statusCode, 200);
  for (const route of [`/staff/orgs/${orgId}/members`, `/capabilities/details?orgId=${orgId}`, `/staff/orgs/${randomUUID()}`]) {
    const response = await request(who, route); assert.equal(response.statusCode, 403, response.body);
    assert.equal(response.json().error.code, 'STAFF_ROLE_REQUIRED');
  }
  const records = await audits(who); assert.equal(records.length, 4);
  assert.equal(records.filter(row => row.outcome === 'deny').length, 3);
});

test('role revocation and organization shutdown remove access on the next request', async () => {
  const who = await actor(), orgId = await organization(); await grant(who, orgId, 'org_admin');
  assert.equal((await request(who, `/staff/orgs/${orgId}/members`)).statusCode, 200);
  await db.query("UPDATE platform_org_roles SET status='revoked',revoked_at=now() WHERE org_id=$1 AND user_id=$2", [orgId, who.id]);
  assert.equal((await request(who, `/staff/orgs/${orgId}/members`)).statusCode, 403);
  await db.query("UPDATE platform_org_roles SET status='active',revoked_at=NULL WHERE org_id=$1 AND user_id=$2", [orgId, who.id]);
  await db.query("UPDATE platform_orgs SET status='disabled' WHERE id=$1", [orgId]);
  assert.equal((await request(who, `/staff/orgs/${orgId}`)).statusCode, 403);
  const records = await audits(who); assert.equal(records.length, 3);
  assert.deepEqual(records.map(row => row.outcome), ['allow', 'deny', 'deny']);
});

test('diagnostics still require the development flag and explicit organization context', async () => {
  const who = await actor(), orgId = await organization(); await grant(who, orgId, 'ops');
  const reads = runtimeReads;
  const disabled = await request(who, `/capabilities/details?orgId=${orgId}`, {}, closed);
  assert.equal(disabled.statusCode, 403); assert.equal(disabled.json().error.code, 'PROVIDER_DETAILS_DISABLED');
  const missing = await request(who, '/capabilities/details');
  assert.equal(missing.statusCode, 403); assert.equal(missing.json().error.code, 'STAFF_ROLE_REQUIRED');
  assert.equal(runtimeReads, reads);
  const records = await audits(who); assert.equal(records.length, 2);
  assert.equal(records[0].reason, 'feature_disabled'); assert.equal(records[0].org_id, orgId);
  assert.equal(records[1].reason, 'organization_missing'); assert.equal(records[1].org_id, null);
  assert.equal((await request(who, `/capabilities/details?orgId=${orgId}&role=org_admin`)).statusCode, 400);
  assert.equal((await request(who, `/staff/orgs/${orgId}?role=org_admin`)).statusCode, 400);
});

test('an audit write failure returns no diagnostic data and preserves the database failure', async () => {
  const who = await actor(), orgId = await organization(); await grant(who, orgId, 'ops');
  await db.query(`CREATE FUNCTION block_fixture_audit() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RAISE EXCEPTION 'Fictional audit write failure'; END$$`);
  await db.query('CREATE TRIGGER block_fixture_audit BEFORE INSERT ON platform_staff_audit FOR EACH ROW EXECUTE FUNCTION block_fixture_audit()');
  try {
    const response = await request(who, `/capabilities/details?orgId=${orgId}`);
    assert.equal(response.statusCode, 503, response.body);
    assert.equal(response.json().error.code, 'STAFF_ACCESS_UNAVAILABLE');
    assert(!response.body.includes('fictional-access-runtime')); assert(!response.body.includes('Fictional audit write failure'));
    assert.equal((await audits(who)).length, 0);
  } finally {
    await db.query('DROP TRIGGER block_fixture_audit ON platform_staff_audit'); await db.query('DROP FUNCTION block_fixture_audit()');
  }
});

test('there is no HTTP path to promote an account or grant an organization role', async () => {
  const who = await actor(), orgId = await organization();
  for (const route of ['/staff/roles', `/staff/orgs/${orgId}/members`, '/staff/accounts']) {
    const response = await system.app.inject({ method: 'POST', url: prefix + route,
      headers: { origin, cookie: who.cookie, [PLATFORM_ACCOUNT_HEADER]: who.id }, payload: { role: 'org_admin', account_kind: 'staff' } });
    assert.equal(response.statusCode, 404, response.body);
  }
  assert.equal((await db.query('SELECT account_kind FROM platform_users WHERE id=$1', [who.id])).rows[0].account_kind, 'student');
  assert.equal((await db.query('SELECT * FROM platform_org_roles WHERE user_id=$1', [who.id])).rowCount, 0);
});
