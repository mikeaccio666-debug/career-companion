import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { PLATFORM_ACCOUNT_HEADER, type CompanionNamingAccepted, type CompanionNamingProgress } from '@companion/platform-contracts';
import { tokenHash } from '../src/auth.ts';
import { assertPrivateNamingResponse, namingHttpHeaders, namingHttpOrigin, namingHttpPrefix,
  withNamingHttpFixture, type NamingHttpActor, type NamingHttpFixture } from './fixtures/companion-naming-http.ts';

// Real HTTP, PostgreSQL, Redis and runtime paths with explicitly fictional
// actors/assets and strict loopback provider/mail destinations. These tests do
// not establish professional approval, student UI delivery or companion birth.
const path = namingHttpPrefix + '/companion/naming';
const classifierCalls = (f: NamingHttpFixture) => f.requests.filter(request => request.model === 'fictional-prebirth-classifier').length;
async function own(f: NamingHttpFixture, operationId: string, actor: NamingHttpActor = f.who) {
  const response = await f.system.app.inject({ method: 'GET', url: path + '/submissions/' + operationId, headers: namingHttpHeaders(actor) });
  assertPrivateNamingResponse(response, 200);
  assert.deepEqual(Object.keys(response.json()), ['accepted']);
  return response.json<{ accepted: CompanionNamingAccepted | null }>().accepted;
}
async function current(f: NamingHttpFixture, actor: NamingHttpActor = f.who) {
  const response = await f.system.app.inject({ method: 'GET', url: path, headers: namingHttpHeaders(actor) });
  assertPrivateNamingResponse(response, 200); assert.deepEqual(Object.keys(response.json()), ['state']);
  return response.json().state;
}
function assertClosedProgress(progress: CompanionNamingProgress) {
  assert.deepEqual(Object.keys(progress).sort(), ['application', 'detection', 'dispatchId', 'hold', 'phase', 'resource', 'submissionId', 'submittedRevision', 'taskId'].sort());
  assert.deepEqual(Object.keys(progress.detection).sort(), ['generation', 'level', 'mode', 'status'].sort());
  assert.deepEqual(Object.keys(progress.application).sort(), ['identityRevision', 'rejectedCategory', 'status'].sort());
}
function assertClosedAccepted(accepted: CompanionNamingAccepted) {
  assert.deepEqual(Object.keys(accepted).sort(), ['acceptance', 'progress']);
  assert.deepEqual(Object.keys(accepted.acceptance).sort(), ['dispatchId', 'operation', 'submissionId', 'taskId'].sort());
  assert.deepEqual(Object.keys(accepted.acceptance.operation).sort(), ['appliedRevision', 'id', 'replayed'].sort());
  assertClosedProgress(accepted.progress);
}
async function source(f: NamingHttpFixture, accepted: CompanionNamingAccepted) {
  const row = (await f.prebirth.db.query('SELECT * FROM platform_companion_name_submissions WHERE user_id=$1 AND id=$2', [f.who.userId, accepted.acceptance.submissionId])).rows[0];
  assert(row);
  const capture = JSON.parse(f.prebirth.crypto.openUtf8(row.request_ciphertext, {
    table: 'platform_companion_name_submissions', column: 'request_ciphertext', rowId: row.id, ownerId: row.user_id, revision: row.submitted_revision,
  }));
  return { row, capture };
}
async function dispatch(f: NamingHttpFixture, accepted: CompanionNamingAccepted) {
  const row = (await f.prebirth.db.query('SELECT * FROM platform_companion_name_dispatches WHERE user_id=$1 AND id=$2', [f.who.userId, accepted.acceptance.dispatchId])).rows[0];
  assert(row);
  const capture = JSON.parse(f.prebirth.crypto.openUtf8(row.payload_ciphertext, {
    table: 'platform_companion_name_dispatches', column: 'payload_ciphertext', rowId: row.id, ownerId: row.user_id, revision: row.submitted_revision,
  }));
  return { row, capture };
}
async function completed(f: NamingHttpFixture) {
  const accepted = await f.accept(f.command()); await f.startWorker();
  await f.queue.dispatch(); await f.done(accepted.acceptance.dispatchId);
  const saved = await own(f, accepted.acceptance.operation.id); assert(saved);
  assert.equal(saved.progress.application.status, 'applied');
  assert.equal(saved.progress.application.identityRevision, 1);
  assert.equal(classifierCalls(f), 1);
  return accepted;
}

