import assert from 'node:assert/strict';
import test from 'node:test';
import type { Job, JobOutcomeReviewPage } from '@companion/platform-contracts';
import { createJobOutcomeReviewClient, parseJobOutcomeReviewPage, parseJobOutcomeReviewSaved, validJobOutcomeReviewNote } from '../src/job-outcome-reviews-api.ts';
import { hasJobOutcomeReviewEntry, jobOutcomeLabels } from '../src/job-outcome-review-labels.ts';
import { deferred, input, jobId, page, record, requestId } from './job-outcome-reviews-fixture.ts';

test('bounded owned facts retain explicit checkpoint scope and receipt version without private execution content', () => {
  const browser = page(); browser.evidence = { ...browser.evidence!, kind: 'browser', browser: { scope: 'task_checkpoint', revision: 3, state: 'uncertain', completedActions: 2, totalActions: 12 } };
  assert.deepEqual(parseJobOutcomeReviewPage(browser, jobId, 1), browser);
  const mcp = page({ requestedGeneration: 2, currentGeneration: 2 }); mcp.evidence = { ...mcp.evidence!, generation: 2, kind: 'mcp', mcp: { generation: 1, status: 'started', hasSavedResult: false } };
  assert.equal(parseJobOutcomeReviewPage(mcp, jobId, 2).evidence?.mcp?.generation, 1);
  for (const field of ['prompt', 'arguments', 'providerTaskId', 'url', 'error', 'artifact']) {
    const bad = structuredClone(browser) as any; bad.evidence[field] = 'Fictional confidential value';
    assert.throws(() => parseJobOutcomeReviewPage(bad, jobId), (error: any) => !error.message.includes('confidential'));
  }
});

test('history never substitutes current facts or another task version, and provenance cannot claim verification', () => {
  const historical = page({ currentGeneration: 2, evidence: null, writeEligibility: { allowed: false, reason: 'historical_generation' }, latestRevision: 1, records: [record()] });
  assert.deepEqual(parseJobOutcomeReviewPage(historical, jobId, 1), historical);
  for (const change of [{ evidence: page().evidence }, { writeEligibility: { allowed: true, reason: null } }, { requestedGeneration: 2 }, { currentGeneration: 0 }, { currentGeneration: '2' }]) assert.throws(() => parseJobOutcomeReviewPage({ ...historical, ...change }, jobId, 1));
  for (const change of [{ verified: true }, { provenance: 'server' }, { generation: 2 }, { jobId: requestId }]) assert.throws(() => parseJobOutcomeReviewPage({ ...historical, records: [{ ...record(), ...change }] }, jobId, 1));
});

test('record, attempt and workflow ordering is checked rather than silently reinterpreted', () => {
  const first = record({ revision: 2 }), second = record({ id: requestId, requestId: jobId, revision: 1 });
  assert.equal(parseJobOutcomeReviewPage(page({ latestRevision: 2, records: [first, second] }), jobId).records.length, 2);
  for (const records of [[second, first], [first, first], [record({ revision: 3 }), second]]) assert.throws(() => parseJobOutcomeReviewPage(page({ latestRevision: 2, records }), jobId));
  const workflow = page(); workflow.evidence = { ...workflow.evidence!, kind: 'workflow', totalAttempts: 2, attempts: [{ attempt: 2, status: 'uncertain', hasProviderTask: false }, { attempt: 1, status: 'failed', hasProviderTask: false }], workflow: { scope: 'task_checkpoint', revision: 0, steps: [{ index: 0, state: 'completed', hasProviderTask: false }, { index: 7, state: 'uncertain', hasProviderTask: false }] } };
  assert.equal(parseJobOutcomeReviewPage(workflow, jobId).evidence?.workflow?.steps.length, 2);
  const reversedAttempts = structuredClone(workflow); reversedAttempts.evidence!.attempts.reverse(); assert.throws(() => parseJobOutcomeReviewPage(reversedAttempts, jobId));
  const reversedSteps = structuredClone(workflow); reversedSteps.evidence!.workflow!.steps.reverse(); assert.throws(() => parseJobOutcomeReviewPage(reversedSteps, jobId));
  for (const value of [2147483648, NaN, 1.5]) assert.throws(() => parseJobOutcomeReviewPage({ ...workflow, latestRevision: value }, jobId));
});

