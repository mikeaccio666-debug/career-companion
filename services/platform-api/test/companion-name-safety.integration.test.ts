import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { createProviderRuntime } from '@companion/ai-core';
import type { PlatformProviderRuntime } from '@companion/platform-contracts';
import { ApiError } from '../src/errors.ts';
import { tokenHash, type FixedSessionContext } from '../src/auth.ts';
import { requireModelConsent } from '../src/model-consent.ts';
import { parseCompanionNameSubmissionRequest, parseCompanionNameSubmissionClaimRequest, parseCompanionNameSafetyClaim,
  parseCompanionNameSafetyDecision } from '../src/companion-name-safety-protocol.ts';
import { createCompanionNameSafetyFixture } from './fixtures/companion-name-safety.ts';
import { seedFictionalActiveLegal } from './fixtures/student-entry.ts';

let fixture: Awaited<ReturnType<typeof createCompanionNameSafetyFixture>>;
before(async () => { fixture = await createCompanionNameSafetyFixture(); });
after(async () => { await fixture?.close(); });
const code = (expected: string) => (error: unknown) => error instanceof ApiError && error.code === expected;
const request = (taskId: string, name: string, expectedEntryRevision = 0, expectedIdentityRevision = 0) => ({ taskId, name,
  expectedEntryRevision, expectedIdentityRevision, operationId: randomUUID() });
async function loopback(run: (runtime: PlatformProviderRuntime, bodies: unknown[]) => Promise<void>) {
  const bodies: unknown[] = []; let failure: unknown;
  const server = http.createServer(async (incoming, reply) => {
    try {
      const chunks: Buffer[] = []; for await (const chunk of incoming) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString()); bodies.push(body);
      assert.equal(body.store, false); assert.equal(body.model, 'fictional-companion-model'); assert.deepEqual(body.tools ?? [], []);
      const preview = { summary: '说话简短，先把下一步理清楚。', samples: ['可以先聊聊你想试的方向。', '我们先把事情理清楚。', '先选一个小行动。'] };
      const event = { type: 'response.completed', response: { status: 'completed',
        output: [{ type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: JSON.stringify(preview) }] }],
        usage: { input_tokens: 34, output_tokens: 21 } } };
      reply.writeHead(200, { 'content-type': 'text/event-stream' }); reply.end(`data: ${JSON.stringify(event)}\n\ndata: [DONE]\n\n`);
    } catch (error) { failure = error; reply.destroy(); }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); const address = server.address(); assert(address && typeof address === 'object');
  const runtime = requireModelConsent(createProviderRuntime({ env: { PLATFORM_ALLOW_PROVIDER_CALLS: '1', OPENAI_API_KEY: 'fictional-loopback-only',
    OPENAI_COMPANION_GENERATION_MODEL: 'fictional-companion-model' }, fetch: (target, init) => {
    const remote = new URL(String(target)); assert.equal(remote.origin, 'https://api.openai.com'); assert.equal(remote.pathname, '/v1/responses');
    return fetch(`http://127.0.0.1:${address.port}${remote.pathname}`, init);
  } }));
  try { await run(runtime, bodies); if (failure) throw failure; }
  finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
}
async function intake(who: FixedSessionContext) {
  return { drafts: (await fixture.db.query('SELECT * FROM platform_onboarding_drafts WHERE user_id=$1 ORDER BY id', [who.userId])).rows,
    operations: (await fixture.db.query('SELECT * FROM platform_onboarding_operations WHERE user_id=$1 ORDER BY operation_id', [who.userId])).rows };
}
async function rows(who: FixedSessionContext) {
  return (await fixture.db.query('SELECT * FROM platform_companion_name_submissions WHERE user_id=$1 ORDER BY submitted_revision', [who.userId])).rows;
}

