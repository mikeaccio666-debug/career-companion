import { parseStudentOrgKnowledgePassage } from '@companion/platform-contracts';
import { parseOrgP0Asset, orgAssetLegacyBody } from '@companion/career-core';
import { orgDigest } from '../src/org-knowledge-values.ts';
import { readOrgSource, orgSourcePath, orgSourceReferenceFromPath, type OrgSourceClient } from '../../../apps/web/src/org-source-api.ts';
import { OrgSourceController } from '../../../apps/web/src/org-source-controller.ts';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, chmod, writeFile, symlink, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PLATFORM_ACCOUNT_HEADER } from '@companion/platform-contracts';
import { createProviderRuntime } from '@companion/ai-core';
import { OrgKnowledge } from '../src/org-knowledge.ts';
import { LocalBlobStorage } from '../src/storage.ts';
import { buildApp } from '../src/app.ts';
import { readConfig } from '../src/config.ts';
import { hashPassword, tokenHash } from '../src/auth.ts';
import { readOrgOperatorFile, parseOrgOperatorArguments } from '../src/org-content-files.ts';
import { createCompanionNameSafetyFixture } from './fixtures/companion-name-safety.ts';
import { FICTIONAL_LEGAL } from './fixtures/student-entry.ts';
let f: Awaited<ReturnType<typeof createCompanionNameSafetyFixture>>, dir: string, blobs: LocalBlobStorage, service: OrgKnowledge;
let system: Awaited<ReturnType<typeof buildApp>>, calls = 0;
const origin = 'https://fictional-org.example.invalid', end = '2028-10-01T00:00:00.000Z';
before(async () => {
  f = await createCompanionNameSafetyFixture(); dir = await mkdtemp(join(tmpdir(), 'fictional-org-')); await chmod(dir, 0o700);
  blobs = new LocalBlobStorage(dir); service = new OrgKnowledge(f.db, f.config, FICTIONAL_LEGAL, blobs);
  system = await buildApp({ db: f.db, storage: blobs, legalBundle: FICTIONAL_LEGAL, config: { ...readConfig(), dataCrypto: f.crypto, requireVerifiedEmail: true, workbenchEnabled: false, allowedOrigins: new Set([origin]) },
    enableQueue: false, runtime: createProviderRuntime({ env: { PLATFORM_ALLOW_PROVIDER_CALLS: '0' }, fetch: async () => { calls++; throw Error('No external calls'); } }) });
});
after(async () => { await system?.app.close(); assert.equal(calls, 0); await f?.close(); if (dir) await rm(dir, { recursive: true, force: true }); });
const q = (id = 'fictional.question') => ({ question_ref: id, type: 'sql', role_families: ['da'], difficulty: 1,
  topics: ['aggregation'], prompt_en: 'Explain a fictional aggregate query.', prompt_zh: '解释一个虚构的聚合查询。',
  external_ref: null, rubric: null, key_points: ['Explain the grouping.'], follow_ups: ['How would null values change the result?'], time_budget_min: 15 });