test('naming HTTP rejects caller authority, broken transport, foreign account context and origin without saving a source', async () => {
  await withNamingHttpFixture(async f => {
    const other = await f.other(), staff = await f.other(true);
    const before = await f.evidence(), requests = f.requests.length, command = f.command();
    const denied = [
      { ...command, userId: f.who.userId }, { ...command, level: 'L0' }, { ...command, handled: true },
      { ...command, sessionTokenHash: f.who.tokenHash }, { ...command, provider: 'openai' },
      { ...command, operationId: 'ABCDEF00-1234-4567-89ab-0123456789ab' },
      { ...command, taskId: command.taskId + '\n' }, { ...command, expectedEntryRevision: 0.5 },
      { ...command, expectedIdentityRevision: -1 }, { ...command, name: '中'.repeat(1366) },
      { ...command, name: '\ud800' }, { ...command, name: null },
    ];
    for (const payload of denied) {
      const response = await f.system.app.inject({ method: 'POST', url: path + '/submissions', headers: namingHttpHeaders(f.who), payload });
      assertPrivateNamingResponse(response, 400);
      assert.deepEqual(Object.keys(response.json()), ['error']);
    }
    for (const url of [path + '?classify=true', path + '/submissions/' + command.operationId + '?session=other',
      path + '/submissions/' + command.operationId + '%0A', path + '/submissions/ABCDEF00-1234-4567-89ab-0123456789ab']) {
      assertPrivateNamingResponse(await f.system.app.inject({ method: 'GET', url, headers: namingHttpHeaders(f.who) }), 400);
    }
    assertPrivateNamingResponse(await f.system.app.inject({ method: 'POST', url: path + '/submissions?apply=true', headers: namingHttpHeaders(f.who), payload: command }), 400);
    for (const method of ['GET', 'POST'] as const) {
      const url = method === 'GET' ? path : path + '/submissions';
      const response = await f.system.app.inject({ method, url, headers: { ...namingHttpHeaders(f.who), origin: 'https://foreign.example.invalid' }, ...(method === 'POST' ? { payload: command } : {}) });
      assertPrivateNamingResponse(response, 403); assert.equal(response.json().error.code, 'ORIGIN_REJECTED');
    }
    const noOrigin = { cookie: f.who.cookie, [PLATFORM_ACCOUNT_HEADER]: f.who.userId };
    assertPrivateNamingResponse(await f.system.app.inject({ method: 'POST', url: path + '/submissions', headers: noOrigin, payload: command }), 403);
    const missingAccount = await f.system.app.inject({ method: 'GET', url: path, headers: { cookie: f.who.cookie } });
    assertPrivateNamingResponse(missingAccount, 409); assert.equal(missingAccount.json().error.code, 'ACCOUNT_CONTEXT_REQUIRED');
    const switched = await f.system.app.inject({ method: 'POST', url: path + '/submissions', headers: { ...namingHttpHeaders(f.who), [PLATFORM_ACCOUNT_HEADER]: other.userId }, payload: command });
    assertPrivateNamingResponse(switched, 409); assert.equal(switched.json().error.code, 'ACCOUNT_CONTEXT_CHANGED');
    assertPrivateNamingResponse(await f.system.app.inject({ method: 'GET', url: path, headers: { [PLATFORM_ACCOUNT_HEADER]: f.who.userId } }), 401);
    const staffRead = await f.system.app.inject({ method: 'GET', url: path, headers: namingHttpHeaders(staff) });
    assertPrivateNamingResponse(staffRead, 403); assert.equal(staffRead.json().error.code, 'STUDENT_ACCOUNT_REQUIRED');
    const staffWrite = await f.system.app.inject({ method: 'POST', url: path + '/submissions', headers: namingHttpHeaders(staff), payload: command });
    assertPrivateNamingResponse(staffWrite, 403); assert.equal(staffWrite.json().error.code, 'STUDENT_ACCOUNT_REQUIRED');
    await f.prebirth.db.query('UPDATE platform_users SET email_verified_at=NULL WHERE id=$1', [other.userId]);
    for (const method of ['GET', 'POST'] as const) {
      const response = await f.system.app.inject({ method, url: method === 'GET' ? path : path + '/submissions', headers: namingHttpHeaders(other), ...(method === 'POST' ? { payload: command } : {}) });
      assertPrivateNamingResponse(response, 403); assert.equal(response.json().error.code, 'EMAIL_VERIFICATION_REQUIRED');
    }
    assert.deepEqual(await f.evidence(), before); assert.equal(f.requests.length, requests);
  });
});

