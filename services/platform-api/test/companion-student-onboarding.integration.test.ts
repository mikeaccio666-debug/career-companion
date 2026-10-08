import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { PLATFORM_ACCOUNT_HEADER, type CompanionStudentJourneyState, type CompanionSealSelectionRequest,
  type CompanionSealSelectionSaved, type CompanionNamingAccepted } from '@companion/platform-contracts';
import { ApiError } from '../src/errors.ts';
import { withStudentOnboardingFixture, studentJourneyPrefix as prefix, studentJourneyOrigin,
  studentJourneyHeaders as headers, assertStudentJourneyResponse as responseStatus,
  type StudentJourneyActor, type StudentOnboardingFixture } from './fixtures/companion-student-onboarding.ts';

// Owned actual PostgreSQL + genuine fictional register/email/provider HTTP.
// Fictional review/maps validate software and persistence only; root executes
// these cases. Resource present commands are explicit test-client declarations,
// not proof of a real browser DOM or a professional safety assessment.
const code = (expected: string) => (error: unknown) => error instanceof ApiError && error.code === expected;
const classifierCalls = (f: StudentOnboardingFixture) => f.requests.filter(request => request.model === 'fictional-prebirth-classifier').length;
const operationUrl = (taskId: string, operationId: string) => `${prefix}/companion/journey/seal/${taskId}/operations/${operationId}`;
async function journey(f: StudentOnboardingFixture, actor = f.who): Promise<Extract<CompanionStudentJourneyState, { kind: 'journey' }>> {
  const response = await f.system.app.inject({ method: 'GET', url: prefix + '/companion/journey', headers: headers(actor) });
  responseStatus(response, 200); const wrapper = response.json<{ journey: CompanionStudentJourneyState }>();
  assert.deepEqual(Object.keys(wrapper), ['journey']); assert.equal(wrapper.journey.kind, 'journey');
  if (wrapper.journey.kind !== 'journey') throw new Error('A genuinely prepared journey is required.');
  return wrapper.journey;
}
async function named(f: StudentOnboardingFixture) {
  const input = f.command('Milo'), accepted = await f.accept(input); await f.execute(accepted);
  const observed = await journey(f); assert(observed.identity && observed.selection);
  assert.equal(observed.stage, 'seal_ready'); assert.equal(observed.identity.name, 'Milo');
  assert.equal(observed.identity.revision, 1); assert.equal(observed.identity.sealCandidates.length, 3);
  assert.equal(observed.identity.sealCandidates[0].char, '墨');
  assert.equal(observed.selection.selectedSeal, null); assert.equal(observed.selection.revision, 0);
  assert.equal(observed.latestNamingOperationId, input.operationId);
  return { input, accepted, observed };
}
function selection(f: StudentOnboardingFixture, current: Awaited<ReturnType<typeof journey>>, index = 0): CompanionSealSelectionRequest {
  assert(current.identity && current.selection);
  return { taskId: current.taskId, expectedIdentityRevision: current.identity.revision, expectedRevision: current.selection.revision,
    operationId: randomUUID(), sealChar: current.identity.sealCandidates[index].char };
}
async function save(f: StudentOnboardingFixture, command: CompanionSealSelectionRequest, actor = f.who): Promise<CompanionSealSelectionSaved> {
  const response = await f.system.app.inject({ method: 'POST', url: prefix + '/companion/journey/seal', headers: headers(actor), payload: command });
  responseStatus(response, 200); assert.deepEqual(Object.keys(response.json()), ['saved']); return response.json().saved;
}
async function ownOperation(f: StudentOnboardingFixture, taskId: string, operationId: string, actor = f.who) {
  const response = await f.system.app.inject({ method: 'GET', url: operationUrl(taskId, operationId), headers: headers(actor) });
  responseStatus(response, 200); assert.deepEqual(Object.keys(response.json()), ['saved']); return response.json<{ saved: CompanionSealSelectionSaved | null }>().saved;
}
async function classification(f: StudentOnboardingFixture, id: string) {
  return (await f.prebirth.db.query(`SELECT row_to_json(t)::text AS value FROM
    (SELECT id,user_id,task_id,submitted_revision,request_ciphertext,claim_ciphertext,result_ciphertext,generation,level,detector_mode,
      auth_version,detector_revision FROM platform_companion_name_submissions WHERE id=$1 AND user_id=$2) t`, [id, f.who.userId])).rows[0].value;
}
function assertViewer(wrapper: any, actor: StudentJourneyActor, verified = true) {
  assert.deepEqual(Object.keys(wrapper).sort(), ['scope', 'user']); assert.equal(wrapper.scope, 'support_resources');
  assert.deepEqual(Object.keys(wrapper.user).sort(), ['email', 'emailVerified', 'id', 'name']);
  assert.equal(wrapper.user.id, actor.userId); assert.equal(wrapper.user.email, actor.email); assert.equal(wrapper.user.emailVerified, verified);
  assert.equal(Object.hasOwn(wrapper, 'execution'), false); assert.equal(Object.hasOwn(wrapper, 'consent'), false);
}

