import assert from 'node:assert/strict';
import test from 'node:test';
import type { JobOutcomeReviewInput, JobOutcomeReviewPage, JobOutcomeReviewRecord } from '@companion/platform-contracts';
import { ApiError } from '../src/api.ts';
import { AccountRequestContext } from '../src/account-context.ts';
import { JobOutcomeReviewController } from '../src/job-outcome-reviews-controller.ts';
import { deferred, flush, jobId, page, record, requestId } from './job-outcome-reviews-fixture.ts';

function harness(options: { generation?: number; isCurrent?: () => boolean; read?: (generation: number | undefined, signal?: AbortSignal) => Promise<JobOutcomeReviewPage>; save?: (input: JobOutcomeReviewInput, signal?: AbortSignal) => Promise<JobOutcomeReviewRecord>; requestId?: () => string } = {}) {
  const state = { current: true, online: true }, reads: (number | undefined)[] = [], writes: JobOutcomeReviewInput[] = [], readSignals: AbortSignal[] = [], saveSignals: AbortSignal[] = []; let next = 0;
  const controller = new JobOutcomeReviewController({
    read: async (_jobId, generation, signal) => { assert.equal(_jobId, jobId); reads.push(generation); if (signal) readSignals.push(signal); return options.read ? options.read(generation, signal) : page(); },
    save: async (_jobId, input, signal) => { assert.equal(_jobId, jobId); writes.push(input); if (signal) saveSignals.push(signal); return options.save ? options.save(input, signal) : saved(input); },
  }, jobId, options.generation, { isCurrent: options.isCurrent ?? (() => state.current), isOnline: () => state.online, requestId: options.requestId ?? (() => `62000000-0000-4000-8000-${String(++next).padStart(12, '0')}`) });
  return { controller, state, reads, writes, readSignals, saveSignals };
}
function saved(input: JobOutcomeReviewInput) { return record({ generation: input.generation, revision: input.expectedRevision + 1, requestId: input.requestId, evidenceVersion: input.evidenceVersion, outcome: input.outcome, note: input.note }); }
const edit = (controller: JobOutcomeReviewController, note = 'Fictional personally checked record.') => controller.edit({ outcome: 'still_unknown', note });

test('a standalone entry has no automatic network activity and freezes its first owned version', async () => {
  let calls = 0;
  const context = harness({ read: async () => ++calls === 1 ? page({ requestedGeneration: 3, currentGeneration: 3, evidence: { ...page().evidence!, generation: 3 } }) : page({ requestedGeneration: 3, currentGeneration: 4, evidence: null, writeEligibility: { allowed: false, reason: 'historical_generation' } }) });
  context.controller.start(); assert.deepEqual(context.reads, []); await context.controller.open(); assert.deepEqual(context.reads, [undefined]); assert.equal(context.controller.getSnapshot().generation, 3);
  edit(context.controller); await context.controller.refresh(); assert.deepEqual(context.reads, [undefined, 3]); assert.equal(context.controller.getSnapshot().generation, 3); assert.equal(context.controller.getSnapshot().note, 'Fictional personally checked record.');
  await context.controller.save(); context.controller.acknowledgeConflict(); await context.controller.save(); assert.equal(context.writes.length, 0); assert.equal(context.controller.getSnapshot().page?.currentGeneration, 4); context.controller.stop();
});

test('conversation and plan entries request their exact bound version, including historical readonly records', async () => {
  const historical = page({ currentGeneration: 2, evidence: null, writeEligibility: { allowed: false, reason: 'historical_generation' }, latestRevision: 1, records: [record()] });
  const context = harness({ generation: 1, read: async () => historical }); context.controller.start(); await context.controller.open(); assert.deepEqual(context.reads, [1]); assert.equal(context.controller.getSnapshot().page?.evidence, null);
  edit(context.controller, 'Fictional old-version observation'); await context.controller.save(); assert.equal(context.writes.length, 0); assert.equal(context.controller.getSnapshot().generation, 1); context.controller.stop();
});

