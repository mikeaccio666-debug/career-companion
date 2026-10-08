import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { parseOnboardingDraft } from '@companion/career-core';
import { ApiError } from '../src/errors.ts';
import { tokenHash } from '../src/auth.ts';
import { CompanionNameSafety } from '../src/companion-name-safety.ts';
import { CompanionPrebirthSafety } from '../src/companion-prebirth-safety.ts';
import { FICTIONAL_LEGAL, seedFictionalConsent } from './fixtures/student-entry.ts';
import { createPrebirthFixture, withPrebirthLoopback, classifyPrebirthName, handlePrebirthResource,
  readyStandardPrebirth, type PrebirthFixture, type ReadyPrebirthSource } from './fixtures/companion-prebirth.ts';

// Real isolated PostgreSQL and actual source/receipt paths with fictional actors
// and loopback generation/classification. No public route, actual DOM delivery,
// professional approval, companion birth or production behavior is asserted.
let fixture: PrebirthFixture;
before(async () => { fixture = await createPrebirthFixture(); });
after(async () => { if (fixture) await fixture.close(); });
const code = (expected: string) => (error: unknown) => error instanceof ApiError && error.code === expected;
const unavailable = (error: unknown) => error instanceof ApiError && error.status === 503;
const tables = ['platform_companion_identity_drafts', 'platform_companion_identity_operations',
  'platform_companion_identity_selections', 'platform_companion_identity_selection_operations',
  'platform_companion_name_identity_receipts', 'platform_companion_name_identity_provenance',
  'platform_conversations', 'platform_memories', 'platform_jobs', 'platform_safety_model_usage'] as const;

async function authorityBytes(ready: ReadyPrebirthSource) {
  const result: Record<string, unknown> = {};
  for (const table of tables) result[table] = (await fixture.db.query(
    `SELECT * FROM ${table} WHERE user_id=$1 ORDER BY row_to_json(${table})::text`, [ready.who.userId])).rows;
  return result;
}
async function prebirthBytes(ready: ReadyPrebirthSource) {
  const result = await authorityBytes(ready);
  for (const table of ['platform_onboarding_drafts', 'platform_onboarding_operations',
    'platform_onboarding_safety_submissions',
    'platform_companion_name_entries', 'platform_companion_name_submissions',
    'platform_companion_prebirth_heads',
    'platform_companion_prebirth_inventory', 'platform_companion_name_delivery_heads',
    'platform_companion_name_delivery_operations', 'platform_companion_name_safety_publications',
    'platform_companion_name_safety_body_projections', 'platform_companion_name_safety_followup_states',
    'platform_companion_name_safety_followups', 'platform_companion_name_safety_handled'])
    result[table] = (await fixture.db.query(`SELECT * FROM ${table} WHERE user_id=$1 ORDER BY row_to_json(${table})::text`, [ready.who.userId])).rows;
  return result;
}
function composed(ready: ReadyPrebirthSource) {
  const names = new CompanionNameSafety(fixture.db, fixture.config, FICTIONAL_LEGAL,
    ready.background, ready.names, fixture.resources);
  return new CompanionPrebirthSafety(fixture.db, fixture.config, FICTIONAL_LEGAL,
    ready.background, names, ready.names);
}
const target = (ready: ReadyPrebirthSource, submissionId: string) => ({ taskId: ready.prepared.taskId, submissionId });
async function selection(ready: ReadyPrebirthSource, index = 1) {
  const identity = await ready.names.read(ready.who, { taskId: ready.prepared.taskId });
  assert(identity); assert.equal(identity.sealCandidates.length, 3);
  const current = await ready.names.readSelection(ready.who, { taskId: ready.prepared.taskId });
  return { taskId: ready.prepared.taskId, expectedIdentityRevision: identity.revision,
    expectedRevision: current?.revision ?? 0, operationId: randomUUID(), sealChar: identity.sealCandidates[index].char };
}

