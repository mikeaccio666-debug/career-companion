import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { ApiError, type BoundPlatformClient } from '../src/api.ts';
import { CareerInterviewController } from '../src/career-interview-controller.ts';
const owner = randomUUID(), id = randomUUID(), appId = randomUUID(), jobId = randomUUID(), at = '2026-10-08T10:00:00.000Z';
function record(patch: object = {}) { return { id, ownerId: owner, revision: 1, lastOperationId: randomUUID(), createdAt: at, updatedAt: at, source: 'user_recorded',
  application: { id: appId, ownerId: owner, revision: 1, employer: 'Fictional Company', title: 'Fictional Analyst', roleFamily: 'da' },
  roundType: 'sql', startsAt: '2026-11-01T05:30:00.000Z', timeZone: 'America/New_York', durationMin: 60, status: 'scheduled', briefId: null, debrief: null, ...patch }; }
function application(patch: object = {}) { return { id: appId, ownerId: owner, revision: 1, lastOperationId: randomUUID(), createdAt: at, updatedAt: at,
  source: 'user_recorded', job: { id: jobId, ownerId: owner, sourceId: jobId, source: 'manual', state: 'unknown', employer: 'Fictional Company',
    title: 'Fictional Analyst', canonicalUrl: '', roleFamily: 'da', location: '', deadlineAt: null, deadlineTimeZone: null, sponsorship: 'unknown',
    evidenceOverflow: false, ruleRevision: 1, observedAt: at, checkedAt: at, revision: 1, lastOperationId: randomUUID() },
  packetId: null, careWindow: null, stage: 'saved', closedReason: null, closedAtStage: null, offerState: null, submittedVia: null, ...patch }; }
const intent = () => ({ action: 'create' as const, id: null, body: { operationId: randomUUID(), expectedRevision: 0, applicationId: appId, applicationRevision: 1,
  roundType: 'sql', startsAt: '2026-11-01T05:30:00.000Z', timeZone: 'America/New_York', durationMin: 60 } });