const rejected = (code: string) => (e: unknown) => !!e && typeof e === 'object' && (e as { code?: string }).code === code;
async function setup(assetClass = 'question', audience = 'cohort') {
  const operator = await f.actor(true), editor = await f.actor(true), reviewer = await f.actor(true), owner = await f.actor(), org = randomUUID(), agreementRef = randomUUID();
  await f.db.query("INSERT INTO platform_orgs(id,slug,display_name) VALUES($1,$2,'Fictional licensed library')", [org, 'org_' + org.replaceAll('-', '')]);
  for (const [user, role] of [[operator.userId, 'ops'], [editor.userId, 'content_editor'], [editor.userId, 'mentor'], [reviewer.userId, 'content_reviewer'], [reviewer.userId, 'mentor']])
    await f.db.query("INSERT INTO platform_org_roles(org_id,user_id,role,granted_by) VALUES($1,$2,$3,$4)", [org, user, role, operator.userId]);
  const key = agreementRef, bytes = Buffer.from('Fictional test agreement, not a production license.');
  await blobs.put(key, bytes);
  await f.db.query("INSERT INTO platform_uploads(id,user_id,filename,mime,byte_size,storage_key) VALUES($1,$2,'fictional.txt','text/plain',$3,$4)", [agreementRef, operator.userId, bytes.length, key]);
  const licenseInput = { operationId: randomUUID(), assetClass, agreementRef, allowedUses: ['retrieve', 'model_context', 'display_full'], audience,
    validFrom: '2025-01-01T00:00:00.000Z', validUntil: end };
  const license = await service.registerLicense(operator, org, licenseInput);
  const entitlementInput = { operationId: randomUUID(), userId: owner.userId, expectedRevision: 0, audienceGrants: ['cohort'], expiresAt: end, revoke: false };
  const entitlement = await service.setEntitlement(operator, org, entitlementInput);
  const row = (structured: unknown = q(), cls = assetClass) => ({ assetClass: cls, title: 'Fictional reviewed asset', structured, language: 'mixed',
    roleFamilies: ['da'], tags: ['aggregation'], editor: editor.userId + '@example.invalid', reviewer: reviewer.userId + '@example.invalid',
    validUntil: end, reviewConfirmed: true, deidentified: true });
  const bundle = (rows = [row()]) => ({ operationId: randomUUID(), licenseId: license.licenseId, sources: rows });
  async function published(rows = [row()]) { const batch = await service.importBundle(operator, org, bundle(rows)); const publishInput = { operationId: randomUUID() };
    const receipt = await service.publishBatch(operator, org, batch.batchId, publishInput); return { batch, receipt, publishInput, source: batch.sourceIds[0] }; }
  return { operator, editor, reviewer, owner, org, agreementRef, key, licenseInput, license, entitlementInput, entitlement, row, bundle, published };
}
test('private blob, staff authority and declared uses are required; missing contract and training use cannot register', async () => {
  const s = await setup(), cmd = { ...s.licenseInput, operationId: randomUUID() };
  await assert.rejects(service.registerLicense(s.editor, s.org, cmd), rejected('STAFF_ROLE_REQUIRED'));
  await assert.rejects(service.registerLicense(s.operator, s.org, { ...cmd, allowedUses: ['training'] }), rejected('ORG_CONTENT_INPUT_INVALID'));
  await assert.rejects(service.registerLicense(s.operator, s.org, { ...cmd, agreementRef: randomUUID() }), rejected('NOT_FOUND'));
  await blobs.delete(s.key); await assert.rejects(service.registerLicense(s.operator, s.org, cmd));
  assert.equal((await f.db.query('SELECT count(*)::int AS n FROM platform_content_licenses WHERE org_id=$1', [s.org])).rows[0].n, 1);
});
test('import remains unreadable until published; citations are bounded, logged and versioned', async () => {
  const s = await setup(), batch = await service.importBundle(s.operator, s.org, s.bundle()), id = batch.sourceIds[0];
  assert.deepEqual(await service.search(s.owner, { assetClass: 'question' }, 'interviewer'), []);
  await assert.rejects(service.readPassage(s.owner, id, 1, '1:0'), rejected('STALE_REVISION'));
  await service.publishBatch(s.operator, s.org, batch.batchId, { operationId: randomUUID() });
  const found = await service.search(s.owner, { assetClass: 'question', roleFamily: 'da', questionType: 'sql', difficulty: 1, topics: ['aggregation'] }, 'interviewer');
  assert.equal(found.length, 1); assert.equal(found[0].revision, 2); assert.equal(found[0].provenance, 'untrusted_knowledge');
  assert.equal((await service.readPassage(s.owner, id, 2, '2:0')).sourceId, id);
  await assert.rejects(service.readPassage(s.owner, id, 1, '1:0'), rejected('STALE_REVISION'));
  assert.equal((await f.db.query('SELECT count(*)::int AS n FROM platform_knowledge_access_log WHERE source_id=$1', [id])).rows[0].n, 2);
  const logs = (await f.db.query('SELECT * FROM platform_staff_audit WHERE org_id=$1', [s.org])).rows;
  assert(logs.some(r => r.action === 'org_content_published' && r.target_id === batch.batchId)); assert(!JSON.stringify(logs).includes('fictional aggregate query'));
});
test('one invalid row rolls back the whole batch; editor and reviewer must remain independent active staff', async () => {
  const s = await setup(), good = s.row(q('fictional.good')), bad = { ...s.row(q('fictional.bad')), reviewer: s.editor.userId + '@example.invalid' };
  await assert.rejects(service.importBundle(s.operator, s.org, s.bundle([good, bad])), rejected('ORG_CONTENT_INPUT_INVALID'));
  const missing = { ...s.row(q('fictional.missing')), reviewer: randomUUID() + '@example.invalid' };
  await assert.rejects(service.importBundle(s.operator, s.org, s.bundle([good, missing])), rejected('STAFF_ROLE_REQUIRED'));
  assert.equal((await f.db.query('SELECT count(*)::int AS n FROM platform_org_knowledge_batches WHERE org_id=$1', [s.org])).rows[0].n, 0);
  const b = await service.importBundle(s.operator, s.org, s.bundle());
  await f.db.query("UPDATE platform_org_roles SET status='revoked',revoked_at=clock_timestamp() WHERE org_id=$1 AND user_id=$2 AND role='content_reviewer'", [s.org, s.reviewer.userId]);
  await assert.rejects(service.publishBatch(s.operator, s.org, b.batchId, { operationId: randomUUID() }), rejected('STAFF_ROLE_REQUIRED'));
  assert.equal((await f.db.query('SELECT review_status FROM platform_org_knowledge_sources WHERE id=$1', [b.sourceIds[0]])).rows[0].review_status, 'in_review');
});
test('150 sources import and publish under unchanged transaction deadlines; duplicate nonces have one effect', async () => {
  const s = await setup(), input = s.bundle(Array.from({ length: 150 }, (_, i) => s.row(q('fictional.q' + i))));
  const [a, b] = await Promise.all([service.importBundle(s.operator, s.org, input), service.importBundle(s.operator, s.org, input)]);
  assert.deepEqual(a, b); assert.equal(a.sourceIds.length, 150);
  const pc = { operationId: randomUUID() }, first = await service.publishBatch(s.operator, s.org, a.batchId, pc);
  assert.deepEqual(await service.publishBatch(s.operator, s.org, a.batchId, pc), first);
  assert.equal((await f.db.query('SELECT count(*)::int AS n FROM platform_org_knowledge_sources WHERE org_id=$1', [s.org])).rows[0].n, 150);
  assert.equal((await f.db.query("SELECT record_count FROM platform_staff_audit WHERE org_id=$1 AND action='org_content_imported' ORDER BY created_at LIMIT 1", [s.org])).rows[0].record_count, 150);
  assert.equal((await service.search(s.owner, { assetClass: 'question', limit: 8 }, 'interviewer')).length, 8);
  await assert.rejects(service.importBundle(s.operator, s.org, { ...input, sources: [s.row(q('fictional.changed'))] }), rejected('ORG_OPERATION_CONFLICT'));
});
test('actual entitlement and audience filter reads, including all_users and staff_only', async () => {
  const s = await setup('question', 'all_users'), p = await s.published(), stranger = await f.actor();
  await assert.rejects(service.readPassage(stranger, p.source, 2, '2:0'), rejected('NOT_ENTITLED'));
  assert.deepEqual(await service.search(stranger, { assetClass: 'question' }, 'interviewer'), []);
  await service.setEntitlement(s.operator, s.org, { ...s.entitlementInput, operationId: randomUUID(), expectedRevision: 1, revoke: true });
  await assert.rejects(service.readPassage(s.owner, p.source, 2, '2:0'), rejected('NOT_ENTITLED'));
  assert.deepEqual(await service.search(s.owner, { assetClass: 'question' }, 'interviewer'), []);
  const privateOnly = await setup('question', 'staff_only'), other = await privateOnly.published();
  await assert.rejects(service.readPassage(privateOnly.owner, other.source, 2, '2:0'), rejected('NOT_ENTITLED'));
});
test('license revocation denies old citations and registration replay cannot revive it', async () => {
  const s = await setup(), p = await s.published();
  await service.revokeLicense(s.operator, s.org, s.license.licenseId, { operationId: randomUUID(), expectedRevision: 1, reason: 'Fictional cancellation' });
  await assert.rejects(service.readPassage(s.owner, p.source, 2, '2:0'), rejected('NOT_ENTITLED'));
  assert.deepEqual(await service.registerLicense(s.operator, s.org, s.licenseInput), s.license);
  assert.deepEqual(await service.search(s.owner, { assetClass: 'question' }, 'interviewer'), []);
  assert.equal((await f.db.query('SELECT revision FROM platform_content_licenses WHERE id=$1', [s.license.licenseId])).rows[0].revision, 2);
});
test('authentic older license state cannot be restored after revocation; proof rows are immutable', async () => {
  const s = await setup(), p = await s.published(), old = (await f.db.query('SELECT * FROM platform_content_licenses WHERE id=$1', [s.license.licenseId])).rows[0];
  await service.revokeLicense(s.operator, s.org, s.license.licenseId, { operationId: randomUUID(), expectedRevision: 1, reason: 'Fictional cancellation' });
  await f.db.query('UPDATE platform_content_licenses SET revision=$2,revoked_at=$3,payload_ciphertext=$4 WHERE id=$1', [old.id, old.revision, old.revoked_at, old.payload_ciphertext]);
  await assert.rejects(service.readPassage(s.owner, p.source, 2, '2:0'), rejected('ORG_CONTENT_STORAGE_UNAVAILABLE'));
  await assert.rejects(f.db.query('DELETE FROM platform_org_content_state_proofs WHERE org_id=$1', [s.org]), (e: any) => e.code === '42501');
});
test('withdraw clears content, retains a tombstone, and original publish replay cannot resurrect it', async () => {
  const s = await setup(), p = await s.published(), command = { operationId: randomUUID(), expectedRevision: 2, reason: 'Fictional editorial withdrawal' };
  const result = await service.withdrawSource(s.operator, s.org, p.source, command);
  assert.deepEqual(await service.withdrawSource(s.operator, s.org, p.source, command), result);
  assert.deepEqual(await service.publishBatch(s.operator, s.org, p.batch.batchId, p.publishInput), p.receipt);
  await assert.rejects(service.readPassage(s.owner, p.source, 2, '2:0'), rejected('STALE_REVISION'));
  assert.deepEqual((await f.db.query('SELECT body,structured,review_status,revision FROM platform_org_knowledge_sources WHERE id=$1', [p.source])).rows[0],
    { body: '', structured: {}, review_status: 'withdrawn', revision: 3 });
  assert.equal((await f.db.query('SELECT count(*)::int AS n FROM platform_org_knowledge_passages WHERE source_id=$1', [p.source])).rows[0].n, 0);
});
test('modified passage text fails verification instead of reaching the student', async () => {
  const s = await setup(), p = await s.published();
  await f.db.query("UPDATE platform_org_knowledge_passages SET content='Fictional tampered content' WHERE source_id=$1", [p.source]);
  await assert.rejects(service.readPassage(s.owner, p.source, 2, '2:0'), rejected('ORG_CONTENT_STORAGE_UNAVAILABLE'));
});
test('rubric publication requires a mentor reviewer and external original text cannot be pasted', async () => {
  const s = await setup(), question = { ...q(), rubric: ['structure', 'reasoning', 'checks'].map(dimension => ({ dimension, scores: ['missing', 'partial', 'clear', 'strong'] })) };
  const b = await service.importBundle(s.operator, s.org, s.bundle([s.row(question)]));
  await f.db.query("UPDATE platform_org_roles SET status='revoked',revoked_at=clock_timestamp() WHERE org_id=$1 AND user_id=$2 AND role='mentor'", [s.org, s.reviewer.userId]);
  await assert.rejects(service.publishBatch(s.operator, s.org, b.batchId, { operationId: randomUUID() }), rejected('NOT_ENTITLED'));
  await assert.rejects(service.importBundle(s.operator, s.org, s.bundle([s.row({ ...q(), external_ref: { platform: 'Fictional', key: 'one', url: 'https://example.invalid/problems/one' } })])), rejected('ORG_CONTENT_INPUT_INVALID'));
});
test('patterns remain internal; banned sales text cannot import and student source opening is denied', async () => {
  const s = await setup('conversation_pattern'), pattern = { pattern_id: 'fictional.support', situation: 'overwhelmed', goal: 'Offer a small next step.',
    do: ['Ask what feels manageable.'], dont: ['Pressure the student.'], example_lines_zh: ['我们可以从很小的一步开始。'],
    escalate: 'safety_flow', source_segment_refs: ['fictional.reviewed'], revision: 1 };
  const p = await s.published([s.row(pattern)]);
  await assert.rejects(service.readPassage(s.owner, p.source, 2, '2:0'), rejected('NOT_ENTITLED'));
  assert.equal((await service.search(s.owner, { assetClass: 'conversation_pattern' }, 'companion')).length, 1);
  assert.deepEqual(await service.search(s.owner, { assetClass: 'conversation_pattern' }, 'interviewer'), []);
  await assert.rejects(service.importBundle(s.operator, s.org, s.bundle([s.row({ ...pattern, goal: '名额只剩两个，保offer。' })])), rejected('ORG_CONTENT_INPUT_INVALID'));
});
test('real password-cookie HTTP read enforces account isolation, no-store and dedicated request scope', async () => {
  const s = await setup(), p = await s.published(), password = 'Fictional-password-123';
  await f.db.query('UPDATE platform_users SET password_hash=$2 WHERE id=$1', [s.owner.userId, await hashPassword(password)]);
  const login = await system.app.inject({ method: 'POST', url: '/api/platform/auth/login', headers: { origin }, payload: { email: s.owner.userId + '@example.invalid', password } });
  assert.equal(login.statusCode, 200, login.body);
  const set = login.headers['set-cookie'], cookie = (Array.isArray(set) ? set[0] : set)!.split(';')[0],
    headers = { origin, cookie, [PLATFORM_ACCOUNT_HEADER]: s.owner.userId }, url = '/api/platform/org-knowledge/passages/' + p.source + '/2/2%3A0';
  const read = await system.app.inject({ url, headers }); assert.equal(read.statusCode, 200, read.body); assert.equal(read.headers['cache-control'], 'private, no-store');
  assert.equal(read.json().passage.scope, 'org');
  const stale = await system.app.inject({ url: url.replace('/2/2%3A0', '/1/1%3A0'), headers });
  assert.equal(stale.statusCode, 409); assert.equal(stale.json().error.code, 'STALE_REVISION');
  await service.setEntitlement(s.operator, s.org, { ...s.entitlementInput, operationId: randomUUID(), expectedRevision: 1, revoke: true });
  const denied = await system.app.inject({ url, headers });
  assert.equal(denied.statusCode, 403); assert.equal(denied.json().error.code, 'NOT_ENTITLED');
  assert.equal((await system.app.inject({ url, headers: { ...headers, [PLATFORM_ACCOUNT_HEADER]: randomUUID() } })).statusCode, 409);
  assert.equal((await system.app.inject({ url: url + '?includeOlder=true', headers })).statusCode, 400);
  assert.equal((await system.app.inject({ url })).statusCode, 401);
  assert.equal((await f.db.query("SELECT count(*)::int AS n FROM platform_request_limits WHERE subject_key=$1 AND scope='org-knowledge'", [s.owner.userId])).rows[0].n, 1);
  await f.db.query('UPDATE platform_users SET auth_version=auth_version+1 WHERE id=$1', [s.owner.userId]);
  assert.equal((await system.app.inject({ url, headers })).statusCode, 401);
});
test('account deletion cascades entitlement proofs and access logs; deleting contract owner denies future access without blocking', async () => {
  const s = await setup(), p = await s.published(); await service.readPassage(s.owner, p.source, 2, '2:0');
  await f.db.query('DELETE FROM platform_users WHERE id=$1', [s.owner.userId]);
  for (const table of ['platform_user_entitlements', 'platform_org_content_state_proofs', 'platform_knowledge_access_log'])
    assert.equal((await f.db.query('SELECT count(*)::int AS n FROM ' + table + ' WHERE user_id=$1', [s.owner.userId])).rows[0].n, 0);
  const other = await setup(), source = await other.published();
  await f.db.query('DELETE FROM platform_users WHERE id=$1', [other.operator.userId]);
  await assert.rejects(service.readPassage(other.owner, source.source, 2, '2:0'), rejected('NOT_ENTITLED'));
  await f.db.query('DELETE FROM platform_users WHERE id=$1', [other.editor.userId]);
  assert.equal((await f.db.query('SELECT editor_id FROM platform_org_knowledge_sources WHERE id=$1', [source.source])).rows[0].editor_id, null);
});
test('migration repeats safely, expired fixed sessions cannot import, and operator files reject shared permissions and symlinks', async () => {
  await f.db.query(await readFile(new URL('../migrations/065_org_knowledge.sql', import.meta.url), 'utf8'));
  const s = await setup(); await f.db.query("UPDATE platform_sessions SET expires_at=clock_timestamp()-interval '1 second' WHERE token_hash=$1", [s.operator.tokenHash]);
  await assert.rejects(service.importBundle(s.operator, s.org, s.bundle()), rejected('AUTH_REQUIRED'));
  const file = join(dir, 'fictional-operator.json'); await writeFile(file, '{"fictional":true}', { mode: 0o600 });
  assert.deepEqual(await readOrgOperatorFile(file, 100), { fictional: true });
  await chmod(file, 0o644); await assert.rejects(readOrgOperatorFile(file, 100)); await chmod(file, 0o600);
  const link = join(dir, 'fictional-link.json'); await symlink(file, link); await assert.rejects(readOrgOperatorFile(link, 100)); await assert.rejects(readOrgOperatorFile(file, 2));
  assert.throws(() => parseOrgOperatorArguments(['publish', '--org', s.org, '--session-file', file, '--input-file', file]));
  assert.throws(() => parseOrgOperatorArguments(['license', '--org', s.org, '--org', s.org]));
});