async function observedBlock(blocker: number, queryFragment: string) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const waiting = await fixture.db.query(`SELECT pid FROM pg_stat_activity
      WHERE datname=current_database() AND wait_event_type='Lock'
      AND position($1 in query)>0 AND $2=ANY(pg_blocking_pids(pid))`, [queryFragment, blocker]);
    if (waiting.rowCount) return waiting.rows[0].pid as number;
    await new Promise(resolve => setTimeout(resolve, 2));
  }
  assert.fail('Expected an actual PostgreSQL lock wait before releasing the owned gate.');
}

/** An owned test-only SQL trigger pauses a real write while its real owner lock
 * remains held. It does not replace a source, classification, permission or CAS. */
async function withWriteGate(table: 'platform_companion_name_submissions' | 'platform_companion_identity_selection_operations',
  ownerId: string, run: (gate: { pid: number; release: () => Promise<void> }) => Promise<void>) {
  const name = 'prebirth_gate_' + randomUUID().replaceAll('-', ''), gateKey = Math.floor(Math.random() * 2_000_000_000);
  const holder = await fixture.db.pool.connect(); let locked = false;
  try {
    await fixture.db.query(`CREATE FUNCTION ${name}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.user_id='${ownerId}'::uuid THEN PERFORM pg_advisory_xact_lock(94848,${gateKey}); END IF;
      RETURN NEW; END $$`);
    await fixture.db.query(`CREATE TRIGGER ${name} BEFORE INSERT ON ${table} FOR EACH ROW EXECUTE FUNCTION ${name}()`);
    await holder.query('SELECT pg_advisory_lock(94848,$1)', [gateKey]); locked = true;
    const pid = (await holder.query('SELECT pg_backend_pid() AS pid')).rows[0].pid as number;
    await run({ pid, release: async () => {
      if (locked) { await holder.query('SELECT pg_advisory_unlock(94848,$1)', [gateKey]); locked = false; }
    } });
  } finally {
    if (locked) await holder.query('SELECT pg_advisory_unlock(94848,$1)', [gateKey]);
    holder.release();
    await fixture.db.query(`DROP TRIGGER IF EXISTS ${name} ON ${table}`);
    await fixture.db.query(`DROP FUNCTION IF EXISTS ${name}()`);
  }
}

test('complete composition applies genuine latest full L0 and saves an explicit seal once without birth or more provider calls', async () => {
  await withPrebirthLoopback(async (runtime, requests) => {
    const ready = await fixture.ready(runtime), submitted = await classifyPrebirthName(fixture, ready, runtime);
    const service = composed(ready), request = target(ready, submitted.submissionId), calls = requests.length;
    const saved = await service.apply(ready.who, request);
    assert.equal(saved.status, 'applied'); assert.equal(saved.appliedIdentityRevision, 1); assert.equal(saved.replayed, false);
    assert.equal((await service.apply(ready.who, request)).replayed, true);
    const command = await selection(ready), first = await service.select(ready.who, command);
    assert.equal(first.selection.selectedSeal, command.sealChar); assert.equal(first.operation.replayed, false);
    const replay = await service.select(ready.who, command);
    assert.equal(replay.operation.replayed, true); assert.deepEqual(replay.selection, first.selection);
    assert.equal(requests.length, calls);
    for (const table of ['platform_conversations', 'platform_memories', 'platform_jobs'])
      assert.equal((await fixture.db.query(`SELECT count(*)::int AS n FROM ${table} WHERE user_id=$1`, [ready.who.userId])).rows[0].n, 0);
    assert.equal((await fixture.db.query('SELECT status FROM platform_companions WHERE id=$1', [ready.prepared.companionId])).rows[0].status, 'awaiting_name');
  });
});

