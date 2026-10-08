import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import type { CompanionSafetySourceKind } from '@companion/platform-contracts';
import { ApiError } from '../src/errors.ts';
import { DataCryptoError } from '../src/data-crypto.ts';
import { CompanionNameSafetyDelivery } from '../src/companion-name-safety-delivery.ts';
import { intakeResourceProofArray, parseIntakeResourcePrefixProof } from '../src/onboarding-resource-prefix.ts';
import { OnboardingSafetyResponses } from '../src/onboarding-safety-responses.ts';
import { OnboardingSafetyFollowup } from '../src/onboarding-safety-followup.ts';
import { OnboardingSafetyRunner } from '../src/onboarding-safety-runner.ts';
import { OnboardingSafetyDelivery } from '../src/onboarding-safety-delivery.ts';
import { SafetyQuestionDelivery } from '../src/safety-question-delivery.ts';
import { classifyPrebirthName, createPrebirthFixture, prebirthDetector, withPrebirthLoopback } from './fixtures/companion-prebirth.ts';
import { FICTIONAL_LEGAL } from './fixtures/student-entry.ts';
import { withStudentOnboardingFixture, studentJourneyPrefix as prefix, studentJourneyHeaders as headers,
  assertStudentJourneyResponse as status, type StudentOnboardingFixture } from './fixtures/companion-student-onboarding.ts';

// Actual PostgreSQL and true ports under the fixture's isolated schema and
// owned provider/email loopback. Every review/copy/map is explicitly fictional.
// Present commands declare a test client's display, never a real browser DOM.
// The root task exclusively executes these cases; no paid model is contacted.
const resourceTables = [
  'platform_onboarding_safety_submissions', 'platform_onboarding_safety_responses', 'platform_safety_events',
  'platform_onboarding_safety_publications', 'platform_onboarding_safety_followups', 'platform_onboarding_resource_cutovers',
  'platform_onboarding_delivery_v2_heads', 'platform_onboarding_delivery_v2_operations', 'platform_onboarding_safety_v2_publications',
  'platform_onboarding_safety_v2_body_projections', 'platform_onboarding_safety_v2_followup_states',
  'platform_onboarding_safety_v2_followups', 'platform_onboarding_safety_v2_handled',
  'platform_safety_question_scopes', 'platform_safety_question_occurrences', 'platform_safety_question_operations', 'platform_safety_legacy_exposures',
  'platform_companion_generation_tasks', 'platform_companion_source_prefixes', 'platform_safety_model_usage',
  'platform_companion_name_safety_responses', 'platform_companion_name_delivery_heads', 'platform_companion_name_delivery_operations',
  'platform_companion_name_safety_publications', 'platform_companion_name_safety_body_projections',
  'platform_companion_name_safety_followup_states', 'platform_companion_name_safety_followups', 'platform_companion_name_safety_handled',
] as const;
const apiCode = (expected: string) => (error: unknown) => error instanceof ApiError && error.code === expected;
const apiDenied = (status: number, code: string) => (error: unknown) => error instanceof ApiError && error.status === status && error.code === code;
async function snapshot(f: StudentOnboardingFixture) {
  const result: Record<string, string[]> = {};
  for (const table of resourceTables) result[table] = (await f.prebirth.db.query(`SELECT row_to_json(t)::text AS value FROM ${table} t
    WHERE user_id=$1 ORDER BY row_to_json(t)::text`, [f.who.userId])).rows.map(row => row.value);
  return result;
}
function target(f: StudentOnboardingFixture) {
  assert(f.risk); return { sourceKind: 'onboarding' as const, publicationId: f.risk.publicationId };
}
async function originalSource(f: StudentOnboardingFixture) {
  assert(f.risk);
  return (await f.prebirth.db.query(`SELECT row_to_json(t)::text AS value FROM
    (SELECT s.id,s.user_id,s.draft_id,s.operation_id,s.submitted_revision,o.request_ciphertext,s.result_ciphertext,s.generation,s.level,s.detector_mode
      FROM platform_onboarding_safety_submissions s JOIN platform_onboarding_operations o ON o.user_id=s.user_id AND o.operation_id=s.operation_id
      WHERE s.id=$1 AND s.user_id=$2) t`, [f.risk.submissionId, f.who.userId])).rows[0].value;
}
async function actualPrefix(f: StudentOnboardingFixture) {
  const row = (await f.prebirth.db.query('SELECT * FROM platform_companion_source_prefixes WHERE task_id=$1 AND user_id=$2',
    [f.ready.prepared.taskId, f.who.userId])).rows[0]; assert(row);
  const payload = JSON.parse(f.prebirth.crypto.openUtf8(row.payload_ciphertext, {
    table: 'platform_companion_source_prefixes', column: 'payload_ciphertext', rowId: row.id, ownerId: f.who.userId, revision: row.source_revision,
  }));
  return { row, payload };
}
async function sqlRejected(f: StudentOnboardingFixture, sql: string, values: unknown[], expected: string) {
  const stable = await snapshot(f);
  await assert.rejects(f.prebirth.db.withBoundedTransaction(async client => {
    await client.query(sql, values); await client.query('SET CONSTRAINTS ALL IMMEDIATE');
    throw new Error('The real PostgreSQL constraint unexpectedly permitted the invalid row.');
  }), (error: unknown) => (error as { code?: unknown })?.code === expected);
  assert.deepEqual(await snapshot(f), stable);
}