test('raw naming HTTP preserves empty, multiline, unnormalized and 4096-byte text before semantic classification', async () => {
  await withNamingHttpFixture(async f => {
    const requests = f.requests.length;
    const names = ['', '  舟\n第二行  ', 'e\u0301', '远'.repeat(40), 'x'.repeat(4096)];
    for (let revision = 0; revision < names.length; revision++) {
      const command = f.command(names[revision]!, revision), accepted = await f.accept(command);
      assertClosedAccepted(accepted);
      assert.deepEqual(accepted.acceptance.operation, { id: command.operationId, appliedRevision: revision + 1, replayed: false });
      assert.equal(accepted.progress.phase, 'queued'); assert.equal(accepted.progress.hold, null);
      assert.deepEqual(accepted.progress.detection, { status: 'pending', generation: 0, level: null, mode: null });
      assert.equal(accepted.progress.resource, 'not_determined');
      const original = await source(f, accepted), intent = await dispatch(f, accepted);
      assert.deepEqual(original.capture.request, command);
      assert.equal(original.capture.request.name, names[revision]);
      assert.equal(original.capture.submittedSessionHash, f.who.tokenHash);
      assert.equal(intent.capture.originalSessionHash, f.who.tokenHash);
      assert.equal(original.row.first_name_dispatch_id, accepted.acceptance.dispatchId);
      assert.equal(intent.row.revision, 0); assert.equal(intent.row.last_operation_id, null);
      const outbox = (await f.prebirth.db.query('SELECT * FROM platform_companion_name_dispatch_outbox WHERE dispatch_id=$1', [intent.row.id])).rows[0];
      assert(outbox); assert.equal(outbox.dispatched_at, null); assert.equal(outbox.held_reason, null);
    }
    assert.equal((await f.prebirth.db.query('SELECT id FROM platform_companion_name_submissions WHERE user_id=$1', [f.who.userId])).rowCount, names.length);
    assert.equal((await f.prebirth.db.query('SELECT call_id FROM platform_safety_model_usage WHERE user_id=$1', [f.who.userId])).rowCount, 0);
    assert.equal(classifierCalls(f), 0); assert.equal(f.requests.length, requests);
  });
});

test('current and own-operation GETs are account-bound pure observation including a fresh same-owner session', async () => {
  await withNamingHttpFixture(async f => {
    assert.deepEqual(await current(f), { kind: 'not_started' });
    const accepted = await f.accept(f.command('  私有原始名字\n  '));
    const other = await f.other(), fresh = await f.login(f.who.userId);
    assert.notEqual(fresh.tokenHash, f.who.tokenHash);
    const before = await f.evidence(), requests = f.requests.length;
    for (const actor of [f.who, fresh]) {
      for (let attempt = 0; attempt < 3; attempt++) {
        const state = await current(f, actor); assert.equal(state.kind, 'naming');
        assert.deepEqual(Object.keys(state).sort(), ['entry', 'kind', 'latest']);
        assert.equal(state.entry.latestSubmissionId, accepted.acceptance.submissionId);
        assertClosedProgress(state.latest);
        const saved = await own(f, accepted.acceptance.operation.id, actor); assert(saved); assertClosedAccepted(saved);
        assert.deepEqual(saved.acceptance.operation, { ...accepted.acceptance.operation, replayed: true });
        assert.equal(saved.progress.phase, 'queued');
      }
    }
    assert.equal(await own(f, accepted.acceptance.operation.id, other), null);
    assert.equal(await own(f, randomUUID(), other), null);
    assert.equal(await own(f, randomUUID()), null);
    assert.deepEqual(await current(f, other), { kind: 'not_started' });
    assert.deepEqual(await f.evidence(), before); assert.equal(f.requests.length, requests);
    // This is naming metadata, not the independently admitted resource body.
    await f.prebirth.db.query('DELETE FROM platform_terms_consents WHERE user_id=$1', [f.who.userId]);
    const afterConsent = await f.evidence();
    assert(await own(f, accepted.acceptance.operation.id, fresh));
    assert.equal((await current(f, fresh)).kind, 'naming');
    const blockedWrite = await f.system.app.inject({ method: 'POST', url: path + '/submissions', headers: namingHttpHeaders(fresh), payload: f.command('灯', 1) });
    assertPrivateNamingResponse(blockedWrite, 403); assert.equal(blockedWrite.json().error.code, 'TERMS_CONFIRMATION_REQUIRED');
    assert.deepEqual(await f.evidence(), afterConsent); assert.equal(f.requests.length, requests);
  });
});