test('an older genuinely pending raw name blocks latest classified application until its independent classification completes', async () => {
  await withPrebirthLoopback(async runtime => {
    const ready = await fixture.ready(runtime), old = await ready.safety.submit(ready.who, {
      taskId: ready.prepared.taskId, operationId: randomUUID(), name: 'Old note', expectedEntryRevision: 0, expectedIdentityRevision: 0,
    });
    const latest = await classifyPrebirthName(fixture, ready, runtime), service = composed(ready), before = await prebirthBytes(ready);
    await assert.rejects(service.apply(ready.who, target(ready, latest.submissionId)), code('COMPANION_NAME_SAFETY_REVIEW_REQUIRED'));
    assert.deepEqual(await prebirthBytes(ready), before);
    const { CompanionNameSafetyRunner } = await import('../src/companion-name-safety-runner.ts');
    const { prebirthDetector } = await import('./fixtures/companion-prebirth.ts');
    await new CompanionNameSafetyRunner(ready.safety, fixture.config, runtime, prebirthDetector)
      .runSubmission(ready.who, target(ready, old.submissionId));
    assert.equal((await service.apply(ready.who, target(ready, latest.submissionId))).status, 'applied');
  });
});

test('handling a real old L2 permits only a distinct latest full-L0 name and preserves every original risk classification', async () => {
  let ready: ReadyPrebirthSource, riskId: string;
  await withPrebirthLoopback(async runtime => {
    ready = await fixture.ready(runtime);
    const risk = await classifyPrebirthName(fixture, ready, runtime, 'Fictional prebirth high marker');
    riskId = risk.submissionId;
    assert.equal((await ready.safety.apply(ready.who, target(ready, riskId))).status, 'not_eligible');
  }, 'L2');
  await withPrebirthLoopback(async (runtime, requests) => {
    const latest = await classifyPrebirthName(fixture, ready!, runtime), service = composed(ready!), calls = requests.length;
    const original = (await fixture.db.query('SELECT * FROM platform_companion_name_submissions WHERE id=$1', [riskId!])).rows[0];
    const { first_safety_publication_id: initialPublication, ...originalSource } = original;
    assert.equal(initialPublication, null);
    const before = await prebirthBytes(ready!);
    await assert.rejects(service.apply(ready!.who, target(ready!, latest.submissionId)), code('COMPANION_NAME_SAFETY_REVIEW_REQUIRED'));
    assert.deepEqual(await prebirthBytes(ready!), before);
    const handled = await handlePrebirthResource(fixture, ready!.who, riskId!);
    assert.equal((await service.apply(ready!.who, target(ready!, latest.submissionId))).status, 'applied');
    const { first_safety_publication_id: publication, ...currentSource } = (await fixture.db.query(
      'SELECT * FROM platform_companion_name_submissions WHERE id=$1', [riskId!])).rows[0];
    assert.equal(publication, handled.publication.publicationId);
    assert.deepEqual(currentSource, originalSource);
    assert.equal(requests.length, calls);
  });
});

test('a new pending name blocks seal selection of an already saved identity without altering its earlier selection', async () => {
  await withPrebirthLoopback(async runtime => {
    const ready = await fixture.ready(runtime), saved = await classifyPrebirthName(fixture, ready, runtime), service = composed(ready);
    await service.apply(ready.who, target(ready, saved.submissionId));
    const original = await service.select(ready.who, await selection(ready));
    await ready.safety.submit(ready.who, { taskId: ready.prepared.taskId, operationId: randomUUID(), name: '舟',
      expectedEntryRevision: 1, expectedIdentityRevision: 1 });
    const command = await selection(ready, 2), before = await prebirthBytes(ready);
    await assert.rejects(service.select(ready.who, command), code('COMPANION_NAME_SAFETY_REVIEW_REQUIRED'));
    assert.deepEqual(await prebirthBytes(ready), before);
    assert.deepEqual(await ready.names.readSelection(ready.who, { taskId: ready.prepared.taskId }), original.selection);
  });
});

test('full-L0 semantic name rejection persists its real classification and consumes no identity or selection', async () => {
  await withPrebirthLoopback(async (runtime, requests) => {
    const ready = await fixture.ready(runtime), submitted = await classifyPrebirthName(fixture, ready, runtime, '伙伴甲');
    const before = await authorityBytes(ready), calls = requests.length;
    const result = await composed(ready).apply(ready.who, target(ready, submitted.submissionId));
    assert.equal(result.status, 'name_rejected'); assert.equal(result.rejectedCategory, 'family_or_partner');
    assert.equal(result.appliedIdentityRevision, null);
    assert.deepEqual(await authorityBytes(ready), before);
    const stored = (await fixture.db.query('SELECT level,detector_mode,application_status FROM platform_companion_name_submissions WHERE id=$1', [submitted.submissionId])).rows[0];
    assert.deepEqual(stored, { level: 'L0', detector_mode: 'full', application_status: 'name_rejected' });
    assert.equal(requests.length, calls);
  });
});