test('C1 actual preview → complete Milo classification → reviewed V2 candidates → explicit persisted seal; refresh is observation only', async () => {
  await withStudentOnboardingFixture(async f => {
    const preview = await journey(f); assert.equal(preview.stage, 'preview'); assert(preview.preview);
    assert.deepEqual(Object.keys(preview.preview).sort(), ['companionId', 'generatedBy', 'inkToken', 'revision', 'samples', 'summary', 'taskId']);
    assert.equal(preview.preview.taskId, preview.taskId); assert.equal(preview.preview.companionId, preview.companionId);
    assert.equal(preview.preview.revision, 1);
    assert.equal(preview.identity, null); assert.equal(preview.selection, null); assert.equal(preview.naming.kind, 'not_started');
    assert.equal(preview.latestNamingOperationId, null);
    assert.equal(f.identityAsset.schemaVersion, 2); assert.equal(f.identityReview.schemaVersion, 2);
    const beforeCalls = classifierCalls(f), { input, accepted, observed } = await named(f), id = accepted.acceptance.submissionId;
    const completed = await f.system.naming.readOperation(f.who, input.operationId); assert(completed);
    assert.deepEqual(completed.progress.detection, { status: 'detected', generation: 1, level: 'L0', mode: 'full' });
    assert.equal(completed.progress.application.status, 'applied'); assert.equal(completed.progress.application.identityRevision, 1);
    assert.equal(classifierCalls(f), beforeCalls + 1);
    const receipt = (await f.prebirth.db.query('SELECT * FROM platform_companion_name_identity_receipts WHERE submission_id=$1', [id])).rows[0];
    const provenance = (await f.prebirth.db.query('SELECT * FROM platform_companion_name_identity_provenance WHERE submission_id=$1', [id])).rows[0];
    assert(receipt && provenance); assert.equal(receipt.identity_revision, 1); assert.equal(receipt.level, 'L0'); assert.equal(receipt.detector_mode, 'full');
    const usage = (await f.prebirth.db.query("SELECT * FROM platform_safety_model_usage WHERE source_kind='companion_name' AND submission_id=$1", [id])).rows;
    assert.equal(usage.length, 1); assert(usage[0].finished_at);
    const inputRow = (await f.prebirth.db.query('SELECT request_ciphertext,submitted_revision FROM platform_companion_name_submissions WHERE id=$1', [id])).rows[0];
    const capsule = JSON.parse(f.prebirth.crypto.openUtf8(inputRow.request_ciphertext, { table: 'platform_companion_name_submissions', column: 'request_ciphertext',
      rowId: id, ownerId: f.who.userId, revision: inputRow.submitted_revision })); assert.deepEqual(capsule.request, input);
    const command = selection(f, observed), saved = await save(f, command); assert.equal(saved.operation.replayed, false);
    assert.equal(saved.selection.selectedSeal, command.sealChar); assert.equal(saved.selection.revision, 1);
    const stable = await f.evidence(), calls = f.requests.length;
    for (let i = 0; i < 3; i++) { const refreshed = await journey(f); assert.equal(refreshed.stage, 'seal_saved'); assert.deepEqual(refreshed.selection, saved.selection); }
    assert.deepEqual(await f.student.identities.readSaved(f.who, { taskId: observed.taskId }), { identity: observed.identity, selection: saved.selection });
    assert.deepEqual(await f.evidence(), stable); assert.equal(f.requests.length, calls);
    for (const table of ['platform_conversations', 'platform_memories', 'platform_jobs']) assert.equal(stable[table].length, 0);
    assert.equal((await f.prebirth.db.query('SELECT status FROM platform_companions WHERE id=$1', [observed.companionId])).rows[0].status, 'awaiting_name');
  });
});