test('exact bounded raw source is encrypted and committed before name semantics, provider availability or usage admission', async () => {
  await loopback(async (runtime, bodies) => {
    const { who, prepared, safety } = await fixture.ready(runtime), original = await intake(who);
    const raw = '\n<fictional data> Synthetic highest marker \u0000 ' + '虚构'.repeat(60), input = request(prepared.taskId, raw);
    const saved = await safety.submit(who, input), stored = (await rows(who))[0];
    assert.equal(saved.entry.revision, 1); assert.equal(saved.entry.status, 'pending'); assert.equal(stored.status, 'pending'); assert.equal(stored.generation, 0);
    const capture = JSON.parse(fixture.crypto.openUtf8(stored.request_ciphertext, { table: 'platform_companion_name_submissions', column: 'request_ciphertext',
      rowId: stored.id, ownerId: who.userId, revision: 1 }));
    assert.deepEqual(capture.request, input); assert.equal(capture.previewCapture.source.taskId, prepared.taskId); assert.equal(capture.request.name, raw);
    assert.equal(stored.request_ciphertext.includes(Buffer.from('Synthetic highest marker')), false);
    assert.equal((await fixture.db.query('SELECT count(*)::int AS n FROM platform_safety_model_usage WHERE user_id=$1', [who.userId])).rows[0].n, 0);
    assert.equal((await fixture.db.query('SELECT count(*)::int AS n FROM platform_companion_identity_drafts WHERE user_id=$1', [who.userId])).rows[0].n, 0);
    assert.deepEqual(await intake(who), original); assert.equal(bodies.length, 1);
    const second = await safety.submit(who, request(prepared.taskId, '', 1)); assert.equal(second.entry.revision, 2);
    assert.equal((await rows(who))[1].status, 'pending'); assert.deepEqual(await intake(who), original);
  });
});

test('independent entry CAS and exact raw operation replay serialize one source and preserve latest intended state', async () => {
  await loopback(async (runtime, bodies) => {
    const { who, prepared, safety } = await fixture.ready(runtime), original = await intake(who), input = request(prepared.taskId, ' Juno ');
    const concurrent = await Promise.all([safety.submit(who, input), safety.submit(who, input), safety.submit(who, input)]);
    assert.equal(concurrent.filter(item => !item.operation.replayed).length, 1); assert.equal((await rows(who)).length, 1);
    const next = await safety.submit(who, request(prepared.taskId, '舟', 1, 44)); // Semantic identity CAS is checked only after detection.
    const replay = await safety.submit(who, input); assert.deepEqual(replay.entry, next.entry);
    assert.equal(replay.operation.appliedRevision, 1); assert.equal(replay.operation.replayed, true);
    for (const name of ['Juno', ' juno ', ' Juno\n']) await assert.rejects(safety.submit(who, { ...input, name }), code('COMPANION_NAME_OPERATION_CONFLICT'));
    await assert.rejects(safety.submit(who, request(prepared.taskId, '墨', 0)), code('COMPANION_NAME_ENTRY_REVISION_CHANGED'));
    assert.equal((await rows(who)).length, 2); assert.deepEqual(await intake(who), original); assert.equal(bodies.length, 1);
    const firstClaim = await safety.claim(who, { taskId: prepared.taskId, detectorRevision: 7 }); assert(firstClaim);
    assert.equal(firstClaim.submissionId, concurrent[0].submissionId); assert.equal(firstClaim.submittedAtRevision, 1);
    await safety.fail(firstClaim, 'unavailable');
  });
});

test('closed codecs reject caller authority, accessors, malformed Unicode and unsafe revisions without discarding valid raw semantics', async () => {
  const input = request(randomUUID(), 'Juno'); let accessed = 0;
  for (const key of ['source', 'level', 'mode', 'detectorRevision', 'session', 'userId', 'sealChar', 'review'])
    assert.throws(() => parseCompanionNameSubmissionRequest({ ...input, [key]: 'Fictional caller claim' }));
  const getter = { ...input }; Object.defineProperty(getter, 'name', { enumerable: true, get() { accessed++; return '舟'; } });
  assert.throws(() => parseCompanionNameSubmissionRequest(getter)); assert.equal(accessed, 0);
  const hidden = { ...input }; Object.defineProperty(hidden, 'name', { value: '舟', enumerable: false });
  for (const value of [hidden, { ...input, [Symbol('source')]: true }, { ...input, name: '\ud800' }, { ...input, name: '虚'.repeat(1366) },
    { ...input, expectedEntryRevision: -0 }, { ...input, expectedIdentityRevision: -0 }, { ...input, expectedEntryRevision: 2147483647 }])
    assert.throws(() => parseCompanionNameSubmissionRequest(value));
  for (const name of ['', '\n墨\t', '妈妈', '<fictional>', 'x'.repeat(4096)]) assert.equal(parseCompanionNameSubmissionRequest({ ...input, name }).name, name);
  assert.throws(() => parseCompanionNameSafetyDecision({ level: 'L0', mode: 'keyword_only' }));
  assert.throws(() => parseCompanionNameSafetyDecision({ level: 'L0', mode: 'full', source: {} }));
  assert.throws(() => parseCompanionNameSafetyClaim({ userId: randomUUID(), questionId: 'extra', draftId: randomUUID() }));
});