test('C2 original L2/keyword-only input → native050 handling → actual V2 preparation, with read-only GET and no039 transport', async () => {
  await withStudentOnboardingFixture(async f => {
    assert(f.risk); assert.equal(await originalSource(f), f.risk.originalSource);
    const { row, payload } = await actualPrefix(f);
    assert.equal(row.schema_version, 2); assert.equal(payload.schemaVersion, 2);
    assert.equal((await f.prebirth.db.query('SELECT source_receipt_version FROM platform_companion_generation_tasks WHERE id=$1', [row.task_id])).rows[0].source_receipt_version, 2);
    assert.deepEqual(payload.intakeResources.map((proof: { submissionId: string }) => proof.submissionId), [f.risk.submissionId]);
    assert.equal(payload.intakeResources[0].handledOperationId, f.risk.continuationOperationId);
    assert(payload.intakeResources[0].handledAt <= payload.capturedAt);
    assert.equal(payload.submissions[0].originalLevel, 'L2'); assert.equal(payload.submissions[0].originalDetectorMode, 'keyword_only');
    assert.deepEqual(payload.publications, []); assert.deepEqual(payload.followups, []);
    const stable = await snapshot(f), calls = f.requests.length;
    for (let i = 0; i < 2; i++) {
      const routes:string[]=['/companion/support', `/companion/support/onboarding/${f.risk.publicationId}`,
        `/companion/support/questions/onboarding/${f.risk.publicationId}`, '/onboarding/safety', '/companion/journey'];
      for (const route of routes) {
        const response:{statusCode:number;headers:Record<string,unknown>;body:string;json():any}=await f.system.app.inject({ method: 'GET', url: prefix + route, headers: headers(f.who) }); status(response, 200);
        if (route.includes('/support')) { assert.equal(Object.hasOwn(response.json(), 'question'), false); assert.equal(Object.hasOwn(response.json(), 'grantPresentationToken'), false); }
        if (route === '/onboarding/safety') assert.deepEqual(response.json().followup.publications, []);
      }
    }
    assert.deepEqual(await snapshot(f), stable); assert.equal(f.requests.length, calls);
    assert.equal(stable.platform_onboarding_safety_publications.length, 0); assert.equal(stable.platform_onboarding_safety_followups.length, 0);
    assert.equal(await originalSource(f), f.risk.originalSource);
  }, { riskIntake: true });
});