test('a damaged old canonical request prevents selection even when the current identity and latest source remain intact', async () => {
  await withPrebirthLoopback(async runtime => {
    const ready = await fixture.ready(runtime), first = await classifyPrebirthName(fixture, ready, runtime, 'Old note');
    const latest = await classifyPrebirthName(fixture, ready, runtime), service = composed(ready);
    await service.apply(ready.who, target(ready, latest.submissionId));
    const command = await selection(ready), row = (await fixture.db.query('SELECT request_ciphertext FROM platform_companion_name_submissions WHERE id=$1', [first.submissionId])).rows[0];
    const corrupted = Buffer.from(row.request_ciphertext); corrupted[corrupted.length - 1] ^= 1;
    await fixture.db.query('UPDATE platform_companion_name_submissions SET request_ciphertext=$2 WHERE id=$1', [first.submissionId, corrupted]);
    try {
      const before = await prebirthBytes(ready);
      await assert.rejects(service.select(ready.who, command), unavailable);
      assert.deepEqual(await prebirthBytes(ready), before);
    } finally {
      await fixture.db.query('UPDATE platform_companion_name_submissions SET request_ciphertext=$2 WHERE id=$1', [first.submissionId, row.request_ciphertext]);
    }
    assert.equal((await service.select(ready.who, command)).selection.selectedSeal, command.sealChar);
  });
});

test('current legal admission cannot be replaced by saved full-L0 provenance and restoration requires genuine consent', async () => {
  await withPrebirthLoopback(async runtime => {
    const ready = await fixture.ready(runtime), submitted = await classifyPrebirthName(fixture, ready, runtime), service = composed(ready);
    await service.apply(ready.who, target(ready, submitted.submissionId));
    const command = await selection(ready), before = await prebirthBytes(ready);
    await fixture.db.query('DELETE FROM platform_terms_consents WHERE user_id=$1', [ready.who.userId]);
    try {
      await assert.rejects(service.select(ready.who, command), code('TERMS_CONFIRMATION_REQUIRED'));
      assert.deepEqual(await prebirthBytes(ready), before);
    } finally { await seedFictionalConsent(fixture.db, ready.who.userId); }
    assert.equal((await service.select(ready.who, command)).selection.selectedSeal, command.sealChar);
  });
});

test('a genuine fresh login reads and retries saved selection while the removed original session cannot write', async () => {
  await withPrebirthLoopback(async runtime => {
    const ready = await fixture.ready(runtime), submitted = await classifyPrebirthName(fixture, ready, runtime), service = composed(ready);
    await service.apply(ready.who, target(ready, submitted.submissionId));
    const command = await selection(ready), saved = await service.select(ready.who, command), hash = tokenHash(randomUUID());
    await fixture.db.query(`INSERT INTO platform_sessions(user_id,token_hash,auth_version,expires_at)
      SELECT id,$2,auth_version,clock_timestamp()+interval '1 hour' FROM platform_users WHERE id=$1`, [ready.who.userId, hash]);
    await fixture.db.query('DELETE FROM platform_sessions WHERE token_hash=$1 AND user_id=$2', [ready.who.tokenHash, ready.who.userId]);
    const before = await prebirthBytes(ready);
    await assert.rejects(service.select(ready.who, command), code('AUTH_REQUIRED'));
    assert.deepEqual(await prebirthBytes(ready), before);
    const current = { userId: ready.who.userId, tokenHash: hash };
    const replay = await service.select(current, command);
    assert.equal(replay.operation.replayed, true); assert.deepEqual(replay.selection, saved.selection);
    assert.deepEqual(await prebirthBytes(ready), before);
  });
});