test('C1 actual TCP reply lost after selection COMMIT restores the original operation alongside current later choice', async () => {
  await withStudentOnboardingFixture(async f => {
    const { observed } = await named(f), first = selection(f, observed), calls = f.requests.length;
    await f.dropSelectionReply(first, first.operationId);
    const recovered = await ownOperation(f, first.taskId, first.operationId); assert(recovered);
    assert.equal(recovered.operation.id, first.operationId); assert.equal(recovered.operation.appliedRevision, 1);
    assert.equal(recovered.operation.replayed, true); assert.equal(recovered.selection.selectedSeal, first.sealChar);
    const second = selection(f, await journey(f), 1), secondSaved = await save(f, second); assert.equal(secondSaved.selection.revision, 2);
    const stable = await f.evidence(), original = await ownOperation(f, first.taskId, first.operationId); assert(original);
    assert.equal(original.operation.appliedRevision, 1); assert.equal(original.selection.revision, 2); assert.equal(original.selection.selectedSeal, second.sealChar);
    const replay = await save(f, first); assert.equal(replay.operation.replayed, true); assert.equal(replay.operation.appliedRevision, 1);
    assert.deepEqual(replay.selection, secondSaved.selection); assert.deepEqual(await f.evidence(), stable); assert.equal(f.requests.length, calls);
  });
});

test('C1 current selection CAS, conflicting own operation and invented seal cannot change saved identity or trigger classification', async () => {
  await withStudentOnboardingFixture(async f => {
    const { observed } = await named(f), command = selection(f, observed); await save(f, command);
    const stable = await f.evidence(), calls = f.requests.length;
    for (const [payload, expected] of [
      [{ ...command, operationId: randomUUID() }, 'COMPANION_SEAL_SELECTION_REVISION_CHANGED'],
      [{ ...command, sealChar: observed.identity!.sealCandidates[1].char }, 'COMPANION_SEAL_SELECTION_OPERATION_CONFLICT'],
      [{ ...command, operationId: randomUUID(), expectedRevision: 1, sealChar: '龘' }, 'SEAL_REJECTED'],
    ] as const) {
      await assert.rejects(f.student.select(f.who, payload), code(expected));
      const response = await f.system.app.inject({ method: 'POST', url: prefix + '/companion/journey/seal', headers: headers(f.who), payload });
      responseStatus(response, expected === 'SEAL_REJECTED' ? 422 : 409);
    }
    assert.deepEqual(await f.evidence(), stable); assert.equal(f.requests.length, calls);
  });
});

test('C1 archived identity and own selection survive absent current identity assets, without granting a new selection', async () => {
  await withStudentOnboardingFixture(async f => {
    const { observed } = await named(f), saved = await save(f, selection(f, observed)), extra = await f.withoutIdentityAssets();
    const stable = await f.evidence(), calls = f.requests.length;
    const response = await extra.app.inject({ method: 'GET', url: prefix + '/companion/journey', headers: headers(f.who) }); responseStatus(response, 200);
    assert.deepEqual(response.json().journey.identity, observed.identity); assert.deepEqual(response.json().journey.selection, saved.selection);
    const historical = await extra.studentOnboarding.identities.readSaved(f.who, { taskId: observed.taskId }); assert.deepEqual(historical.selection, saved.selection);
    const next = selection(f, await journey(f), 1);
    const denied = await extra.app.inject({ method: 'POST', url: prefix + '/companion/journey/seal', headers: headers(f.who), payload: next }); responseStatus(denied, 503);
    assert.deepEqual(await f.evidence(), stable); assert.equal(f.requests.length, calls);
  });
});