test('C2 fixed body projection remains available with absent current legal bundle and unverified email, without execution admission', async () => {
  await withStudentOnboardingFixture(async f => {
    assert(f.risk); const extra = await f.withoutLegal(), calls = f.requests.length;
    const verified = (await f.prebirth.db.query('SELECT email_verified_at::text AS verified FROM platform_users WHERE id=$1', [f.who.userId])).rows[0].verified;
    assert.equal(typeof verified, 'string');
    await f.prebirth.db.query('UPDATE platform_users SET email_verified_at=NULL WHERE id=$1', [f.who.userId]);
    const observed = await extra.app.inject({ method: 'GET', url: prefix + '/companion/support', headers: headers(f.who) }); status(observed, 200);
    const body = await extra.app.inject({ method: 'POST', url: prefix + '/companion/support/body', headers: headers(f.who), payload: target(f) }); status(body, 200);
    assert.deepEqual(Object.keys(body.json().projection.body).sort(), ['resourceCard', 'text']); assert.equal(Object.hasOwn(body.json().projection.body, 'question'), false);
    assert.equal(body.json().projection.submissionId, f.risk.submissionId);
    const stable = await f.evidence(), resources = await snapshot(f);
    // Controlled fixture state separates the real admission order: email is
    // checked before active legal documents, then current consent. Restoring
    // the original verification timestamp grants no new source/execution.
    await assert.rejects(extra.naming.accept(f.who, f.command()), apiDenied(403, 'EMAIL_VERIFICATION_REQUIRED'));
    assert.deepEqual(await f.evidence(), stable); assert.deepEqual(await snapshot(f), resources);
    await f.prebirth.db.query('UPDATE platform_users SET email_verified_at=$2::timestamptz WHERE id=$1', [f.who.userId, verified]);
    await assert.rejects(extra.naming.accept(f.who, f.command()), apiDenied(503, 'LEGAL_DOCUMENTS_UNAVAILABLE'));
    assert.deepEqual(await f.evidence(), stable); assert.deepEqual(await snapshot(f), resources);
    await f.prebirth.db.query('DELETE FROM platform_terms_consents WHERE user_id=$1', [f.who.userId]);
    await assert.rejects(f.system.naming.accept(f.who, f.command()), apiDenied(403, 'TERMS_CONFIRMATION_REQUIRED'));
    assert.deepEqual(await f.evidence(), stable); assert.deepEqual(await snapshot(f), resources);
    const termsBlockedBody = await extra.app.inject({ method: 'POST', url: prefix + '/companion/support/body', headers: headers(f.who), payload: target(f) }); status(termsBlockedBody, 200);
    assert.equal(Object.hasOwn(termsBlockedBody.json().projection.body, 'question'), false);
    assert.equal(termsBlockedBody.json().projection.submissionId, f.risk.submissionId);
    assert.equal(await originalSource(f), f.risk.originalSource); assert.equal(f.requests.length, calls);
  }, { riskIntake: true });
});

test('C2 authentic private owner, true Origin and closed source commands protect body and source-specific questions', async () => {
  await withStudentOnboardingFixture(async f => {
    assert(f.risk); const other = await f.register('Another fictional C2 owner'), stable = await snapshot(f), calls = f.requests.length;
    const index = await f.system.safetyResources.resources.readIndex(other); assert.deepEqual(index.sources, []);
    await assert.rejects(f.system.safetyResources.resources.read(other, target(f)), (error: unknown) => error instanceof ApiError && error.status === 404);
    const missingOrigin: Record<string, string> = { ...headers(f.who) }; delete missingOrigin.origin;
    assert.equal(Object.hasOwn(missingOrigin, 'origin'), false);
    for (const h of [{ ...headers(f.who), origin: 'https://foreign.example.invalid' }, missingOrigin]) {
      const response = await f.system.app.inject({ method: 'POST', url: prefix + '/companion/support/body', headers: h, payload: target(f) }); assert.equal(response.statusCode, 403);
      assert.equal(response.json().error.code, 'ORIGIN_REJECTED');
      assert.equal(response.body.includes(f.risk.originalSource), false);
    }
    for (const payload of [{ ...target(f), level: 'L0' }, { ...target(f), sourceKind: 'unknown' }, { ...target(f), currentPermission: true }]) {
      await assert.rejects(f.system.safetyResources.resources.readBody(f.who, payload), apiCode('INVALID_INPUT'));
    }
    await assert.rejects(f.system.safetyResources.resources.act(f.who, { ...target(f), operationId: randomUUID(), expectedPublicationRevision: 3,
      action: { kind: 'continue_naming', presentationReceipt: Buffer.alloc(32, 1).toString('base64url') } }), apiCode('INVALID_INPUT'));
    const missingKind = await f.system.app.inject({ method: 'POST', url: prefix + '/companion/support/questions/reservations', headers: headers(f.who),
      payload: { publicationId: f.risk.publicationId, operationId: randomUUID(), expectedQuestionScopeRevision: 0, renderOwnerId: randomUUID() } });
    assert.equal(missingKind.statusCode, 400, missingKind.body);
    assert.deepEqual(await snapshot(f), stable); assert.equal(f.requests.length, calls);
  }, { riskIntake: true });
});

