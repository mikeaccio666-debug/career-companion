import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createProviderRuntime } from '@companion/ai-core';
import type { PlatformProviderRuntime } from '@companion/platform-contracts';
import { createPrebirthFixture, withPrebirthLoopback, type PrebirthFixture } from './fixtures/companion-prebirth.ts';
import { readyBirth } from './fixtures/companion-birth.ts';
import { FICTIONAL_LEGAL } from './fixtures/student-entry.ts';
import { CompanionPlanningSources } from '../src/companion-planning-source.ts';
import { BackgroundGeneration } from '../src/background-generation.ts';
import { ApiError } from '../src/errors.ts';

let f: PrebirthFixture;
before(async () => { f = await createPrebirthFixture(); });
after(async () => { await f?.close(); });
const denied = (status: number) => (e: unknown) => e instanceof ApiError && e.status === status;
const reader = () => new CompanionPlanningSources(f.db, f.config, FICTIONAL_LEGAL,
  new BackgroundGeneration(f.db, f.config, FICTIONAL_LEGAL, createProviderRuntime({ env: { PLATFORM_ALLOW_PROVIDER_CALLS: '0' } })));
async function born(runtime: PlatformProviderRuntime, q4: 'A' | 'B' | 'C' | 'D' | 'skip' | 'fast' = 'fast') {
  const who = await f.actor();
  if (q4 !== 'fast') {
    let draft = (await f.store.save(who, { operationId: randomUUID(), expectedRevision: 0, action: { kind: 'start', mode: 'standard' } })).draft;
    while (draft.currentQuestion) {
      const action = draft.currentQuestion === 'Q4' && q4 !== 'skip'
        ? { kind: 'answer' as const, questionId: 'Q4' as const, value: q4 }
        : { kind: 'skip' as const, questionId: draft.currentQuestion };
      draft = (await f.store.save(who, { operationId: randomUUID(), expectedRevision: draft.revision, action })).draft;
    }
  }
  const b = await readyBirth(f, runtime, { who });
  const result = await b.service.birth(who, b.body, b.key);
  return { who, b, receipt: result.receipt };
}

test('actual Q4 choices select short steps; explicit skips and fast track do not invent a preference', async () => {
  await withPrebirthLoopback(async (runtime, calls) => {
    for (const q4 of ['A', 'B', 'C', 'D', 'skip', 'fast'] as const) {
      const { who, b, receipt } = await born(runtime, q4), before = calls.length;
      const source = await reader().read(who);
      assert.equal(source.fifteenMinuteSteps, q4 === 'A');
      assert.equal(source.scope, 'birth_answers'); assert.equal(source.revision, 1);
      assert.equal(source.ownerId, who.userId); assert.equal(source.companionId, receipt.identity.companionId);
      assert.equal(source.provenance.taskId, b.ready.prepared.taskId);
      assert.equal(source.provenance.birthReceiptId, receipt.id);
      assert.equal(source.provenance.fastTrack, q4 === 'fast');
      assert.equal(source.provenance.questionState, ['skip', 'fast'].includes(q4) ? 'skipped' : 'answered');
      assert.equal(source.provenance.proofKind, 'historical_completed_preview');
      assert(Object.isFrozen(source)); assert(Object.isFrozen(source.provenance));
      assert.deepEqual(await reader().read(who), source); assert.equal(calls.length, before);
      const json = JSON.stringify(source);
      for (const key of ['answersPartial', 'styleCard', 'samples', 'tokenHash', 'payload_ciphertext', 'dimensions', b.body.name]) assert(!json.includes(key));
    }
  });
});

test('read performs no generation, source rewrite, plan creation or achievement write', async () => {
  await withPrebirthLoopback(async (runtime, calls) => {
    const { who } = await born(runtime, 'A');
    async function rows() {
      const result: Record<string, unknown> = {};
      for (const table of ['platform_companion_answers', 'platform_companion_generation_tasks', 'platform_companion_revisions',
        'platform_companion_birth_receipts', 'platform_daily_plans', 'platform_daily_plan_operations', 'platform_memories', 'platform_jobs'])
        result[table] = (await f.db.query('SELECT * FROM ' + table + ' WHERE user_id=$1 ORDER BY 1', [who.userId])).rows;
      return result;
    }
    const before = await rows(), count = calls.length;
    await reader().read(who);
    assert.deepEqual(await rows(), before); assert.equal(calls.length, count);
  });
});