test('actual session, student account, legal terms and completed call/cost source are rechecked for read and replay', async () => {
  await loopback(async (runtime, bodies) => {
    for (const mode of ['session', 'staff', 'unverified', 'legal', 'completion', 'cost'] as const) {
      const { who, prepared, safety } = await fixture.ready(runtime), input = request(prepared.taskId, 'Juno'), saved = await safety.submit(who, input);
      if (mode === 'session') await fixture.db.query('DELETE FROM platform_sessions WHERE token_hash=$1', [who.tokenHash]);
      if (mode === 'staff') await fixture.db.query("UPDATE platform_users SET account_kind='staff' WHERE id=$1", [who.userId]);
      if (mode === 'unverified') await fixture.db.query('UPDATE platform_users SET email_verified_at=NULL WHERE id=$1', [who.userId]);
      if (mode === 'legal') await fixture.db.query('UPDATE platform_terms_policy SET content_digest=$1', ['0'.repeat(64)]);
      if (mode === 'completion') await fixture.db.query("UPDATE platform_companion_generation_calls SET status='failed' WHERE user_id=$1", [who.userId]);
      if (mode === 'cost') await fixture.db.query('DELETE FROM platform_cost_ledger WHERE user_id=$1', [who.userId]);
      const before = await rows(who), original = await intake(who);
      try {
        for (const action of [() => safety.read(who, { taskId: prepared.taskId }), () => safety.submit(who, input),
          () => safety.submit(who, request(prepared.taskId, '舟', 1)), () => safety.claim(who, { taskId: prepared.taskId, detectorRevision: 7 }),
          () => safety.claimSubmission(who, { taskId: prepared.taskId, submissionId: saved.submissionId, detectorRevision: 7 })])
          await assert.rejects(action(), error => error instanceof ApiError && error.status >= 400);
        assert.deepEqual(await rows(who), before); assert.deepEqual(await intake(who), original);
      } finally { if (mode === 'legal') await seedFictionalActiveLegal(fixture.db); }
    }
    assert.equal(bodies.length, 6);
  });
});

test('damaged, transplanted and canonically re-encrypted false preview captures cannot be read or replayed', async () => {
  await loopback(async (runtime, bodies) => {
    const own = await fixture.ready(runtime), other = await fixture.ready(runtime), input = request(own.prepared.taskId, 'Juno');
    await own.safety.submit(own.who, input); await other.safety.submit(other.who, request(other.prepared.taskId, '舟'));
    const row = (await rows(own.who))[0], foreign = (await rows(other.who))[0], original = await intake(own.who);
    const binding = { table: 'platform_companion_name_submissions', column: 'request_ciphertext', rowId: row.id, ownerId: own.who.userId, revision: 1 };
    const capture = JSON.parse(fixture.crypto.openUtf8(row.request_ciphertext, binding));
    const forged = { ...capture, previewCapture: { ...capture.previewCapture, source: { ...capture.previewCapture.source, sourceRevision: capture.previewCapture.source.sourceRevision + 1 } } };
    for (const ciphertext of [Buffer.alloc(29), foreign.request_ciphertext, fixture.crypto.sealUtf8(JSON.stringify(forged), binding)]) {
      await fixture.db.query('UPDATE platform_companion_name_submissions SET request_ciphertext=$2 WHERE id=$1', [row.id, ciphertext]);
      const before = await rows(own.who);
      for (const action of [() => own.safety.read(own.who, { taskId: own.prepared.taskId }), () => own.safety.submit(own.who, input),
        () => own.safety.claim(own.who, { taskId: own.prepared.taskId, detectorRevision: 7 }),
        () => own.safety.claimSubmission(own.who, { taskId: own.prepared.taskId, submissionId: row.id, detectorRevision: 7 })])
        await assert.rejects(action(), code('COMPANION_NAME_SAFETY_UNAVAILABLE'));
      assert.deepEqual(await rows(own.who), before); assert.deepEqual(await intake(own.who), original);
    }
    await assert.rejects(fixture.db.query('UPDATE platform_companion_name_entries SET latest_submission_id=$2 WHERE user_id=$1', [own.who.userId, foreign.id]), { code: '23503' });
    assert.equal(bodies.length, 2);
  });
});