test('C1 historical viewer bypasses unavailable current terms, while explicit selection still requires genuine current admission', async () => {
  await withStudentOnboardingFixture(async f => {
    const { observed } = await named(f), command = selection(f, observed), extra = await f.withoutLegal(), stable = await f.evidence(), calls = f.requests.length;
    const read = await extra.app.inject({ method: 'GET', url: prefix + '/companion/journey', headers: headers(f.who) }); responseStatus(read, 200);
    assert.deepEqual(read.json().journey.identity, observed.identity);
    const resource = await extra.app.inject({ method: 'GET', url: prefix + '/auth/resource-session', headers: { cookie: f.who.cookie } }); responseStatus(resource, 200); assertViewer(resource.json(), f.who);
    const denied = await extra.app.inject({ method: 'POST', url: prefix + '/companion/journey/seal', headers: headers(f.who), payload: command }); responseStatus(denied, 503);
    assert.deepEqual(await f.evidence(), stable); assert.equal(f.requests.length, calls);
  });
});

test('C1 foreign owners cannot read private task/selection or resume an accepted intent; own missing observations stay null', async () => {
  await withStudentOnboardingFixture(async f => {
    const { observed, input } = await named(f), command = selection(f, observed); await save(f, command);
    const other = await f.register('Fictional independent C student'), stable = await f.evidence(), calls = f.requests.length;
    const own = await f.system.app.inject({ method: 'GET', url: prefix + '/companion/journey', headers: headers(other) }); responseStatus(own, 200);
    assert.deepEqual(own.json().journey, { kind: 'not_started', naming: { kind: 'not_started' } });
    assert.equal(await ownOperation(f, observed.taskId, command.operationId, other), null);
    assert.equal(await ownOperation(f, observed.taskId, randomUUID()), null);
    await assert.rejects(f.student.identities.readSaved(other, { taskId: observed.taskId }), code('NOT_FOUND'));
    const resumed = await f.system.app.inject({ method: 'POST', url: prefix + '/companion/journey/name-preparation', headers: headers(other), payload: { operationId: input.operationId } }); responseStatus(resumed, 404);
    const staleOwner = await f.system.app.inject({ method: 'GET', url: prefix + '/auth/resource-session', headers: { cookie: other.cookie, [PLATFORM_ACCOUNT_HEADER]: f.who.userId } }); responseStatus(staleOwner, 409);
    assert.deepEqual(await f.evidence(), stable); assert.equal(f.requests.length, calls);
  });
});