test('two real concurrent selections from the same revision commit one explicit candidate and one stale rejection', async () => {
  await withPrebirthLoopback(async runtime => {
    const ready = await fixture.ready(runtime), submitted = await classifyPrebirthName(fixture, ready, runtime), service = composed(ready);
    await service.apply(ready.who, target(ready, submitted.submissionId));
    const a = await selection(ready, 0), b = await selection(ready, 1);
    const results = await Promise.allSettled([service.select(ready.who, a), service.select(ready.who, b)]);
    const success = results.filter((r): r is PromiseFulfilledResult<Awaited<ReturnType<typeof service.select>>> => r.status === 'fulfilled');
    const failure = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    assert.equal(success.length, 1); assert.equal(failure.length, 1);
    assert(code('COMPANION_SEAL_SELECTION_REVISION_CHANGED')(failure[0].reason));
    const current = await ready.names.readSelection(ready.who, { taskId: ready.prepared.taskId });
    assert.equal(current?.revision, 1); assert.equal(current?.selectedSeal, success[0].value.selection.selectedSeal);
    assert.equal((await fixture.db.query('SELECT count(*)::int AS n FROM platform_companion_identity_selection_operations WHERE user_id=$1', [ready.who.userId])).rows[0].n, 1);
  });
});

test('aborted composition cannot mutate identity and closed commands cannot inject a caller safety decision', async () => {
  await withPrebirthLoopback(async runtime => {
    const ready = await fixture.ready(runtime), submitted = await classifyPrebirthName(fixture, ready, runtime), service = composed(ready);
    const request = target(ready, submitted.submissionId), before = await prebirthBytes(ready), controller = new AbortController();
    const aborted = new Error('Fictional prebirth request aborted'); controller.abort(aborted);
    await assert.rejects(service.apply(ready.who, request, controller.signal), error => error === aborted);
    await assert.rejects(service.apply(ready.who, Object.assign({}, request, { handled: true })), code('INVALID_INPUT'));
    assert.deepEqual(await prebirthBytes(ready), before);
  });
});

test('a genuinely saved later intake text blocks selection while the old completed name remains available as history', async () => {
  await withPrebirthLoopback(async runtime => {
    const ready = await readyStandardPrebirth(fixture, runtime), submitted = await classifyPrebirthName(fixture, ready, runtime);
    const service = composed(ready); await service.apply(ready.who, target(ready, submitted.submissionId));
    const command = await selection(ready), current = await fixture.store.read(ready.who);
    assert(current); const answersPartial = { ...current.answersPartial }; delete answersPartial.extra;
    // Controlled reopening of the current projection only; no product reopen
    // endpoint is claimed. The subsequent raw text and source are real writes.
    const reopened = parseOnboardingDraft({ ...current, answersPartial, state: 'collecting', step: 'O4', currentQuestion: 'extra' });
    await fixture.db.query('UPDATE platform_onboarding_drafts SET payload_ciphertext=$2 WHERE user_id=$1', [ready.who.userId,
      fixture.crypto.sealUtf8(JSON.stringify(reopened), { table: 'platform_onboarding_drafts', column: 'payload_ciphertext',
        rowId: reopened.id, ownerId: ready.who.userId, revision: reopened.revision })]);
    const pending = await fixture.store.save(ready.who, { expectedRevision: reopened.revision, operationId: randomUUID(),
      action: { kind: 'text', questionId: 'extra', text: 'Fictional later prebirth intake note.' } });
    assert.equal(pending.draft.state, 'safety_pending');
    assert.equal((await ready.safety.read(ready.who, { taskId: ready.prepared.taskId }))?.submissions[0].application, 'applied');
    const before = await prebirthBytes(ready);
    await assert.rejects(fixture.db.withBoundedTransaction(async client => {
      await client.query('DELETE FROM platform_onboarding_safety_submissions WHERE user_id=$1', [ready.who.userId]);
      await client.query('DELETE FROM platform_onboarding_operations WHERE user_id=$1 AND operation_id=$2', [ready.who.userId, pending.operation.id]);
      await client.query('SET CONSTRAINTS ALL IMMEDIATE');
      throw new Error('Unexpectedly accepted removal of the original text/source pair.');
    }), error => ['23503', '23514'].includes((error as { code?: string }).code ?? ''));
    assert.deepEqual(await prebirthBytes(ready), before);
    await assert.rejects(service.select(ready.who, command), code('ONBOARDING_SAFETY_REQUIRED'));
    assert.deepEqual(await prebirthBytes(ready), before);
    assert.equal((await fixture.db.query(`SELECT count(*)::int AS n FROM platform_companion_prebirth_inventory
      WHERE user_id=$1 AND kind='intake_operation' AND intake_submission_id IS NOT NULL`, [ready.who.userId])).rows[0].n, 1);
  });
});