test('a real post-COMMIT lost 202 remains recoverable by its own operation when another source becomes current', async () => {
  await withNamingHttpFixture(async f => {
    const command = f.command(), accepted = await f.dropAcceptedBody(command);
    const original = await source(f, accepted), intent = await dispatch(f, accepted), requests = f.requests.length;
    const later = await f.accept(f.command('灯', 1));
    assert.notEqual(later.acceptance.dispatchId, accepted.acceptance.dispatchId);
    const before = await f.evidence(), state = await current(f);
    assert.equal(state.entry.latestSubmissionId, later.acceptance.submissionId); assert.equal(state.entry.revision, 2);
    const recovered = await own(f, command.operationId); assert(recovered); assertClosedAccepted(recovered);
    assert.deepEqual(recovered.acceptance, { ...accepted.acceptance, operation: { ...accepted.acceptance.operation, replayed: true } });
    assert.equal(recovered.progress.submittedRevision, 1); assert.equal(recovered.progress.phase, 'queued');
    assert.deepEqual((await source(f, accepted)).row.request_ciphertext, original.row.request_ciphertext);
    assert.deepEqual((await dispatch(f, accepted)).row.payload_ciphertext, intent.row.payload_ciphertext);
    assert.deepEqual(await f.evidence(), before); assert.equal(f.requests.length, requests); assert.equal(classifierCalls(f), 0);
    const replay = await f.accept(command);
    assert.deepEqual(replay.acceptance, recovered.acceptance);
    const stale = await f.system.app.inject({ method: 'POST', url: path + '/submissions', headers: namingHttpHeaders(f.who), payload: f.command('远') });
    assertPrivateNamingResponse(stale, 409); assert.equal(stale.json().error.code, 'COMPANION_NAME_ENTRY_REVISION_CHANGED');
    assert.equal(stale.json().error.message, 'Read the current naming progress before submitting another name.');
    const conflictingRaw = '  fictional conflicting raw name\n  ';
    const conflict = await f.system.app.inject({ method: 'POST', url: path + '/submissions', headers: namingHttpHeaders(f.who), payload: { ...command, name: conflictingRaw } });
    assertPrivateNamingResponse(conflict, 409); assert.equal(conflict.json().error.code, 'COMPANION_NAME_OPERATION_CONFLICT');
    assert.equal(conflict.json().error.message, 'Use the saved naming request or a new operation identifier for different text.');
    for (const response of [stale, conflict]) {
      assert(!response.body.includes(command.name)); assert(!response.body.includes(conflictingRaw));
      assert(!response.body.includes(command.operationId)); assert(!response.body.includes(accepted.acceptance.submissionId));
    }
    assert.deepEqual(await f.evidence(), before); assert.equal(f.requests.length, requests);
  });
});