test('C1 a genuinely older pending raw name blocks latest application and selection until independently classified; explicit resume never reclassifies', async () => {
  await withStudentOnboardingFixture(async f => {
    const { observed } = await named(f), olderCommand = f.command('Juno', 1, 1), older = await f.accept(olderCommand);
    const latestCommand = f.command('Milo', 2, 1), latest = await f.accept(latestCommand), initialCalls = classifierCalls(f);
    await f.execute(latest); assert.equal(classifierCalls(f), initialCalls + 1);
    const authentic = await classification(f, latest.acceptance.submissionId), latestObserved = await f.system.naming.readOperation(f.who, latestCommand.operationId); assert(latestObserved);
    assert.equal(latestObserved.progress.detection.level, 'L0'); assert.equal(latestObserved.progress.application.status, 'pending');
    assert.equal(latestObserved.progress.hold, 'requires_review');
    const stable = await f.evidence();
    await assert.rejects(f.student.select(f.who, selection(f, observed)), code('COMPANION_NAME_SAFETY_REVIEW_REQUIRED'));
    const denied = await f.system.app.inject({ method: 'POST', url: prefix + '/companion/journey/seal', headers: headers(f.who), payload: selection(f, observed) }); responseStatus(denied, 409);
    let refreshed = await journey(f);
    assert.equal(refreshed.stage, 'naming'); assert.equal(refreshed.latestNamingOperationId, latestCommand.operationId);
    for (let i = 0; i < 2; i++) {
      refreshed = await journey(f); assert.equal(refreshed.latestNamingOperationId, latestCommand.operationId);
    }
    assert.deepEqual(await f.evidence(), stable); assert.equal(classifierCalls(f), initialCalls + 1);
    await f.execute(older); assert.equal(classifierCalls(f), initialCalls + 2);
    const beforeResume = classifierCalls(f), resumed = await f.system.app.inject({ method: 'POST', url: prefix + '/companion/journey/name-preparation',
      headers: headers(f.who), payload: { operationId: refreshed.latestNamingOperationId } }); responseStatus(resumed, 200);
    const accepted = resumed.json<{ accepted: CompanionNamingAccepted }>().accepted; assert.equal(accepted.acceptance.submissionId, latest.acceptance.submissionId);
    assert.equal(accepted.progress.application.status, 'applied'); assert.equal(accepted.progress.application.identityRevision, 2);
    assert.equal(classifierCalls(f), beforeResume); assert.equal(await classification(f, latest.acceptance.submissionId), authentic);
    const next = await journey(f); assert.equal(next.stage, 'seal_ready'); assert.equal(next.identity!.revision, 2);
    const selected = await save(f, selection(f, next)); assert.equal(selected.selection.identityRevision, 2);
  });
});

test('C1 pending classified current operation survives fresh GET observation without renewing its original intent or model usage', async () => {
  await withStudentOnboardingFixture(async f => {
    const command = f.command('Milo'), accepted = await f.accept(command), initialCalls = classifierCalls(f);
    await f.execute(accepted);
    const original = await f.system.naming.readOperation(f.who, command.operationId); assert(original);
    assert.equal(original.progress.detection.level, 'L0'); assert.equal(original.progress.detection.mode, 'full');
    assert.equal(original.progress.application.status, 'pending'); assert.equal(original.progress.hold, 'requires_review');
    const stable = await f.evidence(), authenticatedSource = await classification(f, accepted.acceptance.submissionId);
    for (let i = 0; i < 3; i++) {
      // Each actual HTTP GET represents a fresh cookie-authenticated observer;
      // no client intent/accepted-reply cache is required to recover this fact.
      const observed = await journey(f); assert.equal(observed.latestNamingOperationId, command.operationId);
      assert.equal(observed.stage, 'naming'); assert.equal(Object.hasOwn(observed, 'resumeAllowed'), false);
    }
    assert.deepEqual(await f.evidence(), stable); assert.equal(classifierCalls(f), initialCalls + 1);
    const pending = await f.system.app.inject({ method: 'POST', url: prefix + '/companion/journey/name-preparation',
      headers: headers(f.who), payload: { operationId: (await journey(f)).latestNamingOperationId } }); responseStatus(pending, 200);
    const confirmed = pending.json<{ accepted: CompanionNamingAccepted }>().accepted;
    assert.equal(confirmed.acceptance.operation.id, command.operationId); assert.equal(confirmed.progress.application.status, 'pending');
    assert.equal(confirmed.progress.hold, 'requires_review'); assert.equal(classifierCalls(f), initialCalls + 1);
    const fresh = await f.login(f.who); assert.notEqual(fresh.tokenHash, f.who.tokenHash);
    const fromFresh = await journey(f, fresh); assert.equal(fromFresh.latestNamingOperationId, command.operationId);
    const afterLogin = await f.evidence();
    const denied = await f.system.app.inject({ method: 'POST', url: prefix + '/companion/journey/name-preparation',
      headers: headers(fresh), payload: { operationId: fromFresh.latestNamingOperationId } }); responseStatus(denied, 401);
    assert.equal(await classification(f, accepted.acceptance.submissionId), authenticatedSource);
    assert.deepEqual(await f.evidence(), afterLogin); assert.equal(classifierCalls(f), initialCalls + 1);
    // A different genuinely registered owner never receives this operation fact.
    const other = await f.register('Fictional independent latest-coordinate owner');
    const foreign = await f.system.app.inject({ method: 'GET', url: prefix + '/companion/journey', headers: headers(other) }); responseStatus(foreign, 200);
    assert.deepEqual(foreign.json().journey, { kind: 'not_started', naming: { kind: 'not_started' } });
    assert.equal(classifierCalls(f), initialCalls + 1);
  }, { exactOnlyAssets: true });
});