test('largest published history and notes fit the bounded decoder; oversized or malformed input is rejected', () => {
  const notes = '虚'.repeat(2000), records = Array.from({ length: 20 }, (_, n) => record({ id: `64000000-0000-4000-8000-${String(n).padStart(12, '0')}`, requestId: `65000000-0000-4000-8000-${String(n).padStart(12, '0')}`, revision: 30 - n, note: notes }));
  assert.equal(parseJobOutcomeReviewPage(page({ latestRevision: 30, records, hasMore: true }), jobId).records.length, 20);
  for (const note of ['x'.repeat(2001), '\u0000', '\u0001', '\ud800', '\udfff']) assert.equal(validJobOutcomeReviewNote(note), false);
  assert.equal(validJobOutcomeReviewNote('fictional\tline\n😀'), true);
  assert.equal(validJobOutcomeReviewNote('\ufeffFictional pasted note.'), true);
  assert.throws(() => parseJobOutcomeReviewPage({ ...page(), covert: 'x'.repeat(192 * 1024) }, jobId));
  assert.throws(() => parseJobOutcomeReviewPage(page({ latestRevision: 30, records: [...records, record()] }), jobId));
  assert.throws(() => parseJobOutcomeReviewPage(null, jobId));
});

test('save receipts must match the exact request, version, revision, observation and trimmed note', () => {
  assert.equal(parseJobOutcomeReviewSaved({ record: record() }, jobId, input({ note: '  Fictional personally checked record. \n' })).revision, 1);
  assert.equal(parseJobOutcomeReviewSaved({ record: record({ note: undefined }) }, jobId, input({ note: ' \n' })).note, undefined);
  for (const change of [{ requestId: jobId }, { evidenceVersion: 'b'.repeat(64) }, { outcome: 'observed_effect' }, { revision: 2 }, { note: 'Fictional different observation.' }]) assert.throws(() => parseJobOutcomeReviewSaved({ record: { ...record(), ...change } }, jobId, input()));
});

test('the port only reads the owned exact version and saves an observation; bad IDs and extra fields send nothing', async () => {
  const requests: { path: string; init?: RequestInit }[] = [];
  const api = createJobOutcomeReviewClient(async <T>(path: string, init?: RequestInit) => { requests.push({ path, init }); return (init?.method === 'POST' ? { record: record() } : page()) as T; });
  await api.read(jobId); await api.read(jobId, 1); await api.save(jobId, input());
  assert.deepEqual(requests.map((r) => r.path), [`/jobs/${jobId}/outcome-review`, `/jobs/${jobId}/outcome-review?generation=1`, `/jobs/${jobId}/outcome-reviews`]);
  assert.deepEqual(JSON.parse(requests[2].init?.body as string), input());
  for (const badId of [jobId.toUpperCase().replace('61000000', 'ABCDEF00'), '/jobs/other', 'fictional-not-a-uuid']) await assert.rejects(api.read(badId));
  await assert.rejects(api.save(jobId, { ...input(), retry: true } as any));
  await assert.rejects(api.save(jobId, input({ note: '\ud800' })));
  assert.equal(requests.length, 3);
});

test('aborted reads and saves discard successful late transport bodies', async () => {
  const response = deferred<unknown>(); let requests = 0;
  const api = createJobOutcomeReviewClient(async <T>() => { ++requests; return await response.promise as T; });
  const cancelled = new AbortController(); cancelled.abort(); await assert.rejects(api.read(jobId, 1, cancelled.signal)); assert.equal(requests, 0);
  const abort = new AbortController(), result = api.read(jobId, 1, abort.signal); abort.abort(); response.resolve(page()); await assert.rejects(result);
  const saved = deferred<unknown>(), saveApi = createJobOutcomeReviewClient(async <T>() => await saved.promise as T), saveAbort = new AbortController();
  const saveResult = saveApi.save(jobId, input(), saveAbort.signal); saveAbort.abort(); saved.resolve({ record: record() }); await assert.rejects(saveResult);
});

test('entries expose unknown and blocked safety cases, never running or ordinary failures as unknown success', () => {
  const job: Job = { id: jobId, kind: 'image', provider: 'fictional', prompt: 'Fictional task.', status: 'uncertain', attempt: 1, progress: 0, artifacts: [], createdAt: '', updatedAt: '' };
  assert.equal(hasJobOutcomeReviewEntry(job), true);
  assert.equal(hasJobOutcomeReviewEntry({ ...job, status: 'running' }), false);
  assert.equal(hasJobOutcomeReviewEntry({ ...job, status: 'failed' }), false);
  assert.equal(hasJobOutcomeReviewEntry({ ...job, kind: 'cli', status: 'failed', error: { code: 'CLI_CLEANUP_UNCONFIRMED', message: 'Fictional public safety error.' } }), true);
  assert.equal(hasJobOutcomeReviewEntry({ ...job, kind: 'browser', status: 'failed', options: { actions: [{ type: 'click' }] } }), true);
  assert.equal(hasJobOutcomeReviewEntry({ ...job, kind: 'workflow', status: 'failed' }), true);
  assert.equal(hasJobOutcomeReviewEntry({ ...job, kind: 'mcp', status: 'cancelled' }), true);
  assert.equal(jobOutcomeLabels.observed_effect, '在外部系统看到了结果');
});