test('an independent real Redis naming worker continues after the accepted HTTP socket is destroyed', async () => {
  await withNamingHttpFixture(async f => {
    const accepted = await f.dropAcceptedBody(f.command());
    assert.equal(classifierCalls(f), 0);
    await f.startWorker(); await f.queue.dispatch(); await f.done(accepted.acceptance.dispatchId);
    const saved = await own(f, accepted.acceptance.operation.id); assert(saved);
    assertClosedAccepted(saved); assert.equal(saved.progress.phase, 'detected'); assert.equal(saved.progress.hold, null);
    assert.deepEqual(saved.progress.detection, { status: 'detected', generation: 1, level: 'L0', mode: 'full' });
    assert.deepEqual(saved.progress.application, { status: 'applied', rejectedCategory: null, identityRevision: 1 });
    assert.equal(saved.progress.resource, 'not_required'); assert.equal(classifierCalls(f), 1);
    const job = await f.queue.queue.getJob(accepted.acceptance.dispatchId); assert(job);
    assert.equal(job.id, accepted.acceptance.dispatchId); assert.equal(job.name, 'companion-name');
    assert.deepEqual(job.data, { dispatchId: accepted.acceptance.dispatchId, taskId: accepted.acceptance.taskId, submissionId: accepted.acceptance.submissionId });
    const usage = (await f.prebirth.db.query('SELECT * FROM platform_safety_model_usage WHERE user_id=$1 AND submission_id=$2', [f.who.userId, accepted.acceptance.submissionId])).rows;
    assert.equal(usage.length, 1); assert.equal(usage[0].source_kind, 'companion_name');
    assert.equal(usage[0].generation, 1); assert.equal(usage[0].status, 'complete'); assert.equal(usage[0].usage_status, 'reported');
    assert.equal(usage[0].input_tokens, 34); assert.equal(usage[0].output_tokens, 21);
    const before = await f.evidence(), calls = classifierCalls(f);
    await own(f, accepted.acceptance.operation.id); await current(f);
    assert.deepEqual(await f.evidence(), before); assert.equal(classifierCalls(f), calls);
  });
});

test('real logout deletes the original session without erasing source, dispatch or usage; a new viewer cannot execute it', async () => {
  await withNamingHttpFixture(async f => {
    const finished = await completed(f), pending = await f.accept(f.command('灯', 1, 1));
    const before = await f.evidence(), calls = classifierCalls(f);
    const response = await f.system.app.inject({ method: 'POST', url: namingHttpPrefix + '/auth/logout', headers: namingHttpHeaders(f.who), payload: {} });
    assertPrivateNamingResponse(response, 200); assert.deepEqual(response.json(), { ok: true });
    assert.equal((await f.prebirth.db.query('SELECT token_hash FROM platform_sessions WHERE token_hash=$1', [f.who.tokenHash])).rowCount, 0);
    assert.deepEqual(await f.evidence(), before);
    assertPrivateNamingResponse(await f.system.app.inject({ method: 'GET', url: path, headers: namingHttpHeaders(f.who) }), 401);
    const fresh = await f.login(f.who.userId); assert.notEqual(fresh.tokenHash, f.who.tokenHash);
    const viewerBefore = await f.evidence();
    assert.equal((await own(f, finished.acceptance.operation.id, fresh))?.progress.application.status, 'applied');
    assert.equal((await own(f, pending.acceptance.operation.id, fresh))?.progress.phase, 'queued');
    assert.equal((await current(f, fresh)).entry.latestSubmissionId, pending.acceptance.submissionId);
    assert.deepEqual(await f.evidence(), viewerBefore); assert.equal(classifierCalls(f), calls);
    // The older fixture session is also still real/live. Neither that session
    // nor the fresh viewer may replace the source's actual revoked HTTP session.
    assert.equal((await f.prebirth.db.query('SELECT token_hash FROM platform_sessions WHERE token_hash=$1', [f.ready.who.tokenHash])).rowCount, 1);
    await f.queue.dispatch(); await f.done(pending.acceptance.dispatchId);
    const held = await own(f, pending.acceptance.operation.id, fresh); assert(held);
    assert.equal(held.progress.phase, 'held'); assert.equal(held.progress.hold, 'authorization_required');
    assert.deepEqual(held.progress.detection, { status: 'pending', generation: 0, level: null, mode: null });
    assert.equal((await dispatch(f, pending)).capture.originalSessionHash, f.who.tokenHash);
    assert.equal(classifierCalls(f), calls);
    assert.equal((await f.prebirth.db.query('SELECT call_id FROM platform_safety_model_usage WHERE user_id=$1', [f.who.userId])).rowCount, 1);
  });
});