test('C1 preparation accepts only explicit genuine classified own operations; source/usage survive new login and revoked original session', async () => {
  await withStudentOnboardingFixture(async f => {
    const command = f.command(), accepted = await f.accept(command), calls = classifierCalls(f);
    const pending = await f.system.app.inject({ method: 'POST', url: prefix + '/companion/journey/name-preparation', headers: headers(f.who), payload: { operationId: command.operationId } }); responseStatus(pending, 409);
    assert.equal(classifierCalls(f), calls); await f.execute(accepted);
    const original = await f.system.naming.readOperation(f.who, command.operationId); assert(original);
    assert.equal(original.progress.detection.level, 'L0'); assert.equal(original.progress.detection.mode, 'full');
    assert.equal(original.progress.application.status, 'pending'); assert.equal(original.progress.hold, 'requires_review');
    const stable = await f.evidence(), authentic = await classification(f, accepted.acceptance.submissionId), fresh = await f.login(f.who);
    assert.notEqual(fresh.tokenHash, f.who.tokenHash); assert.equal((await journey(f, fresh)).stage, 'naming');
    const renewed = await f.system.app.inject({ method: 'POST', url: prefix + '/companion/journey/name-preparation', headers: headers(fresh), payload: { operationId: command.operationId } }); responseStatus(renewed, 401);
    const ownCurrent = await f.system.naming.readOperation(fresh, command.operationId); assert.equal(ownCurrent?.acceptance.submissionId, accepted.acceptance.submissionId);
    const loggedOut = await f.system.app.inject({ method: 'POST', url: prefix + '/auth/logout', headers: headers(f.who), payload: {} }); assert.equal(loggedOut.statusCode, 200, loggedOut.body);
    const ended = await f.system.app.inject({ method: 'POST', url: prefix + '/companion/journey/name-preparation', headers: headers(f.who), payload: { operationId: command.operationId } }); responseStatus(ended, 401);
    assert.equal(await classification(f, accepted.acceptance.submissionId), authentic); assert.deepEqual(await f.evidence(), stable); assert.equal(classifierCalls(f), calls + 1);
  }, { exactOnlyAssets: true });
});

test('C1 facade rejects getters/extra caller permission and HTTP query authority without reading them or changing saved evidence', async () => {
  await withStudentOnboardingFixture(async f => {
    const stable = await f.evidence(), calls = f.requests.length; let readGetter = 0;
    const input = Object.defineProperty({}, 'operationId', { enumerable: true, get() { readGetter++; return randomUUID(); } });
    await assert.rejects(f.student.resumeNamePreparation(f.who, input), code('INVALID_INPUT')); assert.equal(readGetter, 0);
    for (const [method, url, payload] of [
      ['GET', prefix + '/companion/journey?authorized=true', undefined],
      ['GET', operationUrl(f.ready.prepared.taskId, randomUUID()) + '?handled=true', undefined],
      ['POST', prefix + '/companion/journey/name-preparation', { operationId: randomUUID(), authorized: true }],
      ['POST', prefix + '/companion/journey/seal', { taskId: f.ready.prepared.taskId, expectedIdentityRevision: 0, expectedRevision: 0,
        operationId: randomUUID(), sealChar: '墨', handled: true }],
    ] as const) {
      const response = await f.system.app.inject({ method, url, headers: headers(f.who), payload }); responseStatus(response, 400);
    }
    assert.deepEqual(await f.evidence(), stable); assert.equal(f.requests.length, calls);
  });
});