test('a genuine raw-name writer already holding the owner lock commits its pending source before the waiting selection rechecks', async () => {
  await withPrebirthLoopback(async (runtime, requests) => {
    const ready = await fixture.ready(runtime), first = await classifyPrebirthName(fixture, ready, runtime), service = composed(ready);
    await service.apply(ready.who, target(ready, first.submissionId));
    const command = await selection(ready), before = await authorityBytes(ready), calls = requests.length;
    await withWriteGate('platform_companion_name_submissions', ready.who.userId, async gate => {
      let writer: ReturnType<typeof ready.safety.submit> | undefined, selecting: ReturnType<typeof service.select> | undefined;
      try {
        writer = ready.safety.submit(ready.who, { taskId: ready.prepared.taskId, operationId: randomUUID(),
          expectedEntryRevision: 1, expectedIdentityRevision: 1, name: 'Later raw note' }); writer.catch(() => {});
        const writerPid = await observedBlock(gate.pid, 'INSERT INTO platform_companion_name_submissions');
        selecting = service.select(ready.who, command); selecting.catch(() => {});
        await observedBlock(writerPid, 'FROM platform_users');
        await gate.release(); const submitted = await writer;
        await assert.rejects(selecting, code('COMPANION_NAME_SAFETY_REVIEW_REQUIRED'));
        assert.deepEqual(await authorityBytes(ready), before); assert.equal(requests.length, calls);
        const source = (await fixture.db.query('SELECT status,generation FROM platform_companion_name_submissions WHERE id=$1', [submitted.submissionId])).rows[0];
        assert.deepEqual(source, { status: 'pending', generation: 0 });
        assert.equal((await fixture.db.query(`SELECT count(*)::int AS n FROM platform_companion_prebirth_inventory
          WHERE user_id=$1 AND kind='name_submission' AND source_id=$2`, [ready.who.userId, submitted.submissionId])).rows[0].n, 1);
      } finally { await gate.release(); await Promise.allSettled([writer, selecting]); }
    });
  });
});

test('a selection holding the owner lock cannot admit a later raw input between its barrier and final receipt COMMIT', async () => {
  await withPrebirthLoopback(async (runtime, requests) => {
    const ready = await fixture.ready(runtime), first = await classifyPrebirthName(fixture, ready, runtime), service = composed(ready);
    await service.apply(ready.who, target(ready, first.submissionId));
    const command = await selection(ready), calls = requests.length;
    await withWriteGate('platform_companion_identity_selection_operations', ready.who.userId, async gate => {
      let selecting: ReturnType<typeof service.select> | undefined, writer: ReturnType<typeof ready.safety.submit> | undefined;
      try {
        selecting = service.select(ready.who, command); selecting.catch(() => {});
        const selectionPid = await observedBlock(gate.pid, 'INSERT INTO platform_companion_identity_selection_operations');
        writer = ready.safety.submit(ready.who, { taskId: ready.prepared.taskId, operationId: randomUUID(),
          expectedEntryRevision: 1, expectedIdentityRevision: 1, name: 'Later raw note' }); writer.catch(() => {});
        await observedBlock(selectionPid, 'FROM platform_users');
        await gate.release(); const saved = await selecting; const submitted = await writer;
        assert.equal(saved.selection.selectedSeal, command.sealChar); assert.equal(saved.operation.replayed, false);
        assert.equal((await fixture.db.query('SELECT status FROM platform_companion_name_submissions WHERE id=$1', [submitted.submissionId])).rows[0].status, 'pending');
        assert.equal(requests.length, calls);
        const before = await prebirthBytes(ready);
        await assert.rejects(service.select(ready.who, command), code('COMPANION_NAME_SAFETY_REVIEW_REQUIRED'));
        assert.deepEqual(await prebirthBytes(ready), before);
        assert.deepEqual(await ready.names.readSelection(ready.who, { taskId: ready.prepared.taskId }), saved.selection);
      } finally { await gate.release(); await Promise.allSettled([selecting, writer]); }
    });
  });
});

