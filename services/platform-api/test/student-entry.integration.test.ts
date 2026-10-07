import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { InjectOptions } from 'fastify';
import type { PoolClient } from 'pg';
import { PLATFORM_ACCOUNT_HEADER, type StudentConsentStatus, type User } from '@companion/platform-contracts';
import { buildApp } from '../src/app.ts';
import { checkPassword, tokenHash } from '../src/auth.ts';
import { readConfig } from '../src/config.ts';
import { Database } from '../src/database.ts';
import type { LegalBundle } from '../src/legal-documents.ts';
import { invitationEmailDigest, inviteCodeHash } from '../src/student-entry.ts';
import {
  FICTIONAL_LEGAL, fictionalAcceptance, fictionalLegalBundle, seedFictionalActiveLegal, seedFictionalInvite,
} from './fixtures/student-entry.ts';

// Every identity, legal document and invitation is fictional. No model, mailer or external service is used.
const origin = 'http://localhost:4321', prefix = '/api/platform';
const base = readConfig({ ...process.env, NODE_ENV: 'development', PLATFORM_ENABLE_WORKBENCH: '0',
  PLATFORM_EXPOSE_PROVIDER_DETAILS: '0', PLATFORM_REQUIRE_INVITE: '1' });
const schema = `student_entry_${randomUUID().replaceAll('-', '')}`;
const url = new URL(base.databaseUrl);
url.searchParams.set('options', `-c search_path=${schema}`);
const admin = new Database(base.databaseUrl, { max: 2 });
const db = new Database(url.toString(), { max: 8 });
type System = Awaited<ReturnType<typeof buildApp>>;
const systems: System[] = [];
let student: System, directory: string | undefined, schemaCreated = false;
const password = 'Fictional-test-password-2026!';
const runtimeCalls: string[] = [];

async function system(bundle: LegalBundle | null = FICTIONAL_LEGAL, requireInvite = true): Promise<System> {
  const result = await buildApp({ db, legalBundle: bundle, enableQueue: false,
    config: { ...base, databaseUrl: url.toString(), storageDir: directory!, allowedOrigins: new Set([origin]),
      requireInvite, requireVerifiedEmail: false, accountEmail: undefined, s3: undefined, mcp: undefined, webStaticDir: undefined },
    runtime: {
      capabilities: () => [],
      async *streamChat() { runtimeCalls.push('chat'); throw new Error('O0 never calls a model.'); },
      async executeJob() { runtimeCalls.push('job'); throw new Error('O0 never starts a worker.'); },
      async createVoiceSession() { runtimeCalls.push('realtime'); throw new Error('O0 never opens a voice session.'); },
      async transcribe() { runtimeCalls.push('transcription'); throw new Error('O0 never transcribes audio.'); },
      async speech() { runtimeCalls.push('speech'); throw new Error('O0 never synthesizes speech.'); },
    },
    requestLimits: { policies: {
      'auth-register': { max: 2000, windowSeconds: 60 }, 'auth-login': { max: 2000, windowSeconds: 60 },
      public: { max: 2000, windowSeconds: 60 }, control: { max: 2000, windowSeconds: 60 }, api: { max: 2000, windowSeconds: 60 },
    } },
  });
  systems.push(result); return result;
}

before(async () => {
  assert(process.env.PLATFORM_DATABASE_URL, 'Supply an explicit, dedicated PostgreSQL fixture URL.');
  assert(['localhost', '127.0.0.1', '[::1]'].includes(url.hostname), 'This write fixture requires a loopback database.');
  await admin.query(`CREATE SCHEMA ${schema}`); schemaCreated = true;
  await db.migrate();
  for (const table of ['platform_terms_policy', 'platform_invites', 'platform_terms_consents']) {
    assert.equal((await db.query(`SELECT count(*)::int AS count FROM ${table}`)).rows[0].count, 0, 'Migrations must not issue invitations or legal consent.');
  }
  await seedFictionalActiveLegal(db);
  await db.query('CREATE TABLE student_entry_commit_probe(id integer PRIMARY KEY)');
  await db.query('INSERT INTO student_entry_commit_probe(id) VALUES(1)');
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'companion-student-entry-'));
  student = await system();
});
after(async () => {
  try {
    for (const result of systems) await result.app.close();
    assert.deepEqual(runtimeCalls, [], 'Registration/consent must not invoke paid or synthetic models.');
  } finally {
    await db.close();
    try { if (schemaCreated) await admin.query(`DROP SCHEMA ${schema} CASCADE`); }
    finally { await admin.close(); if (directory) await fs.rm(directory, { recursive: true, force: true }); }
  }
});