test('C2 populated050 SQL replay is byte-preserving, and actual root/NULL/typed question parents reject mismatches', async () => {
  await withStudentOnboardingFixture(async f => {
    assert(f.risk); const stable = await snapshot(f), calls = f.requests.length;
    const sql = await fs.readFile(new URL('../migrations/050_onboarding_safety_delivery.sql', import.meta.url), 'utf8');
    await f.prebirth.db.withBoundedTransaction(async client => { await client.query(sql); await client.query(sql); });
    assert.deepEqual(await snapshot(f), stable);
    await sqlRejected(f, 'UPDATE platform_onboarding_safety_submissions SET first_safety_v2_publication_id=NULL WHERE id=$1', [f.risk.submissionId], '23514');
    await sqlRejected(f, 'UPDATE platform_onboarding_drafts SET safety_resource_v2_draft_id=NULL WHERE user_id=$1', [f.who.userId], '23514');
    await sqlRejected(f, 'DELETE FROM platform_onboarding_safety_v2_publications WHERE id=$1', [f.risk.publicationId], '23503');
    await sqlRejected(f, 'UPDATE platform_onboarding_safety_v2_followups SET presentation_kind=NULL WHERE user_id=$1 AND operation_id=$2', [f.who.userId, f.risk.acknowledgmentOperationId], '23514');
    await sqlRejected(f, 'UPDATE platform_onboarding_safety_v2_followups SET acknowledgment_operation_id=$3 WHERE user_id=$1 AND operation_id=$2', [f.who.userId, f.risk.continuationOperationId, f.risk.presentationOperationId], '23503');
    await sqlRejected(f, "UPDATE platform_safety_question_occurrences SET source_kind='companion_name' WHERE id=$1", [f.risk.occurrenceId], '23503');
    await sqlRejected(f, 'UPDATE platform_companion_generation_tasks SET source_receipt_version=1 WHERE id=$1', [f.ready.prepared.taskId], '23503');
    assert.equal(await originalSource(f), f.risk.originalSource); assert.equal(f.requests.length, calls);
  }, { riskIntake: true });
});

test('C2 historical V2 preview authenticates the actual captured body-operation prefix despite a later real support operation', async () => {
  await withStudentOnboardingFixture(async f => {
    assert(f.risk); const original = await actualPrefix(f), calls = f.requests.length;
    const before = await f.system.safetyResources.resources.read(f.who, target(f));
    const action = await f.system.safetyResources.resources.act(f.who, { ...target(f), operationId: randomUUID(), expectedPublicationRevision: before.revision, action: { kind: 'need_support' } });
    assert.equal(action.state.revision, before.revision + 1); assert.equal(action.state.handled, true);
    assert.equal((await f.student.read(f.who)).kind, 'journey');
    const saved = await actualPrefix(f); assert.deepEqual(saved.row, original.row); assert.deepEqual(saved.payload, original.payload);
    assert.equal(await originalSource(f), f.risk.originalSource); assert.equal(f.requests.length, calls);
  }, { riskIntake: true });
});

test('C2 original050 captured-operation damage closes historical preview; reading cannot repair or borrow later handling', async () => {
  await withStudentOnboardingFixture(async f => {
    assert(f.risk); const row = (await f.prebirth.db.query('SELECT payload_ciphertext FROM platform_onboarding_safety_v2_followups WHERE user_id=$1 AND operation_id=$2',
      [f.who.userId, f.risk.continuationOperationId])).rows[0]; assert(row);
    const damaged = Buffer.from(row.payload_ciphertext); damaged[damaged.length - 1] ^= 1;
    await f.prebirth.db.query('UPDATE platform_onboarding_safety_v2_followups SET payload_ciphertext=$3 WHERE user_id=$1 AND operation_id=$2',
      [f.who.userId, f.risk.continuationOperationId, damaged]);
    try {
      const stable = await snapshot(f), calls = f.requests.length;
      await assert.rejects(f.student.read(f.who), (error: unknown) => error instanceof DataCryptoError || error instanceof ApiError && error.status === 503);
      const index = await f.system.safetyResources.resources.readIndex(f.who);
      assert.equal(index.sources.find(source => source.sourceRef.kind === 'onboarding' && source.sourceRef.submissionId === f.risk!.submissionId)?.availability, 'unavailable');
      assert.deepEqual(await snapshot(f), stable); assert.equal(f.requests.length, calls); assert.equal(await originalSource(f), f.risk.originalSource);
    } finally {
      await f.prebirth.db.query('UPDATE platform_onboarding_safety_v2_followups SET payload_ciphertext=$3 WHERE user_id=$1 AND operation_id=$2',
        [f.who.userId, f.risk.continuationOperationId, row.payload_ciphertext]);
    }
    assert.equal((await f.student.read(f.who)).kind, 'journey');
  }, { riskIntake: true });
});