test('a no-op guard and fabricated admitted full L0 cannot replace an actual completed model usage record', async () => {
  await loopback(async (runtime, bodies) => {
    const { who, prepared, safety } = await fixture.ready(runtime), original = await intake(who);
    await safety.submit(who, request(prepared.taskId, 'Juno'));
    const claim = await safety.claim(who, { taskId: prepared.taskId, detectorRevision: 7 }); assert(claim);
    await assert.rejects(safety.process(claim, async (_input, admission) => admission(async () => ({ level: 'L0', mode: 'full' })), undefined, async () => {}), code('COMPANION_NAME_SAFETY_UNAVAILABLE'));
    let row = (await rows(who))[0]; assert.equal(row.status, 'running'); assert.equal(row.result_ciphertext, null); assert.equal(row.application_status, 'pending');
    await safety.fail(claim, 'invalid_result'); row = (await rows(who))[0]; assert.equal(row.status, 'pending'); assert.equal(row.generation, 1);
    const next = await safety.claim(who, { taskId: prepared.taskId, detectorRevision: 7 }); assert(next);
    await assert.rejects(safety.process(next, async () => ({ level: 'L0', mode: 'full' }), undefined, async () => {}), code('INVALID_SAFETY_RESULT'));
    await safety.fail(next, 'invalid_result');
    assert.equal((await fixture.db.query('SELECT count(*)::int AS n FROM platform_companion_identity_drafts WHERE user_id=$1', [who.userId])).rows[0].n, 0);
    assert.deepEqual(await intake(who), original); assert.equal(bodies.length, 1);
  });
});

test('fresh real login can reclaim an expired source generation while stale execution claims cannot classify it', async () => {
  await loopback(async (runtime, bodies) => {
    const { who, prepared, safety } = await fixture.ready(runtime), original = await intake(who);
    await safety.submit(who, request(prepared.taskId, 'Juno'));
    const first = await safety.claim(who, { taskId: prepared.taskId, detectorRevision: 7 }); assert(first);
    await fixture.db.query('DELETE FROM platform_sessions WHERE token_hash=$1', [who.tokenHash]);
    await fixture.db.query("UPDATE platform_companion_name_submissions SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1", [first.submissionId]);
    const fresh = { userId: who.userId, tokenHash: tokenHash(randomUUID()) };
    await fixture.db.query("INSERT INTO platform_sessions(user_id,token_hash,auth_version,expires_at) VALUES($1,$2,0,clock_timestamp()+interval '1 hour')", [fresh.userId, fresh.tokenHash]);
    const second = await safety.claim(fresh, { taskId: prepared.taskId, detectorRevision: 7 }); assert(second);
    assert.equal(second.submissionId, first.submissionId); assert.equal(second.generation, 2); assert.notEqual(second.leaseToken, first.leaseToken);
    let called = false;
    await assert.rejects(safety.process(first, async () => { called = true; return {}; }, undefined, async () => {}), code('COMPANION_NAME_SAFETY_CLAIM_CHANGED'));
    assert.equal(called, false); await assert.rejects(safety.fail(first, 'unavailable'), code('COMPANION_NAME_SAFETY_CLAIM_CHANGED'));
    await safety.fail(second, 'unavailable'); assert.equal((await rows(who))[0].status, 'pending');
    assert.equal((await rows(who))[0].generation, 2); assert.deepEqual(await intake(fresh), original); assert.equal(bodies.length, 1);
  });
});