test('prebirth, staff, extra caller fields, foreign sessions and withdrawn legal admission fail', async () => {
  await withPrebirthLoopback(async runtime => {
    await assert.rejects(reader().read(await f.actor()), denied(409));
    await assert.rejects(reader().read(await f.actor(true)), denied(403));
    const a = await born(runtime, 'A'), b = await born(runtime, 'B');
    assert.equal((await reader().read(a.who)).fifteenMinuteSteps, true);
    assert.equal((await reader().read(b.who)).fifteenMinuteSteps, false);
    await assert.rejects(reader().read({ userId: a.who.userId, tokenHash: b.who.tokenHash }), denied(401));
    await assert.rejects(reader().read({ ...a.who, fifteenMinuteSteps: false } as typeof a.who), denied(401));
    await f.db.query('DELETE FROM platform_terms_consents WHERE user_id=$1', [a.who.userId]);
    await assert.rejects(reader().read(a.who), denied(403));
    await f.db.query('UPDATE platform_users SET auth_version=auth_version+1 WHERE id=$1', [b.who.userId]);
    await assert.rejects(reader().read(b.who), denied(401));
  });
});

test('ciphertext corruption and authenticated but rewritten Q4 cannot replace original command evidence', async () => {
  await withPrebirthLoopback(async runtime => {
    for (const mode of ['corrupt', 'resealed']) {
      const { who } = await born(runtime, 'A');
      const row = (await f.db.query('SELECT * FROM platform_companion_answers WHERE user_id=$1', [who.userId])).rows[0];
      let encrypted: Buffer = Buffer.from('fictional invalid encrypted answer data');
      if (mode === 'resealed') {
        const context = { table: 'platform_companion_answers', column: 'payload_ciphertext', rowId: row.id, ownerId: who.userId, revision: row.source_revision };
        const value = JSON.parse(f.crypto.openUtf8(row.payload_ciphertext, context));
        value.answersPartial.Q4.value = 'B';
        encrypted = f.crypto.sealUtf8(JSON.stringify(value), context);
      }
      await f.db.query('UPDATE platform_companion_answers SET payload_ciphertext=$2 WHERE id=$1', [row.id, encrypted]);
      await assert.rejects(reader().read(who), denied(503));
    }
  });
});

test('database rejects unsupported revisions and binds generation to the actual birth receipt', async () => {
  await withPrebirthLoopback(async runtime => {
    const a = await born(runtime, 'A'), b = await born(runtime, 'B');
    await assert.rejects(f.db.query('UPDATE platform_companions SET current_revision=2 WHERE user_id=$1', [a.who.userId]),
      (e: any) => e.code === '23514' && e.constraint === 'companion_birth_revision');
    assert.equal((await reader().read(a.who)).fifteenMinuteSteps, true);
    await assert.rejects(f.db.query('UPDATE platform_companion_generation_tasks SET generation=generation+1 WHERE user_id=$1', [b.who.userId]),
      (e: any) => e.code === '23503' && e.table === 'platform_companion_birth_receipts');
    assert.equal((await reader().read(b.who)).fifteenMinuteSteps, false);
  });
});

test('late session revocation and cancellation cannot publish a planning source', async () => {
  await withPrebirthLoopback(async runtime => {
    const { who } = await born(runtime, 'A'), original = f.db.withBoundedTransaction.bind(f.db);
    f.db.withBoundedTransaction = async (run, options) => original(c => run(new Proxy(c, { get(target, key) {
      if (key === 'query') return async (sql: any, ...args: any[]) => {
        const result = await (target.query as any)(sql, ...args);
        if (typeof sql === 'string' && sql.startsWith('SELECT a.*,t.source_receipt_version'))
          await target.query('UPDATE platform_users SET auth_version=auth_version+1 WHERE id=$1', [who.userId]);
        return result;
      };
      const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value;
    } })), options);
    try { await assert.rejects(reader().read(who), denied(401)); }
    finally { f.db.withBoundedTransaction = original; }
    await assert.rejects(reader().read(who, AbortSignal.abort()));
  });
});