function registration(email = `${randomUUID()}@example.invalid`, code = randomBytes(24).toString('base64url')) {
  return { email, name: 'Fictional STEM graduate', password, inviteCode: code, consent: fictionalAcceptance() };
}
type Registration = ReturnType<typeof registration>;
function register(input: InjectOptions['payload'], target = student) {
  return target.app.inject({ method: 'POST', url: `${prefix}/auth/register`, payload: input, headers: { origin } });
}
type Response = Awaited<ReturnType<typeof register>>;
function refused(response: Response, status: number, code: string) {
  assert.equal(response.statusCode, status, response.body);
  assert.equal(response.json<{ error: { code: string } }>().error.code, code);
  assert.equal(response.headers['set-cookie'], undefined, 'A refused transaction must not issue a login cookie.');
}
function sessionCookie(response: Response) {
  const header = response.headers['set-cookie'];
  assert.equal(typeof header, 'string');
  assert(typeof header === 'string');
  assert.match(header, /HttpOnly/i); assert.match(header, /SameSite=Lax/i);
  const cookie = header.split(';')[0];
  assert.match(cookie, /^companion_session=[A-Za-z0-9_-]+$/);
  return cookie;
}
async function actor(email = `${randomUUID()}@example.invalid`): Promise<{ userId: string; cookie: string; tokenHash: string }> {
  const userId = randomUUID(), token = randomBytes(32).toString('base64url');
  await db.query('INSERT INTO platform_users(id,email,name,password_hash) VALUES($1,$2,$3,$4)',
    [userId, email, 'Fictional existing student', 'synthetic-unused-password-hash']);
  await db.query("INSERT INTO platform_sessions(token_hash,user_id,expires_at,auth_version) VALUES($1,$2,now()+interval '1 hour',0)", [tokenHash(token), userId]);
  return { userId, cookie: `companion_session=${token}`, tokenHash: tokenHash(token) };
}
type Actor = Awaited<ReturnType<typeof actor>>;
function consent(owner: Actor, method: 'GET' | 'POST', payload?: InjectOptions['payload'], target = student, account = owner.userId) {
  return target.app.inject({ method, url: `${prefix}/auth/consent`, payload,
    headers: { origin, cookie: owner.cookie, [PLATFORM_ACCOUNT_HEADER]: account } });
}
async function records(email: string, code: string) {
  const result = await db.query(`SELECT
    (SELECT count(*)::int FROM platform_users WHERE email=$1) AS users,
    (SELECT count(*)::int FROM platform_terms_consents c JOIN platform_users u ON u.id=c.user_id WHERE u.email=$1) AS consents,
    (SELECT count(*)::int FROM platform_sessions s JOIN platform_users u ON u.id=s.user_id WHERE u.email=$1) AS sessions`, [email]);
  const invite = await db.query('SELECT redeemed_at,redeemed_user_id FROM platform_invites WHERE code_hash=$1', [inviteCodeHash(code)]);
  return { ...result.rows[0], invite: invite.rows[0] ?? null };
}
async function emptyRegistration(input: Registration) {
  assert.deepEqual(await records(input.email.toLowerCase(), input.inviteCode), {
    users: 0, consents: 0, sessions: 0, invite: { redeemed_at: null, redeemed_user_id: null },
  });
}
async function sessionFor(response: Response): Promise<Actor> {
  assert.equal(response.statusCode, 201, response.body);
  const user = response.json<{ user: User }>().user, cookie = sessionCookie(response);
  const hash = tokenHash(cookie.slice('companion_session='.length));
  const session = await db.query('SELECT user_id FROM platform_sessions WHERE token_hash=$1', [hash]);
  assert.deepEqual(session.rows, [{ user_id: user.id }]);
  return { userId: user.id, cookie, tokenHash: hash };
}
async function backendPid(client: PoolClient) { return Number((await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid); }
async function waitForBlocker(blocker: number, minimum = 1) {
  // Bounded transactions use a 500ms PostgreSQL lock timeout. Release only after observing the real blocker.
  const until = Date.now() + 400;
  while (Date.now() < until) {
    const result = await db.query(`WITH RECURSIVE blocked AS (
      SELECT pid FROM pg_stat_activity WHERE datname=current_database() AND $1=ANY(pg_blocking_pids(pid))
      UNION
      SELECT activity.pid FROM pg_stat_activity activity JOIN blocked parent
        ON parent.pid=ANY(pg_blocking_pids(activity.pid)) WHERE activity.datname=current_database()
    ) SELECT count(*)::int AS count FROM blocked`, [blocker]);
    if (result.rows[0].count >= minimum) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.fail('The owned HTTP operation did not reach its expected PostgreSQL row lock.');
}
async function failInsert(table: 'platform_terms_consents' | 'platform_sessions') {
  await db.query(`CREATE FUNCTION student_entry_fail_insert() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'Synthetic O0 write failure' USING ERRCODE='23514'; END $$`);
  await db.query(`CREATE TRIGGER student_entry_fail_insert BEFORE INSERT ON ${table}
    FOR EACH ROW EXECUTE FUNCTION student_entry_fail_insert()`);
}
async function removeInsertFailure(table: 'platform_terms_consents' | 'platform_sessions') {
  await db.query(`DROP TRIGGER IF EXISTS student_entry_fail_insert ON ${table}`);
  await db.query('DROP FUNCTION IF EXISTS student_entry_fail_insert()');
}

test('anonymous options expose the exact active fictional documents without internal review metadata', async () => {
  const options = await student.app.inject({ method: 'GET', url: `${prefix}/auth/options` });
  assert.equal(options.statusCode, 200); assert.equal(options.headers['cache-control'], 'private, no-store');
  assert.deepEqual(options.json(), { emailActionsEnabled: false, requireVerifiedEmail: false, requireInvite: true,
    legal: { status: 'available', version: FICTIONAL_LEGAL.version, digest: FICTIONAL_LEGAL.digest } });
  const docs = await student.app.inject({ method: 'GET', url: `${prefix}/auth/legal-documents` });
  assert.equal(docs.statusCode, 200); assert.equal(docs.headers['cache-control'], 'no-store');
  assert.deepEqual(docs.json(), { status: 'available', version: FICTIONAL_LEGAL.version, digest: FICTIONAL_LEGAL.digest,
    terms: { ...FICTIONAL_LEGAL.terms }, privacy: { ...FICTIONAL_LEGAL.privacy }, dataNotice: FICTIONAL_LEGAL.dataNotice });
});

test('unavailable or inactive legal documents cannot register an account or fabricate consent', async () => {
  const input = registration(); await seedFictionalInvite(db, input.email, input.inviteCode);
  for (const bundle of [null, fictionalLegalBundle('fictional-not-active')]) {
    const target = await system(bundle);
    const options = await target.app.inject({ method: 'GET', url: `${prefix}/auth/options` });
    assert.deepEqual(options.json().legal, { status: 'unavailable' });
    const docs = await target.app.inject({ method: 'GET', url: `${prefix}/auth/legal-documents` });
    assert.deepEqual(docs.json(), { status: 'unavailable' });
    refused(await register(input, target), 503, 'LEGAL_DOCUMENTS_UNAVAILABLE');
    await emptyRegistration(input);
  }
});

test('registration atomically stores normalized identity, exact consent, invitation and usable secure session', async () => {
  const email = `${randomUUID()}@example.invalid`, input = registration(email.toUpperCase());
  await seedFictionalInvite(db, email, input.inviteCode);
  const response = await register(input), owner = await sessionFor(response);
  assert.equal(response.headers['cache-control'], 'private, no-store');
  assert.deepEqual(response.json(), { user: { id: owner.userId, email, name: input.name, emailVerified: false } });
  const user = (await db.query('SELECT email,password_hash,account_kind FROM platform_users WHERE id=$1', [owner.userId])).rows[0];
  assert.equal(user.email, email); assert.equal(user.account_kind, 'student');
  assert.notEqual(user.password_hash, password); assert(await checkPassword(password, user.password_hash));
  const terms = await db.query('SELECT user_id,terms_version,content_digest,consented_at FROM platform_terms_consents WHERE user_id=$1', [owner.userId]);
  assert.equal(terms.rowCount, 1); assert.equal(terms.rows[0].terms_version, FICTIONAL_LEGAL.version);
  assert.equal(terms.rows[0].content_digest, FICTIONAL_LEGAL.digest); assert(terms.rows[0].consented_at instanceof Date);
  const state = await records(email, input.inviteCode);
  assert.equal(state.users, 1); assert.equal(state.consents, 1); assert.equal(state.sessions, 1);
  assert.equal(state.invite.redeemed_user_id, owner.userId); assert(state.invite.redeemed_at instanceof Date);
  const me = await student.app.inject({ method: 'GET', url: `${prefix}/auth/me`, headers: { cookie: owner.cookie } });
  assert.equal(me.statusCode, 200); assert.equal(me.json().user.id, owner.userId);
  const status = await consent(owner, 'GET');
  assert.deepEqual(status.json().consent, { userId: owner.userId, status: 'current', version: FICTIONAL_LEGAL.version, digest: FICTIONAL_LEGAL.digest });
  const logout = await student.app.inject({ method: 'POST', url: `${prefix}/auth/logout`, headers: { origin, cookie: owner.cookie, [PLATFORM_ACCOUNT_HEADER]: owner.userId } });
  assert.equal(logout.statusCode, 200);
  assert.equal((await db.query('SELECT token_hash FROM platform_sessions WHERE token_hash=$1', [owner.tokenHash])).rowCount, 0);
  assert.equal((await student.app.inject({ method: 'GET', url: `${prefix}/auth/me`, headers: { cookie: owner.cookie } })).statusCode, 401);
  assert.equal((await db.query('SELECT user_id FROM platform_terms_consents WHERE user_id=$1', [owner.userId])).rowCount, 1, 'Logout preserves the durable acceptance.');
});

test('two concurrent registrations can redeem one invitation only once', { timeout: 5000 }, async () => {
  const input = registration(); await seedFictionalInvite(db, input.email, input.inviteCode);
  const holder = await db.pool.connect(); let pending: Promise<Response[]> | undefined;
  try {
    await holder.query('BEGIN'); await holder.query('SELECT code_hash FROM platform_invites WHERE code_hash=$1 FOR UPDATE', [inviteCodeHash(input.inviteCode)]);
    pending = Promise.all([register(input), register(input)]);
    await waitForBlocker(await backendPid(holder), 2);
    await holder.query('COMMIT');
    const responses = await pending, successes = responses.filter(response => response.statusCode === 201);
    assert.equal(successes.length, 1); assert.equal(responses.filter(response => response.statusCode === 403).length, 1);
    refused(responses.find(response => response.statusCode !== 201)!, 403, 'INVITE_INVALID');
    const owner = await sessionFor(successes[0]), state = await records(input.email, input.inviteCode);
    assert.equal(state.users, 1); assert.equal(state.consents, 1); assert.equal(state.sessions, 1);
    assert.equal(state.invite.redeemed_user_id, owner.userId);
    refused(await register(input), 403, 'INVITE_INVALID');
  } finally { await holder.query('ROLLBACK'); holder.release(); if (pending) await pending; }
});

test('an invitation cannot be redeemed for another email or after its database-clock expiry', async () => {
  const input = registration(), foreignEmail = `${randomUUID()}@example.invalid`;
  await seedFictionalInvite(db, input.email, input.inviteCode);
  refused(await register({ ...input, email: foreignEmail }), 403, 'INVITE_INVALID');
  await emptyRegistration(input);
  assert.equal((await db.query('SELECT id FROM platform_users WHERE email=$1', [foreignEmail])).rowCount, 0);
  const expired = registration(); await seedFictionalInvite(db, expired.email, expired.inviteCode, new Date(Date.now() - 60_000));
  refused(await register(expired), 403, 'INVITE_INVALID'); await emptyRegistration(expired);
  const unknown = registration(); refused(await register(unknown), 403, 'INVITE_INVALID');
  assert.deepEqual(await records(unknown.email, unknown.inviteCode), { users: 0, consents: 0, sessions: 0, invite: null });
});

test('the invitation requirement is server owned and optional registration still needs explicit consent', async () => {
  const input = registration(); await seedFictionalInvite(db, input.email, input.inviteCode);
  const { inviteCode: _omitted, ...withoutInvite } = input;
  refused(await register(withoutInvite), 403, 'INVITE_REQUIRED'); await emptyRegistration(input);
  refused(await register({ ...withoutInvite, requireInvite: false }), 400, 'INVALID_INPUT'); await emptyRegistration(input);
  const optional = await system(FICTIONAL_LEGAL, false), other = registration();
  const { inviteCode: _unused, ...optionalInput } = other;
  const response = await register(optionalInput, optional), owner = await sessionFor(response);
  assert.equal((await db.query('SELECT user_id FROM platform_terms_consents WHERE user_id=$1', [owner.userId])).rowCount, 1);
  assert.equal((await db.query('SELECT code_hash FROM platform_invites WHERE code_hash=$1', [inviteCodeHash(other.inviteCode)])).rowCount, 0);
});

test('missing, false, incomplete or altered acceptance cannot consume an invitation', async t => {
  const variants: Array<{ name: string; acceptance: unknown; status: number; code: string }> = [
    { name: 'missing consent', acceptance: undefined, status: 400, code: 'INVALID_INPUT' },
    { name: 'unchecked checkbox', acceptance: { ...fictionalAcceptance(), accepted: false }, status: 400, code: 'INVALID_INPUT' },
    { name: 'truthy non-boolean', acceptance: { ...fictionalAcceptance(), accepted: 1 }, status: 400, code: 'INVALID_INPUT' },
    { name: 'missing digest', acceptance: { accepted: true, version: FICTIONAL_LEGAL.version }, status: 400, code: 'INVALID_INPUT' },
    { name: 'extra account grant', acceptance: { ...fictionalAcceptance(), userId: randomUUID() }, status: 400, code: 'INVALID_INPUT' },
    { name: 'old displayed version', acceptance: { ...fictionalAcceptance(), version: 'fictional-old' }, status: 409, code: 'TERMS_VERSION_CHANGED' },
    { name: 'changed content digest', acceptance: { ...fictionalAcceptance(), digest: '0'.repeat(64) }, status: 409, code: 'TERMS_VERSION_CHANGED' },
  ];
  for (const variant of variants) await t.test(variant.name, async () => {
    const input = registration(); await seedFictionalInvite(db, input.email, input.inviteCode);
    refused(await register({ ...input, consent: variant.acceptance }), variant.status, variant.code); await emptyRegistration(input);
  });
  const missing = await register(undefined); refused(missing, 400, 'INVALID_INPUT');
});

test('duplicate email rolls back without consuming the fresh invitation or changing the original account', async () => {
  const original = await actor(), email = (await db.query('SELECT email FROM platform_users WHERE id=$1', [original.userId])).rows[0].email as string;
  const input = registration(email); await seedFictionalInvite(db, email, input.inviteCode);
  const before = await records(email, input.inviteCode);
  refused(await register(input), 409, 'EMAIL_EXISTS'); assert.deepEqual(await records(email, input.inviteCode), before);
  assert.equal(before.users, 1); assert.equal(before.sessions, 1); assert.equal(before.consents, 0);
});

for (const table of ['platform_terms_consents', 'platform_sessions'] as const) {
  test(`${table} insert failure rolls back identity and invitation and permits a real retry`, async () => {
    const input = registration(); await seedFictionalInvite(db, input.email, input.inviteCode);
    await failInsert(table);
    try { refused(await register(input), 502, 'RESPONSE_FAILED'); await emptyRegistration(input); }
    finally { await removeInsertFailure(table); }
    const owner = await sessionFor(await register(input)), state = await records(input.email, input.inviteCode);
    assert.equal(state.users, 1); assert.equal(state.consents, 1); assert.equal(state.sessions, 1);
    assert.equal(state.invite.redeemed_user_id, owner.userId);
  });
}

test('registration publishes neither response nor session cookie before its actual PostgreSQL COMMIT', { timeout: 5000 }, async () => {
  const input = registration(); await seedFictionalInvite(db, input.email, input.inviteCode);
  await db.query(`CREATE FUNCTION student_entry_wait_commit() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN PERFORM id FROM student_entry_commit_probe WHERE id=1 FOR UPDATE; RETURN NEW; END $$`);
  await db.query(`CREATE CONSTRAINT TRIGGER student_entry_wait_commit AFTER INSERT ON platform_terms_consents
    DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION student_entry_wait_commit()`);
  const holder = await db.pool.connect(); let settled = false, pending: Promise<Response> | undefined;
  try {
    await holder.query('BEGIN'); await holder.query('SELECT id FROM student_entry_commit_probe WHERE id=1 FOR UPDATE');
    pending = register(input).then(response => { settled = true; return response; });
    await waitForBlocker(await backendPid(holder));
    assert.equal(settled, false, 'The HTTP promise remains pending while a deferred COMMIT trigger is held.');
    await emptyRegistration(input); // A separate committed reader cannot see the tentative account/session/consent.
    await holder.query('COMMIT');
    const owner = await sessionFor(await pending), state = await records(input.email, input.inviteCode);
    assert.equal(state.consents, 1); assert.equal(state.sessions, 1); assert.equal(state.invite.redeemed_user_id, owner.userId);
  } finally {
    await holder.query('ROLLBACK'); holder.release(); if (pending) await pending;
    await db.query('DROP TRIGGER IF EXISTS student_entry_wait_commit ON platform_terms_consents');
    await db.query('DROP FUNCTION IF EXISTS student_entry_wait_commit()');
  }
});

test('a failure during COMMIT leaves no cookie, user, consent or consumed invitation', async () => {
  const input = registration(); await seedFictionalInvite(db, input.email, input.inviteCode);
  await db.query(`CREATE FUNCTION student_entry_fail_commit() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'Synthetic O0 deferred commit failure' USING ERRCODE='23514'; END $$`);
  await db.query(`CREATE CONSTRAINT TRIGGER student_entry_fail_commit AFTER INSERT ON platform_sessions
    DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION student_entry_fail_commit()`);
  try { refused(await register(input), 502, 'RESPONSE_FAILED'); await emptyRegistration(input); }
  finally {
    await db.query('DROP TRIGGER IF EXISTS student_entry_fail_commit ON platform_sessions');
    await db.query('DROP FUNCTION IF EXISTS student_entry_fail_commit()');
  }
  await sessionFor(await register(input));
});

test('existing accounts require their own explicit confirmation and repeated confirmation is idempotent', async () => {
  const owner = await actor(), status = await consent(owner, 'GET');
  assert.equal(status.statusCode, 200); assert.equal(status.headers['cache-control'], 'private, no-store');
  assert.deepEqual(status.json().consent, { userId: owner.userId, status: 'required', version: FICTIONAL_LEGAL.version, digest: FICTIONAL_LEGAL.digest });
  for (const payload of [undefined, { ...fictionalAcceptance(), accepted: false }, { ...fictionalAcceptance(), version: 'fictional-old' }]) {
    const response = await consent(owner, 'POST', payload);
    refused(response, payload && payload.version === 'fictional-old' ? 409 : 400, payload && payload.version === 'fictional-old' ? 'TERMS_VERSION_CHANGED' : 'INVALID_INPUT');
    assert.equal((await db.query('SELECT user_id FROM platform_terms_consents WHERE user_id=$1', [owner.userId])).rowCount, 0);
  }
  const accepted = await consent(owner, 'POST', fictionalAcceptance());
  assert.equal(accepted.statusCode, 200); assert.equal(accepted.headers['set-cookie'], undefined);
  const saved = (await db.query('SELECT terms_version,content_digest,consented_at FROM platform_terms_consents WHERE user_id=$1', [owner.userId])).rows;
  assert.equal(saved.length, 1);
  const repeated = await consent(owner, 'POST', fictionalAcceptance());
  assert.equal(repeated.statusCode, 200); assert.deepEqual(repeated.json(), accepted.json());
  assert.deepEqual((await db.query('SELECT terms_version,content_digest,consented_at FROM platform_terms_consents WHERE user_id=$1', [owner.userId])).rows, saved);
});

test('active policy changes require new acceptance while preserving the exact historical version', async () => {
  const owner = await actor(); assert.equal((await consent(owner, 'POST', fictionalAcceptance())).statusCode, 200);
  const old = (await db.query('SELECT terms_version,content_digest,consented_at FROM platform_terms_consents WHERE user_id=$1', [owner.userId])).rows;
  const nextBundle = fictionalLegalBundle('fictional-v2'), next = await system(nextBundle);
  try {
    await seedFictionalActiveLegal(db, nextBundle);
    assert.deepEqual((await consent(owner, 'GET')).json().consent, { userId: owner.userId, status: 'unavailable', version: null, digest: null });
    refused(await consent(owner, 'POST', fictionalAcceptance()), 503, 'LEGAL_DOCUMENTS_UNAVAILABLE');
    const required = await consent(owner, 'GET', undefined, next);
    assert.deepEqual(required.json().consent, { userId: owner.userId, status: 'required', version: nextBundle.version, digest: nextBundle.digest });
    refused(await consent(owner, 'POST', fictionalAcceptance(), next), 409, 'TERMS_VERSION_CHANGED');
    const input = registration(); await seedFictionalInvite(db, input.email, input.inviteCode);
    refused(await register(input, next), 409, 'TERMS_VERSION_CHANGED'); await emptyRegistration(input);
    const accepted = await consent(owner, 'POST', fictionalAcceptance(nextBundle), next);
    assert.equal(accepted.statusCode, 200); assert.equal(accepted.json().consent.status, 'current');
    const history = (await db.query('SELECT terms_version,content_digest,consented_at FROM platform_terms_consents WHERE user_id=$1 ORDER BY terms_version', [owner.userId])).rows;
    assert.equal(history.length, 2); assert.deepEqual(history[0], old[0]); assert.equal(history[1].content_digest, nextBundle.digest);
    assert.equal((await consent(owner, 'POST', fictionalAcceptance(nextBundle), next)).statusCode, 200);
    assert.deepEqual((await db.query('SELECT terms_version,content_digest,consented_at FROM platform_terms_consents WHERE user_id=$1 ORDER BY terms_version', [owner.userId])).rows, history);
  } finally { await seedFictionalActiveLegal(db); }
});

test('a policy update holding the active row wins over a pending confirmation without granting either version', { timeout: 5000 }, async () => {
  const owner = await actor(), nextBundle = fictionalLegalBundle('fictional-race-v2'), holder = await db.pool.connect();
  let pending: Promise<Response> | undefined;
  try {
    await holder.query('BEGIN');
    await holder.query('UPDATE platform_terms_policy SET terms_version=$1,content_digest=$2,review_digest=$3 WHERE singleton=true', [nextBundle.version, nextBundle.digest, nextBundle.reviewDigest]);
    pending = consent(owner, 'POST', fictionalAcceptance());
    await waitForBlocker(await backendPid(holder)); await holder.query('COMMIT');
    refused(await pending, 503, 'LEGAL_DOCUMENTS_UNAVAILABLE');
    assert.equal((await db.query('SELECT user_id FROM platform_terms_consents WHERE user_id=$1', [owner.userId])).rowCount, 0);
  } finally { await holder.query('ROLLBACK'); holder.release(); if (pending) await pending; await seedFictionalActiveLegal(db); }
});

test('confirmation requires the real session and matching account context, never a requested userId', async () => {
  const owner = await actor(), other = await actor();
  const anonymous = await student.app.inject({ method: 'POST', url: `${prefix}/auth/consent`, payload: fictionalAcceptance(), headers: { origin, [PLATFORM_ACCOUNT_HEADER]: owner.userId } });
  refused(anonymous, 401, 'AUTH_REQUIRED');
  const missing = await student.app.inject({ method: 'POST', url: `${prefix}/auth/consent`, payload: fictionalAcceptance(), headers: { origin, cookie: owner.cookie } });
  refused(missing, 409, 'ACCOUNT_CONTEXT_REQUIRED');
  refused(await consent(owner, 'POST', fictionalAcceptance(), student, other.userId), 409, 'ACCOUNT_CONTEXT_CHANGED');
  refused(await consent(owner, 'POST', { ...fictionalAcceptance(), userId: other.userId }), 400, 'INVALID_INPUT');
  assert.equal((await db.query('SELECT user_id FROM platform_terms_consents WHERE user_id=ANY($1::uuid[])', [[owner.userId, other.userId]])).rowCount, 0);
});

for (const change of ['account_changed', 'session_deleted', 'password_reset', 'session_expired'] as const) {
  test(`captured account cannot accept after ${change} commits while its real user lock is pending`, { timeout: 5000 }, async () => {
    const owner = await actor(), other = await actor(), holder = await db.pool.connect();
    let pending: Promise<Response> | undefined;
    try {
      await holder.query('BEGIN'); await holder.query('SELECT id FROM platform_users WHERE id=$1 FOR UPDATE', [owner.userId]);
      pending = consent(owner, 'POST', fictionalAcceptance());
      await waitForBlocker(await backendPid(holder));
      if (change === 'account_changed') {
        // Synthetic race probe only: production has no session-owner reassignment endpoint.
        await holder.query('UPDATE platform_sessions SET user_id=$2 WHERE token_hash=$1', [owner.tokenHash, other.userId]);
      } else if (change === 'session_deleted') await holder.query('DELETE FROM platform_sessions WHERE token_hash=$1', [owner.tokenHash]);
      else if (change === 'password_reset') await holder.query('UPDATE platform_users SET auth_version=auth_version+1 WHERE id=$1', [owner.userId]);
      else await holder.query("UPDATE platform_sessions SET expires_at=clock_timestamp()-interval '1 second' WHERE token_hash=$1", [owner.tokenHash]);
      await holder.query('COMMIT'); refused(await pending, 401, 'AUTH_REQUIRED');
      assert.equal((await db.query('SELECT user_id FROM platform_terms_consents WHERE user_id=ANY($1::uuid[])', [[owner.userId, other.userId]])).rowCount, 0);
    } finally { await holder.query('ROLLBACK'); holder.release(); if (pending) await pending; }
  });
}

test('consent insert failure never reports a confirmed acceptance and a fresh retry is possible', async () => {
  const owner = await actor(); await failInsert('platform_terms_consents');
  try {
    refused(await consent(owner, 'POST', fictionalAcceptance()), 502, 'RESPONSE_FAILED');
    assert.equal((await db.query('SELECT user_id FROM platform_terms_consents WHERE user_id=$1', [owner.userId])).rowCount, 0);
    assert.equal((await consent(owner, 'GET')).json<{ consent: StudentConsentStatus }>().consent.status, 'required');
  } finally { await removeInsertFailure('platform_terms_consents'); }
  assert.equal((await consent(owner, 'POST', fictionalAcceptance())).statusCode, 200);
});