test('targeted claim codec snapshots only actual source identifiers and bounded detector options without evaluating caller authority', async () => {
  const input = { taskId: randomUUID(), submissionId: randomUUID(), detectorRevision: 7 }, parsed = parseCompanionNameSubmissionClaimRequest(input);
  assert.deepEqual(parsed, { ...input, leaseMs: 5000 }); assert(Object.isFrozen(parsed));
  input.taskId = randomUUID(); input.submissionId = randomUUID(); input.detectorRevision = 8;
  assert.equal(parsed.detectorRevision, 7); assert.notEqual(parsed.taskId, input.taskId); assert.notEqual(parsed.submissionId, input.submissionId);
  for (const leaseMs of [100, 60000]) assert.equal(parseCompanionNameSubmissionClaimRequest({ ...input, leaseMs }).leaseMs, leaseMs);
  let accessed = 0;
  for (const key of ['taskId', 'submissionId', 'detectorRevision', 'leaseMs']) {
    const getter = { ...input, leaseMs: 5000 }; Object.defineProperty(getter, key, { enumerable: true, get() { accessed++; return parsed.taskId; } });
    assert.throws(() => parseCompanionNameSubmissionClaimRequest(getter), code('INVALID_INPUT'));
    const hidden = { ...input, leaseMs: 5000 }; Object.defineProperty(hidden, key, { value: parsed.taskId, enumerable: false });
    assert.throws(() => parseCompanionNameSubmissionClaimRequest(hidden), code('INVALID_INPUT'));
  }
  assert.equal(accessed, 0);
  for (const extra of ['userId', 'entryId', 'companionId', 'generation', 'authVersion', 'leaseToken', 'executionToken', 'level', 'mode', 'source', 'session'])
    assert.throws(() => parseCompanionNameSubmissionClaimRequest({ ...input, [extra]: randomUUID() }), code('INVALID_INPUT'));
  for (const value of [{ ...input, [Symbol('authority')]: true }, { ...input, submissionId: input.submissionId + '\n' },
    { ...input, taskId: '00000000-0000-0000-0000-00000000000A' }, { ...input, detectorRevision: -0 }, { ...input, detectorRevision: 0 },
    { ...input, detectorRevision: 2147483648 }, { ...input, detectorRevision: 1.5 }, { ...input, leaseMs: undefined },
    { ...input, leaseMs: null }, { ...input, leaseMs: 99 }, { ...input, leaseMs: 60001 }, { ...input, leaseMs: 100.5 }])
    assert.throws(() => parseCompanionNameSubmissionClaimRequest(value), code('INVALID_INPUT'));
});

test('targeted actual source claims serialize one lease while older pending recovery remains ordered and untouched', async () => {
  await loopback(async (runtime, bodies) => {
    const { who, prepared, safety } = await fixture.ready(runtime), original = await intake(who);
    const first = await safety.submit(who, request(prepared.taskId, 'Earlier fictional no-hit'));
    const second = await safety.submit(who, request(prepared.taskId, 'Later fictional source', 1));
    const before = await rows(who), options = { taskId: prepared.taskId, submissionId: second.submissionId, detectorRevision: 7, leaseMs: 60000 };
    const results = await Promise.all(Array.from({ length: 3 }, () => safety.claimSubmission(who, options)));
    assert.equal(results.filter(Boolean).length, 1); const claimed = results.find(Boolean)!;
    assert.equal(claimed.submissionId, second.submissionId); assert.equal(claimed.submittedAtRevision, 2); assert.equal(claimed.generation, 1);
    assert.equal(claimed.operationId, before[1].operation_id); assert.equal(claimed.entryId, before[1].entry_id);
    let after = await rows(who); assert.deepEqual(after[0], before[0]); assert.equal(after[1].status, 'running');
    const unchanged = after;
    assert.equal(await safety.claimSubmission(who, options), null); assert.deepEqual(await rows(who), unchanged);
    const oldest = await safety.claim(who, { taskId: prepared.taskId, detectorRevision: 7, leaseMs: 60000 }); assert(oldest);
    assert.equal(oldest.submissionId, first.submissionId); assert.equal(oldest.submittedAtRevision, 1);
    after = await rows(who); assert.deepEqual(after[1], unchanged[1]); assert.deepEqual(await intake(who), original);
    await safety.fail(oldest, 'unavailable'); await safety.fail(claimed, 'unavailable');
    assert.equal((await rows(who)).every(item => item.status === 'pending' && item.level === null), true);
    assert.equal((await fixture.db.query('SELECT count(*)::int AS n FROM platform_safety_model_usage WHERE user_id=$1', [who.userId])).rows[0].n, 0);
    assert.equal(bodies.length, 1);
  });
});