test('C1 hard refresh with exhausted ordinary API quota still establishes genuine cookie resource owner with a closed read-only DTO', async () => {
  await withStudentOnboardingFixture(async f => {
    // The fixture's actual POST /companion/drafts already consumed this one
    // ordinary API slot. No request-limit rows or DB clock are fabricated.
    const blocked = await f.system.app.inject({ method: 'GET', url: prefix + '/companion/journey', headers: headers(f.who) }); responseStatus(blocked, 429);
    const stable = await f.evidence(), calls = f.requests.length;
    for (const requestHeaders of [{ cookie: f.who.cookie }, headers(f.who)]) {
      const resource = await f.system.app.inject({ method: 'GET', url: prefix + '/auth/resource-session', headers: requestHeaders }); responseStatus(resource, 200); assertViewer(resource.json(), f.who);
    }
    const fakeHeader = await f.system.app.inject({ method: 'GET', url: prefix + '/auth/resource-session', headers: { cookie: f.who.cookie, [PLATFORM_ACCOUNT_HEADER]: randomUUID() } }); responseStatus(fakeHeader, 409);
    const query = await f.system.app.inject({ method: 'GET', url: prefix + '/auth/resource-session?execution=true', headers: { cookie: f.who.cookie } }); responseStatus(query, 400);
    assert.deepEqual(await f.evidence(), stable); assert.equal(f.requests.length, calls);
  }, { apiLimit: 1 });
});

test('C1 real student resource bootstrap bypasses current email/terms gates while seal writes remain closed', async () => {
  await withStudentOnboardingFixture(async f => {
    const { observed } = await named(f), command = selection(f, observed), calls = f.requests.length;
    // Controlled account-admission fixture only. Classified raw/result/usage,
    // review decisions, identity and all evidence remain original bytes.
    await f.prebirth.db.query('UPDATE platform_users SET email_verified_at=NULL WHERE id=$1', [f.who.userId]);
    await f.prebirth.db.query('DELETE FROM platform_terms_consents WHERE user_id=$1', [f.who.userId]);
    const stable = await f.evidence(), historical = await f.student.identities.readSaved(f.who, { taskId: observed.taskId }); assert.deepEqual(historical.identity, observed.identity);
    const resource = await f.system.app.inject({ method: 'GET', url: prefix + '/auth/resource-session', headers: { cookie: f.who.cookie } }); responseStatus(resource, 200); assertViewer(resource.json(), f.who, false);
    const denied = await f.system.app.inject({ method: 'POST', url: prefix + '/companion/journey/seal', headers: headers(f.who), payload: command }); responseStatus(denied, 403);
    const extra = await f.withoutLegal(), independent = await extra.app.inject({ method: 'GET', url: prefix + '/auth/resource-session', headers: { cookie: f.who.cookie } }); responseStatus(independent, 200); assertViewer(independent.json(), f.who, false);
    assert.deepEqual(await f.evidence(), stable); assert.equal(f.requests.length, calls);
  });
});

test('C1 resource bootstrap rejects anonymous, expired/revoked cookie, foreign origin and staff with no execution side effects', async () => {
  await withStudentOnboardingFixture(async f => {
    const staff = await f.staff(), stable = await f.evidence(), calls = f.requests.length;
    const anonymous = await f.system.app.inject({ method: 'GET', url: prefix + '/auth/resource-session' }); responseStatus(anonymous, 401);
    const forbidden = await f.system.app.inject({ method: 'GET', url: prefix + '/auth/resource-session', headers: { cookie: f.who.cookie, origin: 'https://foreign.example.invalid' } }); responseStatus(forbidden, 403);
    const privileged = await f.system.app.inject({ method: 'GET', url: prefix + '/auth/resource-session', headers: { cookie: staff.cookie } }); responseStatus(privileged, 403);
    const loggedOut = await f.system.app.inject({ method: 'POST', url: prefix + '/auth/logout', headers: headers(f.who), payload: {} }); assert.equal(loggedOut.statusCode, 200, loggedOut.body);
    const revoked = await f.system.app.inject({ method: 'GET', url: prefix + '/auth/resource-session', headers: { cookie: f.who.cookie } }); responseStatus(revoked, 401);
    assert.deepEqual(await f.evidence(), stable); assert.equal(f.requests.length, calls);
  });
});