test('a real generated password-reset token revokes all sessions but preserves naming evidence for a fresh observer', async () => {
  await withNamingHttpFixture(async f => {
    const finished = await completed(f), pending = await f.accept(f.command('灯', 1, 1));
    const token = await f.actualResetToken(f.who), before = await f.evidence(), calls = classifierCalls(f);
    const password = 'Fictional-new-naming-http-password-2026!';
    const reset = await f.system.app.inject({ method: 'POST', url: namingHttpPrefix + '/auth/password-reset/complete', headers: { origin: namingHttpOrigin }, payload: { token, password } });
    assertPrivateNamingResponse(reset, 200); assert.deepEqual(reset.json(), { ok: true });
    assert.equal((await f.prebirth.db.query('SELECT token_hash FROM platform_sessions WHERE user_id=$1', [f.who.userId])).rowCount, 0);
    assert.equal((await f.prebirth.db.query('SELECT auth_version FROM platform_users WHERE id=$1', [f.who.userId])).rows[0].auth_version, '1');
    assert((await f.prebirth.db.query('SELECT consumed_at FROM platform_account_actions WHERE user_id=$1 AND token_hash=$2', [f.who.userId, tokenHash(token)])).rows[0].consumed_at);
    assert.deepEqual(await f.evidence(), before);
    const oldLogin = await f.system.app.inject({ method: 'POST', url: namingHttpPrefix + '/auth/login', headers: { origin: namingHttpOrigin }, payload: { email: f.who.email, password: f.who.password } });
    assertPrivateNamingResponse(oldLogin, 401);
    const fresh = await f.login(f.who.userId, password), observer = await f.evidence();
    assert.equal((await own(f, finished.acceptance.operation.id, fresh))?.progress.application.status, 'applied');
    assert.equal((await own(f, pending.acceptance.operation.id, fresh))?.progress.phase, 'queued');
    assert.equal((await current(f, fresh)).entry.latestSubmissionId, pending.acceptance.submissionId);
    assert.deepEqual(await f.evidence(), observer); assert.equal(classifierCalls(f), calls);
    await f.queue.dispatch(); await f.done(pending.acceptance.dispatchId);
    const held = await own(f, pending.acceptance.operation.id, fresh); assert(held);
    assert.equal(held.progress.hold, 'authorization_required'); assert.equal(held.progress.detection.generation, 0);
    assert.equal((await dispatch(f, pending)).capture.originalSessionHash, f.who.tokenHash);
    assert.equal(classifierCalls(f), calls);
    assert.equal((await f.prebirth.db.query('SELECT call_id FROM platform_safety_model_usage WHERE user_id=$1', [f.who.userId])).rowCount, 1);
  });
});

test('real prehandler API max1 returns known-unaccepted 429 with Retry-After and no source or dispatch', async () => {
  await withNamingHttpFixture(async f => {
    const before = await f.evidence(), requests = f.requests.length;
    assert.deepEqual(await current(f), { kind: 'not_started' });
    const rejected = await f.system.app.inject({ method: 'POST', url: path + '/submissions', headers: namingHttpHeaders(f.who), payload: f.command() });
    assertPrivateNamingResponse(rejected, 429); assert.equal(rejected.json().error.code, 'REQUEST_LIMIT_REACHED');
    assert.match(String(rejected.headers['retry-after']), /^[1-9][0-9]*$/);
    assert.deepEqual(await f.evidence(), before); assert.equal(f.requests.length, requests); assert.equal(classifierCalls(f), 0);
    assert.equal((await f.prebirth.db.query('SELECT id FROM platform_companion_name_submissions WHERE user_id=$1', [f.who.userId])).rowCount, 0);
    assert.equal((await f.prebirth.db.query('SELECT id FROM platform_companion_name_dispatches WHERE user_id=$1', [f.who.userId])).rowCount, 0);
    assert.equal((await f.prebirth.db.query('SELECT dispatch_id FROM platform_companion_name_dispatch_outbox WHERE user_id=$1', [f.who.userId])).rowCount, 0);
  }, 'L0', { apiLimit: 1 });
});