test('StrictMode setup-cleanup-setup invalidates old successful and failed reads without consuming the new lifetime', async () => {
  for (const rejected of [false, true]) {
    const old = deferred<JobOutcomeReviewPage>(), fresh = deferred<JobOutcomeReviewPage>(); let calls = 0;
    const context = harness({ read: async () => ++calls === 1 ? old.promise : fresh.promise });
    context.controller.start(); const oldRead = context.controller.open(); context.controller.stop(); assert.equal(context.readSignals[0].aborted, true);
    context.controller.start(); const freshRead = context.controller.open();
    if (rejected) old.reject(new Error('Fictional abandoned failure')); else old.resolve(page({ currentGeneration: 99 })); await oldRead;
    assert.equal(context.controller.getSnapshot().loading, true); assert.equal(context.controller.getSnapshot().page, null); assert.equal(context.controller.getSnapshot().error, '');
    fresh.resolve(page()); await freshRead; assert.equal(context.controller.getSnapshot().page?.currentGeneration, 1); assert.equal(context.controller.getSnapshot().loading, false); context.controller.stop();
  }
});

test('account A to B to A never makes an old captured A response current again', async () => {
  const accounts = new AccountRequestContext(), a = '71000000-0000-4000-8000-000000000001', b = '71000000-0000-4000-8000-000000000002'; accounts.changeSession(a); const capture = accounts.capture()!;
  const late = deferred<JobOutcomeReviewPage>(), old = harness({ isCurrent: () => accounts.isCurrent(capture), read: async () => late.promise }); old.controller.start(); const read = old.controller.open();
  accounts.changeSession(b); assert.equal(old.controller.getSnapshot().opened, false); accounts.changeSession(a); assert.equal(accounts.isCurrent(capture), false);
  late.resolve(page()); await read; assert.equal(old.controller.getSnapshot().page, null); assert.equal(old.controller.getSnapshot().note, ''); await old.controller.save(); assert.equal(old.writes.length, 0); old.controller.stop();
});

test('only explicit save writes once; a double click cannot replay or advance execution', async () => {
  const reply = deferred<JobOutcomeReviewRecord>(), context = harness({ save: async () => reply.promise }); context.controller.start(); await context.controller.open(); edit(context.controller, '  Fictional personally checked record. \n');
  const first = context.controller.save(); await context.controller.save(); assert.equal(context.writes.length, 1); assert.equal(context.writes[0].note, 'Fictional personally checked record.'); assert.equal(context.reads.length, 1);
  reply.resolve(saved(context.writes[0])); await first; assert.equal(context.controller.getSnapshot().phase, 'saved'); assert.equal(context.controller.getSnapshot().page?.evidence?.status, 'uncertain'); assert.equal(context.controller.getSnapshot().page?.latestRevision, 1);
  await context.controller.save(); assert.equal(context.writes.length, 1); assert.equal(context.reads.length, 1); context.controller.stop();
});

test('lost committed POST responses remain unconfirmed until an explicit GET finds the same request ID', async () => {
  let committed: JobOutcomeReviewRecord | null = null;
  const context = harness({ read: async () => committed ? page({ latestRevision: 1, records: [committed] }) : page(), save: async (input) => { committed = saved(input); throw new TypeError('Fictional lost response'); } });
  context.controller.start(); await context.controller.open(); edit(context.controller); await context.controller.save(); assert.equal(context.controller.getSnapshot().phase, 'save_unconfirmed'); assert.equal(context.controller.getSnapshot().pending?.requestId, requestId); assert.equal(context.reads.length, 1);
  await context.controller.save(); context.controller.newReport(); context.controller.acknowledgeConflict(); assert.equal(context.writes.length, 1);
  await context.controller.refresh(); assert.equal(context.controller.getSnapshot().phase, 'saved'); assert.equal(context.controller.getSnapshot().pending, null); assert.equal(context.controller.getSnapshot().saved?.requestId, requestId); assert.equal(context.writes.length, 1); assert.equal(context.reads.length, 2); context.controller.stop();
});