test('method cards require a real mentor author, preserve counterexamples and only load for their bound speaker', async () => {
  const s = await setup('method_card'), method = { method_id: 'fictional.method', revision: 1, author_id: s.editor.userId, reviewer_id: s.reviewer.userId,
    applies_to: { role_families: ['da'], stages: ['interview'], situations: ['preparing'] }, prerequisites: [],
    steps: [{ goal: 'Clarify assumptions.', method: 'Ask about the expected data.', allowed_tools: [], output: 'A list of assumptions.' }],
    rubric_ref: null, stop_when: ['The assumptions are clear.'], counterexamples: ['Do not invent unavailable data.'], escalate_when: [],
    evidence_nature: '经验建议', bound_skills: ['interview-practice'], when_to_use: 'Before fictional SQL practice.',
    bound_speakers: ['interviewer'], effective_from: '2025-01-01T00:00:00.000Z', superseded_by: null };
  const batch = await service.importBundle(s.operator, s.org, s.bundle([s.row(method)]));
  await service.publishBatch(s.operator, s.org, batch.batchId, { operationId: randomUUID() });
  const methods = await service.search(s.owner, { assetClass: 'method_card' }, 'interviewer');
  assert.equal(methods.length, 1); assert.equal(methods[0].provenanceLabel, '蔓藤方法 · v1');
  assert.equal(parseStudentOrgKnowledgePassage(methods[0]).assetRevision, 1);
  assert(!methods[0].text.includes(s.editor.userId)); assert(!methods[0].text.includes(s.reviewer.userId));
  assert.deepEqual(await service.search(s.owner, { assetClass: 'method_card' }, 'guide'), []);
  const bad = await service.importBundle(s.operator, s.org, s.bundle([s.row({ ...method, method_id: 'fictional.bad-author', author_id: s.owner.userId })]));
  await assert.rejects(service.publishBatch(s.operator, s.org, bad.batchId, { operationId: randomUUID() }), rejected('NOT_ENTITLED'));
  await assert.rejects(service.importBundle(s.operator, s.org, s.bundle([s.row({ ...method, effective_from: 'unknown' })])), rejected('ORG_CONTENT_INPUT_INVALID'));
});
test('future licenses and withdrawn terms cannot make organization knowledge available', async () => {
  const s = await setup(), input = { ...s.licenseInput, operationId: randomUUID(), validFrom: '2030-01-01T00:00:00.000Z', validUntil: '2032-01-01T00:00:00.000Z' },
    future = await service.registerLicense(s.operator, s.org, input);
  await assert.rejects(service.importBundle(s.operator, s.org, { ...s.bundle(), licenseId: future.licenseId }), rejected('NOT_ENTITLED'));
  const p = await s.published();
  await f.db.query("DELETE FROM platform_terms_consents WHERE user_id=$1", [s.owner.userId]);
  await assert.rejects(service.readPassage(s.owner, p.source, 2, '2:0'), rejected('TERMS_CONFIRMATION_REQUIRED'));
  assert.equal((await f.db.query('SELECT count(*)::int AS n FROM platform_knowledge_access_log WHERE source_id=$1', [p.source])).rows[0].n, 0);
});