test('rewinding a name entry with its actual old cipher cannot erase the later enrolled raw source', async () => {
  await withPrebirthLoopback(async runtime => {
    const ready = await fixture.ready(runtime), old = await classifyPrebirthName(fixture, ready, runtime);
    const oldEntry = (await fixture.db.query('SELECT * FROM platform_companion_name_entries WHERE user_id=$1', [ready.who.userId])).rows[0];
    const oldHead = (await fixture.db.query('SELECT * FROM platform_companion_prebirth_heads WHERE user_id=$1', [ready.who.userId])).rows[0];
    const later = await classifyPrebirthName(fixture, ready, runtime, '舟'), service = composed(ready);
    await service.apply(ready.who, target(ready, later.submissionId)); const before = await prebirthBytes(ready);
    await assert.rejects(fixture.db.withBoundedTransaction(async client => {
      await client.query('UPDATE platform_companion_name_entries SET revision=$2,latest_submission_id=$3,payload_ciphertext=$4 WHERE id=$1',
        [oldEntry.id, oldEntry.revision, old.submissionId, oldEntry.payload_ciphertext]);
      await client.query('DELETE FROM platform_companion_name_submissions WHERE id=$1', [later.submissionId]);
      await client.query('SET CONSTRAINTS ALL IMMEDIATE');
      throw new Error('Unexpectedly accepted original-name tail deletion.');
    }), error => ['23503', '23514'].includes((error as { code?: string }).code ?? ''));
    assert.deepEqual(await prebirthBytes(ready), before);
    await assert.rejects(fixture.db.withBoundedTransaction(async client => {
      await client.query('UPDATE platform_companion_prebirth_heads SET revision=$2,tip_id=$3,tip_digest=$4,payload_ciphertext=$5 WHERE user_id=$1',
        [ready.who.userId, oldHead.revision, oldHead.tip_id, oldHead.tip_digest, oldHead.payload_ciphertext]);
    }), error => (error as { code?: string }).code === '23514');
    assert.deepEqual(await prebirthBytes(ready), before);
  });
});

test('direct SQL cannot clear an enrolled root, rewind its head, remove an enrollment, or erase its referenced original source', async () => {
  await withPrebirthLoopback(async runtime => {
    const ready = await fixture.ready(runtime), submitted = await classifyPrebirthName(fixture, ready, runtime);
    await composed(ready).apply(ready.who, target(ready, submitted.submissionId));
    const before = await prebirthBytes(ready), owner = ready.who.userId;
    const attempts = [
      (client: import('pg').PoolClient) => client.query('UPDATE platform_users SET prebirth_inventory_owner_id=NULL WHERE id=$1', [owner]),
      (client: import('pg').PoolClient) => client.query('DELETE FROM platform_companion_prebirth_heads WHERE user_id=$1', [owner]),
      (client: import('pg').PoolClient) => client.query('UPDATE platform_companion_prebirth_heads SET revision=revision WHERE user_id=$1', [owner]),
      (client: import('pg').PoolClient) => client.query('DELETE FROM platform_companion_prebirth_inventory WHERE user_id=$1', [owner]),
      (client: import('pg').PoolClient) => client.query('DELETE FROM platform_onboarding_operations WHERE user_id=$1', [owner]),
      (client: import('pg').PoolClient) => client.query('DELETE FROM platform_companion_name_entries WHERE user_id=$1', [owner]),
    ];
    for (const mutate of attempts) {
      await assert.rejects(fixture.db.withBoundedTransaction(async client => {
        await mutate(client); await client.query('SET CONSTRAINTS ALL IMMEDIATE');
        throw new Error('Unexpectedly accepted source deletion; roll back the fixture.');
      }), error => ['23503', '23514'].includes((error as { code?: string }).code ?? ''));
      assert.deepEqual(await prebirthBytes(ready), before);
    }
  });
});