test('C1 genuine 050 high-risk response handling is sealed at prepare as V2, then original full-L0 name and seal complete without regrading the old source', async () => {
  await withStudentOnboardingFixture(async f => {
    assert(f.risk); const risk = f.risk, taskId = f.ready.prepared.taskId;
    const task = (await f.prebirth.db.query('SELECT source_receipt_version,seed_ciphertext,source_revision FROM platform_companion_generation_tasks WHERE id=$1 AND user_id=$2', [taskId, f.who.userId])).rows[0];
    assert.equal(task.source_receipt_version, 2);
    const seed = JSON.parse(f.prebirth.crypto.openUtf8(task.seed_ciphertext, { table: 'platform_companion_generation_tasks', column: 'seed_ciphertext', rowId: taskId,
      ownerId: f.who.userId, revision: task.source_revision })); assert.equal(seed.sourceReceiptVersion, 2);
    const prefixRow = (await f.prebirth.db.query('SELECT * FROM platform_companion_source_prefixes WHERE task_id=$1', [taskId])).rows[0];
    assert.equal(prefixRow.schema_version, 2); assert.equal(prefixRow.payload_digest, seed.sourceReceiptDigest);
    const manifest = JSON.parse(f.prebirth.crypto.openUtf8(prefixRow.payload_ciphertext, { table: 'platform_companion_source_prefixes', column: 'payload_ciphertext',
      rowId: taskId, ownerId: f.who.userId, revision: task.source_revision }));
    assert.equal(manifest.schemaVersion, 2); assert(manifest.handledSubmissionIds.includes(risk.submissionId));
    assert.equal(manifest.intakeResources.length, 1); assert.equal(manifest.intakeResources[0].submissionId, risk.submissionId);
    assert.equal(manifest.intakeResources[0].publicationId, risk.publicationId);
    assert.equal((await f.prebirth.db.query('SELECT count(*)::int AS n FROM platform_onboarding_safety_publications WHERE user_id=$1', [f.who.userId])).rows[0].n, 0);
    const originalSource = async () => (await f.prebirth.db.query(`SELECT row_to_json(t)::text AS value FROM
      (SELECT s.id,s.user_id,s.draft_id,s.operation_id,s.submitted_revision,o.request_ciphertext,s.result_ciphertext,s.generation,s.level,s.detector_mode
      FROM platform_onboarding_safety_submissions s JOIN platform_onboarding_operations o ON o.user_id=s.user_id AND o.operation_id=s.operation_id
      WHERE s.id=$1 AND s.user_id=$2) t`, [risk.submissionId, f.who.userId])).rows[0].value;
    assert.equal(await originalSource(), risk.originalSource);
    assert.equal((await journey(f)).stage, 'preview');
    const { observed } = await named(f), saved = await save(f, selection(f, observed)); assert.equal(saved.selection.selectedSeal, '墨');
    const stable = await f.evidence(), calls = f.requests.length;
    assert.equal((await journey(f)).stage, 'seal_saved'); assert.equal(await originalSource(), risk.originalSource);
    const oldSource = JSON.parse(risk.originalSource); assert.equal(oldSource.level, 'L2'); assert.equal(oldSource.detector_mode, 'keyword_only');
    const handled = (await f.prebirth.db.query('SELECT * FROM platform_onboarding_safety_v2_handled WHERE submission_id=$1', [risk.submissionId])).rows[0];
    assert.equal(handled.level, 'L2'); assert.equal(handled.operation_id, risk.continuationOperationId);
    assert.deepEqual(await f.evidence(), stable); assert.equal(f.requests.length, calls);
  }, { riskIntake: true });
});