test('targeted claims reject missing or foreign sources and authenticate unrelated original captures before touching a target', async () => {
  await loopback(async (runtime, bodies) => {
    const own = await fixture.ready(runtime), other = await fixture.ready(runtime), empty = await fixture.ready(runtime);
    const first = await own.safety.submit(own.who, request(own.prepared.taskId, 'Earlier fictional source'));
    const second = await own.safety.submit(own.who, request(own.prepared.taskId, 'Juno', 1));
    const foreign = await other.safety.submit(other.who, request(other.prepared.taskId, '舟'));
    const before = await rows(own.who), otherBefore = await rows(other.who), original = await intake(own.who);
    for (const submissionId of [randomUUID(), foreign.submissionId])
      await assert.rejects(own.safety.claimSubmission(own.who, { taskId: own.prepared.taskId, submissionId, detectorRevision: 7 }), code('COMPANION_NAME_SAFETY_UNAVAILABLE'));
    await assert.rejects(other.safety.claimSubmission(other.who, { taskId: other.prepared.taskId, submissionId: second.submissionId, detectorRevision: 7 }), code('COMPANION_NAME_SAFETY_UNAVAILABLE'));
    await assert.rejects(own.safety.claimSubmission(own.who, { taskId: other.prepared.taskId, submissionId: second.submissionId, detectorRevision: 7 }), code('NOT_FOUND'));
    await assert.rejects(empty.safety.claimSubmission(empty.who, { taskId: empty.prepared.taskId, submissionId: second.submissionId, detectorRevision: 7 }), code('COMPANION_NAME_SAFETY_UNAVAILABLE'));
    assert.deepEqual(await rows(own.who), before); assert.deepEqual(await rows(other.who), otherBefore); assert.deepEqual(await rows(empty.who), []);
    for (const ciphertext of [Buffer.alloc(29), otherBefore[0].request_ciphertext]) {
      await fixture.db.query('UPDATE platform_companion_name_submissions SET request_ciphertext=$2 WHERE id=$1', [first.submissionId, ciphertext]);
      const damaged = await rows(own.who);
      await assert.rejects(own.safety.claimSubmission(own.who, { taskId: own.prepared.taskId, submissionId: second.submissionId, detectorRevision: 7 }), code('COMPANION_NAME_SAFETY_UNAVAILABLE'));
      assert.deepEqual(await rows(own.who), damaged);
    }
    await fixture.db.query('UPDATE platform_companion_name_submissions SET request_ciphertext=$2 WHERE id=$1', [first.submissionId, before[0].request_ciphertext]);
    assert.deepEqual(await rows(own.who), before); assert.deepEqual(await intake(own.who), original); assert.equal(bodies.length, 3);
  });
});

test('expired targeted source recovery binds the new actual session and auth version while old generations remain fenced', async () => {
  await loopback(async (runtime, bodies) => {
    const { who, prepared, safety } = await fixture.ready(runtime), original = await intake(who);
    const saved = await safety.submit(who, request(prepared.taskId, 'Juno'));
    const options = { taskId: prepared.taskId, submissionId: saved.submissionId, detectorRevision: 7, leaseMs: 60000 };
    const first = await safety.claimSubmission(who, options); assert(first);
    const firstRow = (await rows(who))[0];
    const activeCapture = JSON.parse(fixture.crypto.openUtf8(firstRow.claim_ciphertext, { table: 'platform_companion_name_submissions', column: 'claim_ciphertext', rowId: firstRow.id, ownerId: who.userId, revision: 1 }));
    assert.equal(activeCapture.sessionTokenHash, who.tokenHash); assert.deepEqual(activeCapture.claim, first);
    await fixture.db.transaction(async client => {
      await client.query('UPDATE platform_users SET auth_version=auth_version+1 WHERE id=$1', [who.userId]);
      await client.query('DELETE FROM platform_sessions WHERE user_id=$1', [who.userId]);
      await client.query("UPDATE platform_companion_name_submissions SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1", [first.submissionId]);
    });
    const fresh = { userId: who.userId, tokenHash: tokenHash(randomUUID()) };
    await fixture.db.query("INSERT INTO platform_sessions(user_id,token_hash,auth_version,expires_at) VALUES($1,$2,1,clock_timestamp()+interval '1 hour')", [fresh.userId, fresh.tokenHash]);
    const before = await rows(fresh);
    await assert.rejects(safety.claimSubmission(who, options), code('AUTH_REQUIRED')); assert.deepEqual(await rows(fresh), before);
    const second = await safety.claimSubmission(fresh, options); assert(second);
    assert.equal(second.submissionId, first.submissionId); assert.equal(second.generation, 2); assert.equal(second.authVersion, '1'); assert.notEqual(second.leaseToken, first.leaseToken);
    const current = (await rows(fresh))[0], capture = JSON.parse(fixture.crypto.openUtf8(current.claim_ciphertext, { table: 'platform_companion_name_submissions', column: 'claim_ciphertext', rowId: current.id, ownerId: fresh.userId, revision: 2 }));
    assert.equal(capture.sessionTokenHash, fresh.tokenHash); assert.deepEqual(capture.claim, second);
    assert.deepEqual(capture.sourceCapture, activeCapture.sourceCapture); assert.deepEqual(current.request_ciphertext, firstRow.request_ciphertext);
    assert.equal(current.submitted_auth_version, '0'); assert.equal(await safety.claimSubmission(fresh, options), null);
    let called = false;
    await assert.rejects(safety.process(first, async () => { called = true; return {}; }, undefined, async () => {}), code('COMPANION_NAME_SAFETY_CLAIM_CHANGED'));
    await assert.rejects(safety.fail(first, 'unavailable'), code('COMPANION_NAME_SAFETY_CLAIM_CHANGED')); assert.equal(called, false);
    await safety.fail(second, 'unavailable'); assert.equal((await rows(fresh))[0].generation, 2); assert.deepEqual(await intake(fresh), original); assert.equal(bodies.length, 1);
  });
});