test('an uncertain request absent from the bounded recent history stays unconfirmed even with more history', async () => {
  const records = Array.from({ length: 20 }, (_, n) => record({ id: `64000000-0000-4000-8000-${String(n).padStart(12, '0')}`, requestId: `65000000-0000-4000-8000-${String(n).padStart(12, '0')}`, revision: 25 - n })); let reads = 0;
  const context = harness({ read: async () => ++reads === 1 ? page() : page({ records, latestRevision: 25, hasMore: true }), save: async () => { throw new Error('Fictional unavailable response'); } });
  context.controller.start(); await context.controller.open(); edit(context.controller); await context.controller.save(); await context.controller.refresh(); assert.equal(context.controller.getSnapshot().phase, 'save_unconfirmed'); assert.match(context.controller.getSnapshot().error, /不证明没有保存/);
  context.controller.close(); await context.controller.open(); await context.controller.save(); assert.equal(context.writes.length, 1); assert.equal(context.controller.getSnapshot().pending?.requestId, requestId); context.controller.stop();
});

test('a mismatched successful receipt is not shown as saved and cannot automatically resubmit', async () => {
  const context = harness({ save: async (input) => saved({ ...input, requestId: jobId }) }); context.controller.start(); await context.controller.open(); edit(context.controller); await context.controller.save();
  assert.equal(context.controller.getSnapshot().phase, 'save_unconfirmed'); assert.equal(context.controller.getSnapshot().saved, null); await context.controller.save(); assert.equal(context.writes.length, 1); context.controller.stop();
});

test('CAS conflict keeps the original draft and target, requires a successful read and explicit acknowledgement', async () => {
  let reads = 0, writes = 0;
  const other = record({ requestId: jobId, note: 'Fictional other-window observation.' });
  const context = harness({ read: async () => ++reads === 1 ? page() : page({ latestRevision: 1, records: [other], evidence: { ...page().evidence!, version: 'b'.repeat(64) } }), save: async (input) => { if (++writes === 1) throw new ApiError('Fictional conflict must remain visible.', 409, 'JOB_OUTCOME_REVISION_CONFLICT'); return saved(input); } });
  context.controller.start(); await context.controller.open(); edit(context.controller, 'Fictional unchanged draft.'); await context.controller.save(); assert.equal(context.controller.getSnapshot().phase, 'conflict'); assert.equal(context.controller.getSnapshot().note, 'Fictional unchanged draft.');
  context.controller.acknowledgeConflict(); await context.controller.save(); assert.equal(context.writes.length, 1);
  await context.controller.refresh(); assert.match(context.controller.getSnapshot().error, /Fictional conflict/); assert.equal(context.controller.getSnapshot().note, 'Fictional unchanged draft.'); await context.controller.save(); assert.equal(context.writes.length, 1);
  context.controller.acknowledgeConflict(); await context.controller.save(); assert.equal(context.writes.length, 2); assert.equal(context.writes[1].expectedRevision, 1); assert.equal(context.writes[1].evidenceVersion, 'b'.repeat(64)); assert.notEqual(context.writes[1].requestId, context.writes[0].requestId); assert.equal(context.controller.getSnapshot().generation, 1); context.controller.stop();
});

test('a generation change after rejection preserves old observations readonly instead of writing them into the new version', async () => {
  let calls = 0; const context = harness({ generation: 1, read: async () => ++calls === 1 ? page() : page({ currentGeneration: 2, evidence: null, writeEligibility: { allowed: false, reason: 'historical_generation' } }), save: async () => { throw new ApiError('Fictional generation changed.', 409); } });
  context.controller.start(); await context.controller.open(); edit(context.controller, 'Fictional version-one draft'); await context.controller.save(); await context.controller.refresh(); context.controller.acknowledgeConflict(); await context.controller.save();
  assert.equal(context.writes.length, 1); assert.equal(context.controller.getSnapshot().generation, 1); assert.equal(context.controller.getSnapshot().note, 'Fictional version-one draft'); assert.deepEqual(context.reads, [1, 1]); assert.equal(context.controller.getSnapshot().page?.evidence, null); context.controller.stop();
});