function response(body: any, replayed = false) { return { interview: record({ lastOperationId: body.operationId }), operation: { id: body.operationId, interviewId: id, action: 'create', appliedRevision: 1, replayed } }; }
function harness(run: (path: string, init: RequestInit) => unknown, detailId: string | null = null) {
  let active = true; const listeners = new Set<() => void>(), updates: any[] = [];
  const client = { account: { accountId: owner, generation: 1 }, isCurrent: () => active,
    subscribe: (fn: () => void) => { listeners.add(fn); return () => listeners.delete(fn); },
    request: async (path: string, init: RequestInit = {}) => await run(path, init) } as BoundPlatformClient;
  const controller = new CareerInterviewController(client, s => updates.push(s), detailId, { read: 100, write: 20 });
  return { controller, updates, invalidate() { active = false; for (const fn of [...listeners]) fn(); } };
}
async function until(check: () => boolean) { for (let i = 0; i < 200; i++) { if (check()) return; await new Promise(r => setTimeout(r, 2)); } assert(check(), 'requested controller state'); }
const read = (path: string) => path === '/career/applications' ? { applications: [application()], nextAfter: null } : { interviews: [], nextAfter: null };
async function ready(h: ReturnType<typeof harness>) { h.controller.start(); await until(() => h.controller.snapshot().loaded && !h.controller.snapshot().busy); await h.controller.loadApplications(); }
test('create is unavailable without an actually verified owned application and no invented source is posted', async () => {
  let posts = 0;
  const h = harness((path, init) => { if (init.method) { posts++; throw Error('unexpected'); } return read(path); });
  h.controller.start(); await until(() => h.controller.snapshot().loaded);
  h.controller.begin(intent()); assert.equal(posts, 0); assert.match(h.controller.snapshot().error, /投递记录/);
  await h.controller.loadApplications();
  h.controller.begin({ ...intent(), body: { ...intent().body, applicationRevision: 9 } });
  assert.equal(posts, 0); h.controller.stop();
});
test('lost acknowledgement retains the immutable original intent; observer 404 keeps it and same-operation retry has one effect', async () => {
  const posts: string[] = []; let saved: any, effects = 0;
  const h = harness((path, init) => {
    if (path.includes('/operations/')) throw new ApiError('not yet visible', 404, 'NOT_FOUND');
    if (!init.method) return read(path);
    const body = JSON.parse(String(init.body)); posts.push(body.operationId);
    if (saved) return { ...saved, operation: { ...saved.operation, replayed: true } };
    saved = response(body); effects++; throw Error('response lost');
  });
  await ready(h); const original = intent(); h.controller.begin(original); original.body.durationMin = 999;
  await until(() => h.controller.snapshot().uncertain); assert.equal((h.controller.snapshot().pending!.body as any).durationMin, 60);
  await h.controller.observe(); assert(h.controller.snapshot().pending); assert(h.controller.snapshot().uncertain);
  h.controller.begin(intent()); assert.equal(posts.length, 1);
  await h.controller.retry(); assert.equal(effects, 1); assert.deepEqual(posts, [original.body.operationId, original.body.operationId]);
  assert.equal(h.controller.snapshot().records.length, 1); assert.equal(h.controller.snapshot().pending, null); h.controller.stop();
});
test('timeout ignores late success until explicit observation and never fabricates a saved record', async () => {
  let saved: any, resolve!: (v: unknown) => void;
  const h = harness((path, init) => {
    if (path.includes('/operations/')) return { ...saved, operation: { ...saved.operation, replayed: true } };
    if (!init.method) return read(path);
    saved = response(JSON.parse(String(init.body))); return new Promise(r => { resolve = r; });
  });
  await ready(h); h.controller.begin(intent()); await until(() => h.controller.snapshot().uncertain);
  resolve(saved); await new Promise(r => setTimeout(r, 5));
  assert.equal(h.controller.snapshot().records.length, 0); assert(h.controller.snapshot().pending);
  await h.controller.observe(); assert.equal(h.controller.snapshot().records.length, 1); assert(!h.controller.snapshot().uncertain); h.controller.stop();
});
test('bare proxy errors and HTTP request timeouts remain uncertain; structured revision conflicts require fresh reading', async () => {
  for (const failure of [new ApiError('proxy', 400), new ApiError('timeout', 408, 'TIMEOUT')]) {
    const h = harness((p, init) => !init.method ? read(p) : Promise.reject(failure));
    await ready(h); h.controller.begin(intent()); await until(() => h.controller.snapshot().uncertain);
    assert(h.controller.snapshot().pending); h.controller.stop();
  }
  let posts = 0;
  const h = harness((p, init) => { if (!init.method) return read(p); posts++; throw new ApiError('changed', 409, 'CAREER_INTERVIEW_SOURCE_CHANGED'); });
  await ready(h); h.controller.begin(intent()); await until(() => !h.controller.snapshot().busy);
  assert.equal(h.controller.snapshot().pending, null); assert(h.controller.snapshot().needsRefresh);
  h.controller.begin(intent()); assert.equal(posts, 1); await h.controller.refresh(); assert(!h.controller.snapshot().needsRefresh); h.controller.stop();
});
test('account invalidation aborts request and discards schedules, sources and pending operation, fencing late responses', async () => {
  let resolve!: (v: unknown) => void, saved: any, signal: AbortSignal | null = null;
  const h = harness((p, init) => {
    if (!init.method) return read(p);
    saved = response(JSON.parse(String(init.body))); signal = init.signal as AbortSignal;
    return new Promise(r => { resolve = r; });
  });
  await ready(h); h.controller.begin(intent()); await until(() => signal !== null);
  h.invalidate(); assert((signal as unknown as AbortSignal).aborted); resolve(saved); await new Promise(r => setTimeout(r, 5));
  assert.equal(h.controller.snapshot().records.length, 0); assert.equal(h.controller.snapshot().applications.length, 0);
  assert.equal(h.controller.snapshot().detail, null); assert.equal(h.controller.snapshot().pending, null);
  assert.equal(h.controller.snapshot().loaded, false);
});
test('a stopped read cannot clear a restarted generation busy state or repaint its detail', async () => {
  const resolves: Array<(v: unknown) => void> = [];
  const h = harness(() => new Promise(r => resolves.push(r)));
  h.controller.start(); await until(() => resolves.length === 1); h.controller.stop(); h.controller.start();
  await until(() => resolves.length === 2); await new Promise(r => setTimeout(r, 5)); assert(h.controller.snapshot().busy);
  resolves[1]({ interviews: [record()], nextAfter: null }); await until(() => h.controller.snapshot().loaded);
  resolves[0]({ interviews: [], nextAfter: null }); await new Promise(r => setTimeout(r, 5));
  assert.equal(h.controller.snapshot().records.length, 1); h.controller.stop();
});
test('deep-linked detail is actually fetched even outside the first page; a true owned 404 is neutral', async () => {
  const paths: string[] = [];
  const h = harness(path => { paths.push(path); return path.endsWith('/' + id) ? { interview: record() } : { interviews: [], nextAfter: null }; }, id);
  h.controller.start(); await until(() => h.controller.snapshot().loaded);
  assert.deepEqual(paths, ['/career/interviews', '/career/interviews/' + id]); assert.equal(h.controller.snapshot().detail?.id, id);
  assert.equal(h.controller.snapshot().records.length, 0); h.controller.stop();
  const missing = harness(path => { if (path.endsWith('/' + id)) throw new ApiError('missing', 404, 'NOT_FOUND'); return { interviews: [], nextAfter: null }; }, id);
  missing.controller.start(); await until(() => missing.controller.snapshot().loaded); assert(missing.controller.snapshot().detailMissing); missing.controller.stop();
});
test('50-row cursor reads append real records, reject cross-page duplication, and deleting the cursor requires a new page', async () => {
  const page = Array.from({ length: 50 }, () => record({ id: randomUUID() }));
  const cursor = page.at(-1)!.id, final = record({ id: randomUUID() }); let duplicate = false;
  const h = harness((path, init) => {
    if (init.method === 'DELETE') { const body = JSON.parse(String(init.body)); return { interview: null, operation: { id: body.operationId, interviewId: cursor, action: 'delete', appliedRevision: 2, replayed: false } }; }
    if (path.includes('?after=')) return { interviews: [duplicate ? page[0] : final], nextAfter: null };
    return { interviews: page, nextAfter: cursor };
  });
  h.controller.start(); await until(() => h.controller.snapshot().loaded);
  duplicate = true; await h.controller.loadMore(); assert.equal(h.controller.snapshot().records.length, 50); assert.equal(h.controller.snapshot().nextAfter, cursor);
  duplicate = false; await h.controller.loadMore(); assert.equal(h.controller.snapshot().records.length, 51);
  await h.controller.refresh(); h.controller.begin({ action: 'delete', id: cursor, body: { operationId: randomUUID(), expectedRevision: 1 } });
  await until(() => h.controller.snapshot().lastResult !== null);
  assert.equal(h.controller.snapshot().records.length, 49); assert.equal(h.controller.snapshot().nextAfter, null);
  assert(h.controller.snapshot().needsRefresh); await h.controller.refresh(); assert(!h.controller.snapshot().needsRefresh); h.controller.stop();
});
test('read-only refresh while an original write is uncertain cannot clear its nonce or unlock new mutations', async () => {
  const h = harness((p, init) => !init.method ? read(p) : Promise.reject(Error('lost response')));
  await ready(h); const original = intent(); h.controller.begin(original); await until(() => h.controller.snapshot().uncertain);
  await h.controller.refresh(); assert(h.controller.snapshot().uncertain); assert.equal((h.controller.snapshot().pending!.body as any).operationId, original.body.operationId);
  h.controller.stop();
});