test('targeted claims capture caller coordinates before an actual PostgreSQL account lock wait', async () => {
  await loopback(async (runtime, bodies) => {
    const own = await fixture.ready(runtime), other = await fixture.ready(runtime);
    const first = await own.safety.submit(own.who, request(own.prepared.taskId, 'Earlier fictional source'));
    const second = await own.safety.submit(own.who, request(own.prepared.taskId, 'Juno', 1)), original = await intake(own.who), before = await rows(own.who);
    const foreign = await other.safety.submit(other.who, request(other.prepared.taskId, '舟'));
    const holder = await fixture.db.pool.connect(), context = { ...own.who }, options = { taskId: own.prepared.taskId, submissionId: second.submissionId, detectorRevision: 7, leaseMs: 60000 };
    let pending: ReturnType<typeof own.safety.claimSubmission> | undefined;
    try {
      await holder.query('BEGIN'); await holder.query('SELECT id FROM platform_users WHERE id=$1 FOR UPDATE', [own.who.userId]);
      const holderPid = (await holder.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      pending = own.safety.claimSubmission(context, options); pending.catch(() => {});
      let observed = false;
      for (let attempt = 0; attempt < 100; attempt++) {
        const waiting = (await fixture.db.query("SELECT pid FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query=$1 AND $2=ANY(pg_blocking_pids(pid))", ['SELECT id FROM platform_users WHERE id=$1 FOR NO KEY UPDATE', holderPid])).rows;
        if (waiting.length) { observed = true; break; }
        await new Promise(resolve => setTimeout(resolve, 5));
      }
      assert(observed, 'Expected an actual separate PostgreSQL account lock wait.');
      context.userId = other.who.userId; context.tokenHash = other.who.tokenHash;
      options.taskId = other.prepared.taskId; options.submissionId = foreign.submissionId; options.detectorRevision = 99; options.leaseMs = 100;
      await holder.query('COMMIT'); const actual = await pending; assert(actual);
      assert.equal(actual.submissionId, second.submissionId); assert.equal(actual.taskId, own.prepared.taskId); assert.equal(actual.userId, own.who.userId); assert.equal(actual.detectorRevision, 7);
      const after = await rows(own.who); assert.deepEqual(after[0], before[0]); assert.equal(after[1].lease_until.getTime() - after[1].updated_at.getTime() > 59000, true);
      assert.equal((await rows(other.who))[0].generation, 0); assert.equal(after[0].id, first.submissionId); assert.deepEqual(await intake(own.who), original); await own.safety.fail(actual, 'unavailable');
    } finally { await holder.query('ROLLBACK'); holder.release(); await Promise.allSettled([pending]); }
    assert.equal(bodies.length, 2);
  });
});