test('C2 native intake and actual new name L2 share one scope; a distinct high-risk signal is allowed and a routine repeat is blocked', async () => {
  await withStudentOnboardingFixture(async f => {
    assert(f.risk); const intake = await f.system.safetyResources.questionDelivery.read(f.who, target(f));
    assert.equal(intake.sourcePhase, 'declared'); assert(intake.receiptReceivedAt);
    const classifierCalls = f.requests.filter(request => request.model === 'fictional-prebirth-classifier').length;
    const accepted = await f.accept(f.command('Fictional prebirth high marker')); await f.execute(accepted);
    const named = await f.system.naming.readOperation(f.who, accepted.acceptance.operation.id); assert(named);
    assert.deepEqual(named.progress.detection, { status: 'detected', generation: 1, level: 'L2', mode: 'keyword_only' });
    const publication = await f.system.safetyResources.resources.publish(f.who, { sourceRef: { kind: 'companion_name', submissionId: accepted.acceptance.submissionId }, operationId: randomUUID(), expectedEdition: 0 });
    assert(publication); const nameTarget = { sourceKind: 'companion_name' as CompanionSafetySourceKind, publicationId: publication.publicationId };
    const state = await f.system.safetyResources.questionDelivery.read(f.who, nameTarget); assert.equal(state.scopeRevision, intake.scopeRevision);
    const owner = randomUUID(), reservation = await f.system.safetyResources.questionDelivery.reserve(f.who,
      { ...nameTarget, operationId: randomUUID(), expectedQuestionScopeRevision: state.scopeRevision, renderOwnerId: owner }); assert(reservation.reservationToken);
    const claim = await f.system.safetyResources.questionDelivery.claim(f.who, { operationId: randomUUID(), occurrenceId: reservation.occurrenceId,
      reservationId: reservation.reservationId, reservationToken: reservation.reservationToken, generation: reservation.generation, renderOwnerId: owner });
    assert.equal(claim.status, 'display_granted'); assert.equal(claim.sourceKind, 'companion_name'); assert.equal(claim.publicationId, publication.publicationId);
    assert('grantPresentationToken' in claim);
    await f.system.safetyResources.questionDelivery.present(f.who, { operationId: randomUUID(), occurrenceId: claim.occurrenceId,
      grantId: claim.grantId, grantPresentationToken: claim.grantPresentationToken, renderOwnerId: owner });
    const now = await f.system.safetyResources.questionDelivery.read(f.who, target(f)), stable = await snapshot(f);
    await assert.rejects(f.system.safetyResources.questionDelivery.reserve(f.who, { ...target(f), operationId: randomUUID(), expectedQuestionScopeRevision: now.scopeRevision,
      renderOwnerId: randomUUID() }), apiCode('SAFETY_QUESTION_ALREADY_ASKED'));
    assert.deepEqual(await snapshot(f), stable); assert.equal(f.requests.filter(request => request.model === 'fictional-prebirth-classifier').length, classifierCalls);
    const projections = await f.system.safetyResources.resources.readBody(f.who, target(f)); assert.equal(Object.hasOwn(projections.body, 'question'), false);
    assert.equal(await originalSource(f), f.risk.originalSource);
  }, { riskIntake: true });
});