test('close and unmount abort pending writes; late success and finally cannot clear a new lifetime', async () => {
  const old = deferred<JobOutcomeReviewRecord>(), fresh = deferred<JobOutcomeReviewRecord>(); let calls = 0;
  const context = harness({ save: async () => ++calls === 1 ? old.promise : fresh.promise }); context.controller.start(); await context.controller.open(); edit(context.controller, 'Fictional old note'); const oldSave = context.controller.save(); context.controller.stop(); assert.equal(context.saveSignals[0].aborted, true);
  context.controller.start(); await context.controller.open(); edit(context.controller, 'Fictional new note'); const freshSave = context.controller.save(); old.resolve(saved(context.writes[0])); await oldSave;
  assert.equal(context.controller.getSnapshot().saving, true); assert.equal(context.controller.getSnapshot().note, 'Fictional new note'); assert.equal(context.controller.getSnapshot().saved, null); assert.equal(context.saveSignals[1].aborted, false);
  fresh.resolve(saved(context.writes[1])); await freshSave; assert.equal(context.controller.getSnapshot().saved?.note, 'Fictional new note'); context.controller.stop();
});

test('closing an in-flight save keeps its request ID; reopening only reads to recover a committed record', async () => {
  const reply = deferred<JobOutcomeReviewRecord>(); let committed: JobOutcomeReviewRecord | null = null;
  const context = harness({ read: async () => committed ? page({ latestRevision: 1, records: [committed] }) : page(), save: async (input) => { committed = saved(input); return reply.promise; } });
  context.controller.start(); await context.controller.open(); edit(context.controller); const save = context.controller.save(); context.controller.close(); assert.equal(context.saveSignals[0].aborted, true); assert.equal(context.controller.getSnapshot().phase, 'save_unconfirmed'); await context.controller.open(); assert.equal(context.controller.getSnapshot().phase, 'saved');
  reply.resolve(committed!); await save; assert.equal(context.writes.length, 1); assert.equal(context.controller.getSnapshot().saved?.requestId, requestId); context.controller.stop();
});

test('offline and read failures keep notes but prevent saving stale facts; successful explicit read clears only read errors', async () => {
  let calls = 0; const context = harness({ read: async () => { if (++calls === 2) throw new Error('Fictional read failed'); return page(); } }); context.controller.start(); await context.controller.open(); edit(context.controller);
  await context.controller.refresh(); assert.equal(context.controller.getSnapshot().readCurrent, false); assert.match(context.controller.getSnapshot().error, /不能当作最新/); await context.controller.save(); assert.equal(context.writes.length, 0);
  await context.controller.refresh(); assert.equal(context.controller.getSnapshot().error, ''); assert.equal(context.controller.getSnapshot().note, 'Fictional personally checked record.'); context.state.online = false; await context.controller.refresh(); await context.controller.save(); assert.equal(context.writes.length, 0); context.state.online = true; await context.controller.refresh(); await context.controller.save(); assert.equal(context.writes.length, 1); context.controller.stop();
});

test('known cleanup and unsafe local input cannot be converted into a saved report', async () => {
  const context = harness({ read: async () => page({ evidence: { ...page().evidence!, cleanupPending: true }, writeEligibility: { allowed: false, reason: 'cleanup_pending' } }) }); context.controller.start(); await context.controller.open(); edit(context.controller); await context.controller.save(); assert.equal(context.writes.length, 0); context.controller.stop();
  const invalid = harness({ requestId: () => { throw new Error('Fictional unavailable crypto'); } }); invalid.controller.start(); await invalid.controller.open(); edit(invalid.controller); await invalid.controller.save(); assert.equal(invalid.writes.length, 0); assert.equal(invalid.controller.getSnapshot().pending, null); assert.match(invalid.controller.getSnapshot().error, /未发送/); invalid.controller.stop();
  const malformed = harness(); malformed.controller.start(); await malformed.controller.open(); edit(malformed.controller, '\ud800'); await malformed.controller.save(); assert.equal(malformed.writes.length, 0); assert.equal(malformed.controller.getSnapshot().pending, null); malformed.controller.stop();
});