test('required typed name-parent coordinates reject actual NULL insertion before duplicate membership can obscure CHECK behavior', async () => {
  await withPrebirthLoopback(async runtime => {
    const ready = await fixture.ready(runtime); await classifyPrebirthName(fixture, ready, runtime);
    const entry = (await fixture.db.query(`SELECT * FROM platform_companion_prebirth_inventory WHERE user_id=$1 AND kind='name_entry'`, [ready.who.userId])).rows[0];
    assert(entry); const before = await prebirthBytes(ready);
    for (const column of ['name_entry_id', 'name_task_id', 'name_companion_id', 'name_preview_revision']) {
      const columns = Object.keys(entry), row = { ...entry, id: randomUUID(), revision: 2_147_483_646, [column]: null };
      await assert.rejects(fixture.db.withBoundedTransaction(async client => {
        await client.query(`INSERT INTO platform_companion_prebirth_inventory(${columns.join(',')}) VALUES(${columns.map((_, index) => '$' + (index + 1)).join(',')})`,
          columns.map(name => row[name]));
        await client.query('SET CONSTRAINTS ALL IMMEDIATE');
        throw new Error('Unexpectedly accepted required-NULL source; roll back the fixture.');
      }), error => (error as { code?: string }).code === '23514');
      assert.deepEqual(await prebirthBytes(ready), before);
    }
  });
});

test('complete populated 048 SQL replays twice independently in two actual schemas and account deletion removes the enrolled aggregate', async () => {
  await withPrebirthLoopback(async runtime => {
    const ready = await fixture.ready(runtime), submitted = await classifyPrebirthName(fixture, ready, runtime);
    await composed(ready).apply(ready.who, target(ready, submitted.submissionId));
    const sql = await readFile(new URL('../migrations/048_companion_prebirth_composition.sql', import.meta.url), 'utf8');
    const before = await prebirthBytes(ready);
    await fixture.db.withBoundedTransaction(async client => { await client.query(sql); await client.query(sql); });
    assert.deepEqual(await prebirthBytes(ready), before);
    const second = await createPrebirthFixture();
    try {
      const other = await second.ready(runtime), raw = await classifyPrebirthName(second, other, runtime);
      const names = new CompanionNameSafety(second.db, second.config, FICTIONAL_LEGAL, other.background, other.names, second.resources);
      const composition = new CompanionPrebirthSafety(second.db, second.config, FICTIONAL_LEGAL, other.background, names, other.names);
      assert.equal((await composition.apply(other.who, target(other, raw.submissionId))).status, 'applied');
      await second.db.withBoundedTransaction(async client => { await client.query(sql); await client.query(sql); });
      assert.equal((await second.db.query('SELECT count(*)::int AS n FROM platform_companion_prebirth_heads WHERE user_id=$1', [other.who.userId])).rows[0].n, 1);
      await second.db.withBoundedTransaction(async client => {
        assert.equal((await client.query('DELETE FROM platform_users WHERE id=$1', [other.who.userId])).rowCount, 1);
        await client.query('SET CONSTRAINTS ALL IMMEDIATE');
      });
      for (const table of ['platform_companion_prebirth_heads', 'platform_companion_prebirth_inventory',
        'platform_companion_name_entries', 'platform_companion_name_submissions', 'platform_companion_identity_drafts'])
        assert.equal((await second.db.query(`SELECT count(*)::int AS n FROM ${table} WHERE user_id=$1`, [other.who.userId])).rows[0].n, 0);
    } finally { await second.close(); }
    assert.deepEqual(await prebirthBytes(ready), before);
  });
});