test('C2 actual pending046 name capture is explicitly prepared with professional assets after true logout/new login, independently of current legal/email gates', async () => {
  await withStudentOnboardingFixture(async f => {
    // This uses the real original submit and classifier ports, not a worker
    // whose normal resource stage would already have prepared the046 capture.
    const source = await classifyPrebirthName(f.prebirth, f.ready, f.runtime, 'Fictional prebirth low marker');
    const initial = (await f.prebirth.db.query('SELECT status,payload_ciphertext FROM platform_companion_name_safety_responses WHERE submission_id=$1', [source.submissionId])).rows[0];
    assert(initial); assert.equal(initial.status, 'pending'); assert.equal(initial.payload_ciphertext, null);
    const nativeSource = async () => (await f.prebirth.db.query(`SELECT row_to_json(t)::text AS value FROM
      (SELECT id,user_id,entry_id,task_id,companion_id,preview_revision,operation_id,submitted_revision,expected_identity_revision,submitted_auth_version,application_operation_id,
        request_ciphertext,claim_ciphertext,result_ciphertext,generation,level,detector_mode,status,auth_version,detector_revision,
        lease_token,lease_until,execution_token,failure,application_status,rejected_category,applied_identity_revision,application_ciphertext,first_name_dispatch_id,
        created_at,updated_at FROM platform_companion_name_submissions WHERE id=$1) t`, [source.submissionId])).rows[0].value;
    const usage = async () => (await f.prebirth.db.query("SELECT row_to_json(u)::text AS value FROM platform_safety_model_usage u WHERE source_kind='companion_name' AND submission_id=$1 ORDER BY call_id", [source.submissionId])).rows.map(row => row.value);
    const original = await nativeSource(), originalUsage = await usage(), calls = f.requests.length;
    const classified = (await f.prebirth.db.query('SELECT level,detector_mode FROM platform_companion_name_submissions WHERE id=$1', [source.submissionId])).rows[0];
    assert.equal(classified.level, 'L1'); assert.equal(classified.detector_mode, 'full'); assert.equal(originalUsage.length, 1);
    assert.equal((await f.prebirth.db.query('SELECT first_safety_publication_id FROM platform_companion_name_submissions WHERE id=$1', [source.submissionId])).rows[0].first_safety_publication_id, null);
    assert.equal((await f.prebirth.db.query('SELECT safety_resource_v2_draft_id FROM platform_onboarding_drafts WHERE user_id=$1', [f.who.userId])).rows[0].safety_resource_v2_draft_id, null);
    const logout = await f.system.app.inject({ method: 'POST', url: prefix + '/auth/logout', headers: headers(f.who), payload: {} }); assert.equal(logout.statusCode, 200, logout.body);
    assert.equal((await f.prebirth.db.query('SELECT 1 FROM platform_sessions WHERE token_hash=$1', [f.who.tokenHash])).rowCount, 0);
    const current = await f.login(f.who), extra = await f.withoutLegal();
    const verified = (await f.prebirth.db.query('SELECT email_verified_at::text AS verified FROM platform_users WHERE id=$1', [current.userId])).rows[0].verified;
    assert.equal(typeof verified, 'string');
    await f.prebirth.db.query('UPDATE platform_users SET email_verified_at=NULL WHERE id=$1', [current.userId]);
    const beforeGet = await snapshot(f);
    const metadata = await extra.app.inject({ method: 'GET', url: prefix + '/companion/support', headers: headers(current) }); status(metadata, 200);
    const entry = metadata.json().index.sources.find((item: { sourceRef: { submissionId: string } }) => item.sourceRef.submissionId === source.submissionId);
    assert(entry); assert.equal(entry.availability, 'ready'); assert.equal(entry.publication, null); assert.deepEqual(await snapshot(f), beforeGet);
    const disabled = new CompanionNameSafetyDelivery(f.prebirth.db, f.prebirth.config, null, f.prebirth.original, null, null);
    await assert.rejects(disabled.publish(current, { submissionId: source.submissionId, operationId: randomUUID(), expectedEdition: 0 }), apiCode('SAFETY_DELIVERY_UNAVAILABLE'));
    assert.deepEqual(await snapshot(f), beforeGet);
    const command = { sourceRef: { kind: 'companion_name', submissionId: source.submissionId }, operationId: randomUUID(), expectedEdition: 0 };
    const response = await extra.app.inject({ method: 'POST', url: prefix + '/companion/support/publications', headers: headers(current), payload: command }); status(response, 200);
    const publication = response.json().publication; assert(publication); assert.equal(publication.sourceKind, 'companion_name');
    assert.equal((await f.prebirth.db.query('SELECT first_safety_publication_id FROM platform_companion_name_submissions WHERE id=$1', [source.submissionId])).rows[0].first_safety_publication_id, publication.publicationId);
    const cutover = (await f.prebirth.db.query('SELECT id,safety_resource_v2_draft_id FROM platform_onboarding_drafts WHERE user_id=$1', [current.userId])).rows[0];
    assert.equal(cutover.safety_resource_v2_draft_id, cutover.id);
    const prepared = (await f.prebirth.db.query('SELECT status,payload_ciphertext FROM platform_companion_name_safety_responses WHERE submission_id=$1', [source.submissionId])).rows[0];
    assert.equal(prepared.status, 'ready'); assert(Buffer.isBuffer(prepared.payload_ciphertext));
    const body = await extra.app.inject({ method: 'POST', url: prefix + '/companion/support/body', headers: headers(current), payload: { sourceKind: 'companion_name', publicationId: publication.publicationId } }); status(body, 200);
    assert.equal(Object.hasOwn(body.json().projection.body, 'question'), false);
    assert.equal(body.json().projection.submissionId, source.submissionId);
    // The archived exact request needs no newly configured assets; it does not
    // create another capture, publication, handle or original execution grant.
    const stable = await snapshot(f), replay = await disabled.publish(current, { submissionId: source.submissionId, operationId: command.operationId, expectedEdition: 0 });
    assert(replay); assert.equal(replay.publicationId, publication.publicationId); assert.equal(replay.replayed, true); assert.deepEqual(await snapshot(f), stable);
    assert.equal(await nativeSource(), original); assert.deepEqual(await usage(), originalUsage); assert.equal(f.requests.length, calls);
    await sqlRejected(f, 'UPDATE platform_companion_name_submissions SET first_safety_publication_id=NULL WHERE id=$1', [source.submissionId], '23514');
    const admissionEvidence = await f.evidence(), admissionResources = await snapshot(f);
    await assert.rejects(extra.naming.accept(current, f.command()), apiDenied(403, 'EMAIL_VERIFICATION_REQUIRED'));
    assert.deepEqual(await f.evidence(), admissionEvidence); assert.deepEqual(await snapshot(f), admissionResources);
    await f.prebirth.db.query('UPDATE platform_users SET email_verified_at=$2::timestamptz WHERE id=$1', [current.userId, verified]);
    await assert.rejects(extra.naming.accept(current, f.command()), apiDenied(503, 'LEGAL_DOCUMENTS_UNAVAILABLE'));
    assert.deepEqual(await f.evidence(), admissionEvidence); assert.deepEqual(await snapshot(f), admissionResources);
    await f.prebirth.db.query('DELETE FROM platform_terms_consents WHERE user_id=$1', [current.userId]);
    await assert.rejects(f.system.naming.accept(current, f.command()), apiDenied(403, 'TERMS_CONFIRMATION_REQUIRED'));
    assert.deepEqual(await f.evidence(), admissionEvidence); assert.deepEqual(await snapshot(f), admissionResources);
    const termsBlockedBody = await extra.app.inject({ method: 'POST', url: prefix + '/companion/support/body', headers: headers(current), payload: { sourceKind: 'companion_name', publicationId: publication.publicationId } }); status(termsBlockedBody, 200);
    assert.equal(Object.hasOwn(termsBlockedBody.json().projection.body, 'question'), false);
    assert.equal(termsBlockedBody.json().projection.submissionId, source.submissionId);
    assert.equal(await nativeSource(), original); assert.deepEqual(await usage(), originalUsage); assert.equal(f.requests.length, calls);
  });
});