test('operator CLI uses a real database session and private files; receipts omit credentials and source material', async () => {
  const s = await setup(), token = randomUUID() + randomUUID(), url = new URL(readConfig().databaseUrl);
  url.searchParams.set('options', '-c search_path=' + f.schema);
  await f.db.query('INSERT INTO platform_sessions(user_id,token_hash,auth_version,expires_at) VALUES($1,$2,0,clock_timestamp()+interval \'1 hour\')', [s.operator.userId, tokenHash(token)]);
  const credential = join(dir, 'fictional-cli-session.json'), input = join(dir, 'fictional-cli-license.json');
  await writeFile(credential, JSON.stringify({ userId: s.operator.userId, token }), { mode: 0o600 });
  const command = { ...s.licenseInput, operationId: randomUUID() };
  await writeFile(input, JSON.stringify(command), { mode: 0o600 });
  const run = promisify(execFile), result = await run(process.execPath, ['--import', 'tsx', fileURLToPath(new URL('../src/org-content-import.ts', import.meta.url)),
    'license', '--org', s.org, '--session-file', credential, '--input-file', input],
    { env: { ...process.env, PLATFORM_DATABASE_URL: url.toString(), PLATFORM_STORAGE_DIR: dir, PLATFORM_DATA_KEY: 'e5'.repeat(32),
      PLATFORM_ALLOW_PROVIDER_CALLS: '0' }, timeout: 10000, maxBuffer: 4096 });
  const receipt = JSON.parse(result.stdout); assert.equal(receipt.revision, 1); assert.equal(result.stderr, '');
  assert(!result.stdout.includes(token)); assert.deepEqual(Object.keys(receipt).sort(), ['licenseId', 'revision']);
  assert.equal((await f.db.query('SELECT count(*)::int AS n FROM platform_content_licenses WHERE id=$1 AND org_id=$2', [receipt.licenseId, s.org])).rows[0].n, 1);
  await f.db.query('UPDATE platform_users SET auth_version=auth_version+1 WHERE id=$1', [s.operator.userId]);
  await assert.rejects(run(process.execPath, ['--import', 'tsx', fileURLToPath(new URL('../src/org-content-import.ts', import.meta.url)),
    'license', '--org', s.org, '--session-file', credential, '--input-file', input],
    { env: { ...process.env, PLATFORM_DATABASE_URL: url.toString(), PLATFORM_STORAGE_DIR: dir, PLATFORM_DATA_KEY: 'e5'.repeat(32),
      PLATFORM_ALLOW_PROVIDER_CALLS: '0' }, timeout: 10000, maxBuffer: 4096 }), (e: any) => {
      assert.equal(e.code, 1); assert.equal(e.stdout, ''); assert(!e.stderr.includes(token)); return true;
    });
});