test('C2 new V2 proof arrays reject holes, accessor indices and extra properties without evaluating getters', () => {
  let evaluated = 0;
  const accessor: unknown[] = []; Object.defineProperty(accessor, '0', { enumerable: true, get() { evaluated++; return {}; } });
  const extra = Object.assign([], { unrecognized: true });
  for (const value of [new Array(1), accessor, extra]) assert.throws(() => intakeResourceProofArray(value), apiCode('DATA_STORAGE_UNAVAILABLE'));
  assert.throws(() => parseIntakeResourcePrefixProof(undefined), apiCode('DATA_STORAGE_UNAVAILABLE'));
  assert.equal(evaluated, 0); assert.deepEqual(intakeResourceProofArray([]), []);
});

test('C2 genuine unhandled old039 corruption closes shared question only; new050 body stays available and cutover rejects old publication/follow-up INSERT', async () => {
  await withPrebirthLoopback(async (runtime, calls) => {
    const f = await createPrebirthFixture();
    try {
      const who = await f.actor(), operationId = randomUUID();
      let draft = (await f.store.save(who, { expectedRevision: 0, operationId: randomUUID(), action: { kind: 'start', mode: 'fast_track' } })).draft;
      assert(draft.currentQuestion);
      draft = (await f.store.save(who, { expectedRevision: draft.revision, operationId, action: { kind: 'text', questionId: draft.currentQuestion,
        text: 'Fictional prebirth high marker, synthetic legacy fixture.' } })).draft;
      await new OnboardingSafetyRunner(f.store, f.config, runtime, prebirthDetector).runNext(who);
      const source = (await f.db.query('SELECT * FROM platform_onboarding_safety_submissions WHERE user_id=$1 AND draft_id=$2 AND operation_id=$3', [who.userId, draft.id, operationId])).rows[0];
      assert(source); assert.equal(source.status, 'detected'); assert.equal(source.level, 'L2'); assert.equal(source.detector_mode, 'keyword_only');
      const sourceBytes = (await f.db.query('SELECT row_to_json(s)::text AS value FROM platform_onboarding_safety_submissions s WHERE id=$1', [source.id])).rows[0].value;
      await new OnboardingSafetyResponses(f.db, f.config, FICTIONAL_LEGAL, f.bundle).prepareSubmission(source.id);
      // This is the real compatibility port, deliberately used before its real
      // cutover anchor. The public C factory always uses prospective mode.
      const old = new OnboardingSafetyFollowup(f.db, f.config, FICTIONAL_LEGAL), oldState = await old.read(who);
      assert.equal(oldState.publications.length, 1); assert(oldState.draft);
      const oldPublication = oldState.publications[0];
      await old.act(who, { publicationId: oldPublication.publicationId, operationId: randomUUID(), expectedDraftRevision: oldState.draft.revision, action: { kind: 'need_support' } });
      const original = (await f.db.query('SELECT payload_ciphertext FROM platform_onboarding_safety_publications WHERE id=$1', [oldPublication.publicationId])).rows[0];
      const bad = Buffer.from(original.payload_ciphertext); bad[bad.length - 1] ^= 1;
      // Explicit controlled damage after actual old classification/publication;
      // never a fabricated level, approval, handling or asked timestamp.
      await f.db.query('UPDATE platform_onboarding_safety_publications SET payload_ciphertext=$2 WHERE id=$1', [oldPublication.publicationId, bad]);
      const intake = new OnboardingSafetyDelivery(f.db, f.config, FICTIONAL_LEGAL, f.bundle, f.review);
      const published = await intake.publish(who, { submissionId: source.id, operationId: randomUUID(), expectedEdition: 0 }); assert(published);
      const body = await intake.issueBodyProjection(who, { publicationId: published.publicationId });
      assert.equal(Object.hasOwn(body.body, 'question'), false); assert.equal((await intake.read(who, { publicationId: published.publicationId })).handled, false);
      const question = new SafetyQuestionDelivery(f.db, f.crypto, f.resources, undefined, intake);
      await assert.rejects(question.read(who, { sourceKind: 'onboarding', publicationId: published.publicationId }),
        (error: unknown) => error instanceof DataCryptoError || error instanceof ApiError && error.status === 503);
      assert.equal((await intake.read(who, { publicationId: published.publicationId })).status, 'ready');
      const stable = async () => (await f.db.query(`SELECT row_to_json(t)::text AS value FROM
        (SELECT 'publication' AS kind,row_to_json(p)::text AS raw FROM platform_onboarding_safety_publications p WHERE user_id=$1
        UNION ALL SELECT 'followup',row_to_json(o)::text FROM platform_onboarding_safety_followups o WHERE user_id=$1) t ORDER BY kind,raw`, [who.userId])).rows.map(row => row.value);
      const originalRows = await stable();
      for (const sql of [
        `INSERT INTO platform_onboarding_safety_publications(id,user_id,draft_id,response_id,submission_id,source_generation,projection_digest,payload_ciphertext,published_at,retention_until)
          SELECT $2,user_id,draft_id,response_id,submission_id,source_generation,projection_digest,payload_ciphertext,published_at,retention_until FROM platform_onboarding_safety_publications WHERE id=$1`,
        `INSERT INTO platform_onboarding_safety_followups(user_id,operation_id,draft_id,publication_id,action_kind,expected_revision,applied_revision,session_hash,presentation_digest,presentation_operation_id,acknowledgment_operation_id,handled,clarified_at,payload_ciphertext,created_at)
          SELECT user_id,$2,draft_id,publication_id,action_kind,expected_revision,applied_revision,session_hash,presentation_digest,presentation_operation_id,acknowledgment_operation_id,handled,clarified_at,payload_ciphertext,created_at FROM platform_onboarding_safety_followups WHERE publication_id=$1`,
      ]) await assert.rejects(f.db.withBoundedTransaction(async client => {
        const inserted = await client.query(sql, [oldPublication.publicationId, randomUUID()]); assert.equal(inserted.rowCount, 1);
        await client.query('SET CONSTRAINTS ALL IMMEDIATE'); throw new Error('The prospective cutover unexpectedly allowed an old INSERT.');
      }), (error: unknown) => (error as { code?: unknown; message?: string })?.code === '23514'
        && (error as { message: string }).message.includes('Intake resource transport has changed'));
      assert.deepEqual(await stable(), originalRows);
      // New source anchor is a legitimate resource-write delta; the original
      // classified coordinates/result/cost were not changed by body delivery.
      const after = (await f.db.query('SELECT row_to_json(s)::text AS value FROM platform_onboarding_safety_submissions s WHERE id=$1', [source.id])).rows[0].value;
      const beforeData = JSON.parse(sourceBytes), afterData = JSON.parse(after);
      assert.equal(beforeData.first_safety_v2_publication_id, null); assert.equal(afterData.first_safety_v2_publication_id, published.publicationId);
      delete beforeData.first_safety_v2_publication_id; delete afterData.first_safety_v2_publication_id; assert.deepEqual(afterData, beforeData);
      assert.equal(calls.length, 0);
    } finally { await f.close(); }
  });
});