async function sourceWebClient(who: Awaited<ReturnType<typeof f.actor>>) {
  const password = 'Fictional-source-web-password-123';
  await f.db.query('UPDATE platform_users SET password_hash=$2 WHERE id=$1', [who.userId, await hashPassword(password)]);
  const login = await system.app.inject({ method: 'POST', url: '/api/platform/auth/login', headers: { origin },
    payload: { email: who.userId + '@example.invalid', password } });
  assert.equal(login.statusCode, 200, login.body);
  const raw = login.headers['set-cookie'], cookie = (Array.isArray(raw) ? raw[0] : raw)!.split(';')[0],
    headers = { origin, cookie, [PLATFORM_ACCOUNT_HEADER]: who.userId };
  let current = true; const listeners = new Set<() => void>();
  const client: OrgSourceClient = { account: { accountId: who.userId }, isCurrent: () => current,
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    async request<T>(path: string, init: RequestInit = {}) {
      assert.equal(init.cache, 'no-store'); assert.equal(init.method, undefined);
      const r = await system.app.inject({ url: '/api/platform' + path, headers });
      const data = r.json(); if (r.statusCode !== 200) throw Object.assign(Error('Source request failed.'), { status: r.statusCode, code: data.error?.code });
      return data as T;
    } };
  return { client, headers, invalidate() { current = false; for (const fn of [...listeners]) fn(); } };
}
async function sourceStateReady(controller: OrgSourceController) {
  for (let i = 0; i < 1200; i++) { if (controller.snapshot().state !== 'loading') return; await new Promise(r => setTimeout(r, 2)); }
  assert.notEqual(controller.snapshot().state, 'loading');
}
test('actual Web client and controller read the same published SQL source through real password HTTP; revocation clears the next view', async () => {
  const s = await setup(), p = await s.published(), web = await sourceWebClient(s.owner),
    reference = { sourceId: p.source, revision: 2, passageId: '2:0' }, snapshots: unknown[] = [],
    controller = new OrgSourceController(web.client, reference, v => snapshots.push(v));
  controller.start(); await sourceStateReady(controller);
  assert.equal(controller.snapshot().state, 'ready'); assert(controller.snapshot().passage?.text.startsWith(q().prompt_en));
  assert.equal(controller.snapshot().passage?.provenanceLabel, '蔓藤题库');
  const referencePath = orgSourcePath(reference); assert.deepEqual(orgSourceReferenceFromPath(referencePath), reference);
  await service.revokeLicense(s.operator, s.org, s.license.licenseId, { operationId: randomUUID(), expectedRevision: 1, reason: 'Fictional withdrawal' });
  await controller.refresh(); assert.equal(controller.snapshot().state, 'denied'); assert.equal(controller.snapshot().passage, null);
  web.invalidate(); assert.equal(controller.snapshot().state, 'idle'); controller.stop();
});
test('actual controller keeps the original revision after withdrawal and clears content after a real session reset', async () => {
  const s = await setup(), p = await s.published(), web = await sourceWebClient(s.owner),
    reference = { sourceId: p.source, revision: 2, passageId: '2:0' }, controller = new OrgSourceController(web.client, reference, () => {});
  controller.start(); await sourceStateReady(controller); assert.equal(controller.snapshot().state, 'ready');
  await service.withdrawSource(s.operator, s.org, p.source, { operationId: randomUUID(), expectedRevision: 2, reason: 'Fictional source change' });
  await controller.refresh(); assert.equal(controller.snapshot().state, 'stale'); assert.equal(controller.snapshot().passage, null);
  await f.db.query('UPDATE platform_users SET auth_version=auth_version+1 WHERE id=$1', [s.owner.userId]);
  await controller.refresh(); assert.equal(controller.snapshot().state, 'account_inactive'); assert.equal(controller.snapshot().passage, null); controller.stop();
});
test('real foreign account has no source entitlement; malformed citation coordinates fail closed before response parsing', async () => {
  const s = await setup(), p = await s.published(), foreign = await sourceWebClient(await f.actor());
  await assert.rejects(readOrgSource(foreign.client, { sourceId: p.source, revision: 2, passageId: '2:0' }), (e: any) => e.status === 403 && e.code === 'NOT_ENTITLED');
  const own = await sourceWebClient(s.owner);
  for (const suffix of ['/2/2%3A128', '/2/2%3A00', '/2/1%3A0', '/2147483648/2147483648%3A0']) {
    const r = await system.app.inject({ url: '/api/platform/org-knowledge/passages/' + p.source + suffix, headers: own.headers });
    assert.equal(r.statusCode, 400, r.body); assert.equal(r.json().error.code, 'ORG_CONTENT_INPUT_INVALID');
  }
  await assert.rejects(readOrgSource(own.client, { sourceId: randomUUID(), revision: 2, passageId: '2:0' }), (e: any) => e.status === 404 && e.code === 'NOT_FOUND');
  const checked = await readOrgSource(own.client, { sourceId: p.source, revision: 2, passageId: '2:0' });
  assert.equal(parseStudentOrgKnowledgePassage(checked).scope, 'org');
});
test('genuine pre-readable-format source and its immutable proof remain publishable without rewriting its original citation words', async () => {
  const s = await setup(), b = await service.importBundle(s.operator, s.org, s.bundle()), current = (await f.db.query('SELECT * FROM platform_org_knowledge_sources WHERE id=$1', [b.sourceIds[0]])).rows[0];
  const id = randomUUID(), body = orgAssetLegacyBody(parseOrgP0Asset('question', current.structured)),
    hash = orgDigest({ assetClass: current.asset_class, title: current.title, body, structured: current.structured, language: current.language, roleFamilies: current.role_families, tags: current.tags });
  const state = { id, orgId: s.org, licenseId: current.license_id, revision: 1, reviewStatus: 'in_review', contentHash: hash,
    publishBatch: null, reviewedAt: null, validUntil: current.valid_until.toISOString(), createdAt: current.created_at.toISOString(),
    updatedAt: current.updated_at.toISOString(), withdrawnAt: null, deidVersion: current.deid_version };
  // Explicit historical fixture in an isolated schema. Uses the actual data
  // crypto and immutable proof table; this is not a production signing route.
  const receipt = f.crypto.sealUtf8(JSON.stringify(state), { table: 'org_source', column: 'payload', rowId: id, ownerId: s.org, revision: 1 });
  await f.db.query("INSERT INTO platform_org_knowledge_sources(id,org_id,batch_id,asset_class,title,body,structured,language,role_families,tags,license_id,deid_status,deid_version,review_status,editor_id,reviewer_id,valid_until,revision,content_hash,created_at,updated_at,receipt_ciphertext) SELECT $2,org_id,batch_id,asset_class,title,$3,structured,language,role_families,tags,license_id,deid_status,deid_version,review_status,editor_id,reviewer_id,valid_until,revision,$4,created_at,updated_at,$5 FROM platform_org_knowledge_sources WHERE id=$1",
    [current.id, id, body, hash, receipt]);
  const proof = { orgId: s.org, kind: 'source', id, revision: 1, digest: orgDigest(state) };
  await f.db.query('INSERT INTO platform_org_content_state_proofs(org_id,kind,object_id,revision,proof_ciphertext) VALUES($1,\'source\',$2,1,$3)',
    [s.org, id, f.crypto.sealUtf8(JSON.stringify(proof), { table: 'org_state_source', column: 'payload', rowId: id, ownerId: s.org, revision: 1 })]);
  await service.publishBatch(s.operator, s.org, b.batchId, { operationId: randomUUID() });
  const web = await sourceWebClient(s.owner), old = await readOrgSource(web.client, { sourceId: id, revision: 2, passageId: '2:0' });
  assert.equal(old.text, body.slice(0, 1200));
  assert.equal((await f.db.query('SELECT body FROM platform_org_knowledge_sources WHERE id=$1', [id])).rows[0].body, body);
});
