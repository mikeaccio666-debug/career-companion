import assert from 'node:assert/strict';
import test from 'node:test';
import { COMPANION_INK_TOKENS, PLATFORM_ACCOUNT_HEADER, type CompanionDraftEntryState } from '@companion/platform-contracts';
import { createPlatformClient } from '../src/api.ts';
import { AccountRequestContext } from '../src/account-context.ts';
import { createPlatformEndpoints } from '../src/platform-endpoints.ts';
import { acceptCompanionDraft, CompanionPreviewObserver, parseCompanionDraftEntry, readCompanionDraftEntry,
  type CompanionPreviewObservation, type CompanionPreviewObserverEnvironment } from '../src/companion-preview-api.ts';

const id = (number: number) => `11000000-0000-4000-8000-${number.toString(16).padStart(12, '0')}`;
const accountA = id(1), accountB = id(2), taskId = id(3), companionId = id(4), operationId = id(5);
const ready = { kind: 'not_prepared' as const, intakeRevision: 7, generationAvailable: true };
const task = (status: 'pending' | 'running' | 'failed' | 'interrupted' | 'uncertain'): CompanionDraftEntryState =>
  ({ kind: 'generation', taskId, companionId, generation: status === 'pending' ? 0 : 1, status, hold: null });
const completed: CompanionDraftEntryState = { kind: 'preview', preview: { taskId, companionId, revision: 1,
  generatedBy: 'model', summary: 'Fictional calm, clear style.', samples: ['Fictional first sample.', 'Fictional second sample.', 'Fictional third sample.'], inkToken: 'yanzhi' } };
const endpoints = createPlatformEndpoints('https://api.example.invalid');
const flush = async () => { for (let i = 0; i < 12; i++) await new Promise<void>(done => setImmediate(done)); };
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
function scope() { const context = new AccountRequestContext(); context.changeSession(accountA); return context; }
function observationHarness(transport: (path: string, init?: RequestInit) => Promise<Response>, revision = 7) {
  const context = scope(), requests: { path: string; method: string; body: unknown; signal: AbortSignal }[] = [], observed: CompanionPreviewObservation[] = [];
  const client = createPlatformClient(endpoints, async (url, init) => {
    const path = new URL(String(url)).pathname.replace('/api/platform', '');
    assert.equal(new Headers(init?.headers).get(PLATFORM_ACCOUNT_HEADER), accountA);
    assert.equal(init?.credentials, 'include'); assert.equal(init?.redirect, 'error');
    requests.push({ path, method: init?.method ?? 'GET', body: init?.body ? JSON.parse(String(init.body)) : null, signal: init!.signal! });
    return transport(path, init);
  }, context).capture();
  let at = 0, nextTimer = 0, operationIds = 0, visible = true, online = true;
  const timers = new Map<number, { at: number; run: () => void }>();
  const environment: CompanionPreviewObserverEnvironment = {
    now: () => at, isVisible: () => visible, isOnline: () => online, operationId: () => { operationIds++; return operationId; },
    setTimer(run, delay) { const token = ++nextTimer; timers.set(token, { at: at + delay, run }); return token; },
    clearTimer(timer) { timers.delete(timer as number); },
  };
  const observer = new CompanionPreviewObserver(client, revision, state => observed.push(state), environment);
  return { observer, context, requests, observed, timers, operationIds: () => operationIds, latest: () => observed.at(-1)!,
    visibility(value: boolean) { visible = value; observer.resume(); }, online(value: boolean) { online = value; observer.resume(); },
    async advance(delay: number) {
      const target = at + delay;
      while (true) {
        const next = [...timers.entries()].filter(([, timer]) => timer.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break; at = next[1].at; timers.delete(next[0]); next[1].run(); await flush();
      }
      at = target; await flush();
    } };
}

test('closed public preview accepts the seven real inks and detaches exactly three saved samples', () => {
  for (const inkToken of COMPANION_INK_TOKENS) {
    const input = { ...completed, preview: { ...completed.preview, inkToken } }, result = parseCompanionDraftEntry(input);
    assert.deepEqual(result, input); assert.equal(result.kind, 'preview');
    if (result.kind !== 'preview') throw new Error('Expected saved preview.');
    assert.notEqual(result.preview.samples, input.preview.samples); assert.equal(Object.isFrozen(result.preview.samples), true);
    assert.equal(Object.isFrozen(result.preview), true);
  }
  for (const value of [{ ...completed, name: 'Fictional name' }, { kind: 'active', preview: completed.preview },
    { ...completed, preview: { ...completed.preview, styleCard: { warmth: 1 } } }, { ...completed, preview: { ...completed.preview, leaseToken: id(9) } },
    { ...completed, preview: { ...completed.preview, inkToken: 'guide' } }, { ...completed, preview: { ...completed.preview, revision: 2 } },
    { ...completed, preview: { ...completed.preview, generatedBy: 'cached_template' } }, { ...completed, preview: { ...completed.preview, samples: ['One', 'Two'] } },
    { ...completed, preview: { ...completed.preview, samples: ['One', 'Two', 'Three', 'Four'] } },
    { ...completed, preview: { ...completed.preview, summary: '\u202eFictional misleading display' } },
    { ...completed, preview: { ...completed.preview, summary: '😀'.repeat(5000) } }]) assert.throws(() => parseCompanionDraftEntry(value));
});

test('public generation progress rejects fabricated completion, extra authorization and executable accessors', () => {
  for (const status of ['pending', 'running', 'failed', 'interrupted', 'uncertain'] as const) assert.deepEqual(parseCompanionDraftEntry(task(status)), task(status));
  for (const hold of [null, 'authorization_required', 'configuration_unavailable', 'requires_review']) assert.deepEqual(parseCompanionDraftEntry({ ...task('pending'), hold }), { ...task('pending'), hold });
  for (const value of [{ ...task('running'), generation: 0 }, { ...task('running'), status: 'completed' }, { ...task('pending'), generation: -1 },
    { ...task('pending'), hold: 'reauthorized' }, { ...task('pending'), hold: undefined },
    { ...task('pending'), taskId: accountA + '\n' }, { ...ready, generationAvailable: 'true' }, { ...ready, intakeRevision: 0 },
    { ...ready, authVersion: 3 }, { kind: 'intake_required', provider: 'openai' }, new Date()]) assert.throws(() => parseCompanionDraftEntry(value));
  let calls = 0;
  const discriminator = Object.defineProperty({}, 'kind', { enumerable: true, get() { calls++; return 'intake_required'; } });
  const privateAccessor = Object.defineProperty({ ...completed.preview }, 'summary', { enumerable: true, get() { calls++; return 'Fictional'; } });
  const samples = ['One', 'Two', 'Three']; Object.defineProperty(samples, '1', { enumerable: true, get() { calls++; return 'Fictional'; } });
  for (const value of [discriminator, { kind: 'preview', preview: privateAccessor }, { kind: 'preview', preview: { ...completed.preview, samples } },
    { ...ready, [Symbol('extra')]: true }]) assert.throws(() => parseCompanionDraftEntry(value));
  assert.equal(calls, 0);
});

test('captured client binds GET and durable POST to the real account and verifies the exact operation receipt', async () => {
  const context = scope(), requests: { path: string; method: string; body: unknown }[] = [];
  const client = createPlatformClient(endpoints, async (url, init) => {
    const path = new URL(String(url)).pathname.replace('/api/platform', '');
    assert.equal(new Headers(init?.headers).get(PLATFORM_ACCOUNT_HEADER), accountA);
    assert.equal(init?.credentials, 'include'); assert.equal(init?.redirect, 'error');
    requests.push({ path, method: init?.method ?? 'GET', body: init?.body ? JSON.parse(String(init.body)) : null });
    return Response.json(init?.method === 'POST' ? { entry: task('pending'), operation: { id: operationId, replayed: false } } : { entry: ready }, { status: init?.method === 'POST' ? 202 : 200 });
  }, context).capture();
  assert.deepEqual(await readCompanionDraftEntry(client), ready);
  assert.deepEqual(await acceptCompanionDraft(client, { operationId, expectedRevision: 7 }), { entry: task('pending'), operation: { id: operationId, replayed: false } });
  assert.deepEqual(requests, [{ path: '/companion/drafts/current', method: 'GET', body: null }, { path: '/companion/drafts', method: 'POST', body: { operationId, expectedRevision: 7 } }]);
  for (const response of [{ entry: task('pending'), operation: { id: id(99), replayed: false } }, { entry: ready, operation: { id: operationId, replayed: false } },
    { entry: completed, operation: { id: operationId, replayed: false, sessionHash: 'Fictional private hash' } }]) {
    const malformed = createPlatformClient(endpoints, async () => Response.json(response), scope()).capture();
    await assert.rejects(acceptCompanionDraft(malformed, { operationId, expectedRevision: 7 }));
  }
  context.changeSession(accountB); await assert.rejects(readCompanionDraftEntry(client), { name: 'AbortError' });
  await assert.rejects(acceptCompanionDraft(client, { operationId, expectedRevision: 7 }), { name: 'AbortError' }); assert.equal(requests.length, 2);
});

test('pre-aborted requests and unclosed generation commands never dispatch', async () => {
  let requests = 0;
  const client = createPlatformClient(endpoints, async () => { requests++; return Response.json({ entry: ready }); }, scope()).capture();
  const abort = new AbortController(); abort.abort();
  await assert.rejects(readCompanionDraftEntry(client, abort.signal), { name: 'AbortError' });
  await assert.rejects(acceptCompanionDraft(client, { operationId, expectedRevision: 7 }, abort.signal), { name: 'AbortError' });
  for (const command of [{ operationId, expectedRevision: 7, model: 'client-selected-model' }, { operationId, expectedRevision: 0 }, { operationId: 'wrong', expectedRevision: 7 }]) await assert.rejects(acceptCompanionDraft(client, command));
  assert.equal(requests, 0);
});

test('real observed pending and running states poll into the stored preview with exactly one accepted intent', async () => {
  let reads = 0;
  const harness = observationHarness(async (_, init) => Response.json(init?.method === 'POST'
    ? { entry: task('pending'), operation: { id: operationId, replayed: false } } : { entry: [ready, task('running'), completed][reads++] }));
  harness.observer.start(); await flush(); assert.deepEqual(harness.latest().entry, task('pending')); assert.equal(harness.latest().checking, false);
  assert.equal(harness.operationIds(), 1); assert.equal(harness.requests.length, 2);
  await harness.advance(3_000); assert.deepEqual(harness.latest().entry, task('running'));
  await harness.advance(3_000); assert.deepEqual(harness.latest().entry, completed); assert.equal(harness.timers.size, 0);
  await harness.advance(60_000); assert.equal(harness.requests.length, 4); assert.equal(harness.requests.filter(row => row.method === 'POST').length, 1);
  assert.ok(harness.observed.filter(row => row.entry?.kind === 'preview').every(row => row.entry === completed || JSON.stringify(row.entry) === JSON.stringify(completed)));
  harness.observer.stop();
});

test('lost acceptance confirmation is reconciled with GET and never starts a second paid intent', async () => {
  let accepted = false;
  const harness = observationHarness(async (_, init) => {
    if (init?.method === 'POST') { accepted = true; throw new TypeError('Fictional connection lost after server commit.'); }
    return Response.json({ entry: accepted ? task('running') : ready });
  });
  harness.observer.start(); await flush();
  assert.deepEqual(harness.latest().entry, task('running')); assert.equal(harness.latest().error, '');
  assert.deepEqual(harness.requests.map(row => row.method), ['GET', 'POST', 'GET']);
  harness.observer.refresh(); await flush(); assert.equal(harness.requests.filter(row => row.method === 'POST').length, 1);
  assert.equal(harness.operationIds(), 1); harness.observer.stop();
});

test('an unconfirmed acceptance preserves its original intent and offers only subsequent reads', async () => {
  const harness = observationHarness(async (_, init) => {
    if (init?.method === 'POST') throw new TypeError('Fictional unavailable acceptance.');
    return Response.json({ entry: ready });
  });
  harness.observer.start(); await flush(); assert.equal(harness.latest().entry?.kind, 'not_prepared'); assert.match(harness.latest().error, /没有确认完成/);
  harness.observer.refresh(); await flush(); harness.observer.stop(); harness.observer.start(); await flush();
  assert.equal(harness.requests.filter(row => row.method === 'POST').length, 1); assert.equal(harness.operationIds(), 1);
  assert.equal(harness.timers.size, 0); harness.observer.stop();
});

test('disabled generation and mismatched intake revisions cannot create model intent, while a fresh available read may start once', async () => {
  let available = false;
  const disabled = observationHarness(async (_, init) => Response.json(init?.method === 'POST' ? { entry: task('pending'), operation: { id: operationId, replayed: false } } : { entry: { ...ready, generationAvailable: available } }));
  disabled.observer.start(); await flush(); assert.equal(disabled.requests.length, 1); assert.equal(disabled.operationIds(), 0); assert.equal(disabled.timers.size, 0);
  available = true; disabled.observer.refresh(); await flush(); assert.equal(disabled.requests.filter(row => row.method === 'POST').length, 1); disabled.observer.stop();
  const changed = observationHarness(async () => Response.json({ entry: { ...ready, intakeRevision: 8 } }));
  changed.observer.start(); await flush(); assert.match(changed.latest().error, /进度已更新/); assert.equal(changed.operationIds(), 0); assert.equal(changed.requests.length, 1); changed.observer.stop();
});

test('failed, interrupted and uncertain execution never auto-polls into another generation or POSTs a retry', async () => {
  for (const status of ['failed', 'interrupted', 'uncertain'] as const) {
    const harness = observationHarness(async () => Response.json({ entry: task(status) }));
    harness.observer.start(); await flush(); assert.deepEqual(harness.latest().entry, task(status));
    await harness.advance(60_000); assert.equal(harness.requests.length, 1); assert.equal(harness.timers.size, 0);
    harness.observer.refresh(); await flush(); assert.equal(harness.requests.length, 2); assert.equal(harness.operationIds(), 0);
    assert.ok(harness.requests.every(row => row.method === 'GET')); harness.observer.stop();
  }
});

test('persisted holds preserve actual generation zero and stop periodic polling without granting a retry', async () => {
  for (const hold of ['authorization_required', 'configuration_unavailable', 'requires_review'] as const) {
    const held = { ...task('pending'), hold };
    const harness = observationHarness(async () => Response.json({ entry: held }));
    harness.observer.start(); await flush(); assert.deepEqual(harness.latest().entry, held);
    await harness.advance(60_000); assert.equal(harness.requests.length, 1); assert.equal(harness.timers.size, 0);
    harness.observer.refresh(); await flush(); assert.equal(harness.requests.length, 2); assert.equal(harness.operationIds(), 0);
    assert.ok(harness.requests.every(row => row.method === 'GET')); harness.observer.stop();
  }
});

test('a newly observed hold cancels periodic pending observation; an explicit read can recover the saved result', async () => {
  let reads = 0;
  const states = [task('pending'), { ...task('pending'), hold: 'configuration_unavailable' }, completed];
  const harness = observationHarness(async () => Response.json({ entry: states[reads++] }));
  harness.observer.start(); await flush(); assert.equal(harness.timers.size, 1);
  await harness.advance(3_000); assert.deepEqual(harness.latest().entry, states[1]); assert.equal(harness.timers.size, 0);
  await harness.advance(60_000); assert.equal(harness.requests.length, 2);
  harness.observer.refresh(); await flush(); assert.deepEqual(harness.latest().entry, completed);
  assert.equal(harness.requests.length, 3); assert.equal(harness.operationIds(), 0); harness.observer.stop();
});

test('a held task does not resume automatic polling when an explicit refresh is throttled', async () => {
  const held = { ...task('pending'), hold: 'authorization_required' }; let reads = 0;
  const harness = observationHarness(async () => ++reads === 2
    ? Response.json({ error: { code: 'RATE_LIMITED', message: 'Fictional held-task throttle.' } }, { status: 429 })
    : Response.json({ entry: reads === 1 ? held : completed }));
  harness.observer.start(); await flush(); harness.observer.refresh(); await flush();
  assert.deepEqual(harness.latest().entry, held); assert.match(harness.latest().error, /可以重新读取/); assert.equal(harness.timers.size, 0);
  await harness.advance(60_000); assert.equal(harness.requests.length, 2);
  harness.observer.refresh(); await flush(); assert.deepEqual(harness.latest().entry, completed);
  assert.equal(harness.requests.length, 3); assert.equal(harness.operationIds(), 0); harness.observer.stop();
});

test('StrictMode stop/start cannot publish the first late response, clear the next request or leave a busy latch', async () => {
  const former = deferred<Response>(), current = deferred<Response>(); let calls = 0;
  const harness = observationHarness(async () => ++calls === 1 ? former.promise : current.promise);
  harness.observer.start(); await flush(); harness.observer.stop(); assert.equal(harness.requests[0].signal.aborted, true);
  harness.observer.start(); await flush(); assert.equal(harness.requests.length, 2); assert.equal(harness.latest().checking, true);
  former.resolve(Response.json({ entry: completed })); await flush(); assert.equal(harness.latest().checking, true); assert.equal(harness.latest().entry, null);
  current.resolve(Response.json({ entry: { ...ready, generationAvailable: false } })); await flush(); assert.equal(harness.latest().checking, false); assert.equal(harness.latest().entry?.kind, 'not_prepared');
  harness.observer.refresh(); await flush(); assert.equal(harness.requests.length, 3); assert.equal(harness.latest().checking, false); harness.observer.stop();
});

test('stopping observation after dispatch neither sends cancellation nor replays acceptance on remount', async () => {
  const reply = deferred<Response>(); let accepted = false;
  const harness = observationHarness(async (_, init) => {
    if (init?.method === 'POST') { accepted = true; return reply.promise; }
    return Response.json({ entry: accepted ? task('running') : ready });
  });
  harness.observer.start(); await flush(); assert.equal(harness.requests.length, 2);
  harness.observer.stop(); assert.equal(harness.requests[1].signal.aborted, true); harness.observer.start(); await flush();
  reply.resolve(Response.json({ entry: task('pending'), operation: { id: operationId, replayed: false } })); await flush();
  assert.deepEqual(harness.latest().entry, task('running')); assert.equal(harness.requests.filter(row => row.method === 'POST').length, 1);
  assert.ok(harness.requests.every(row => !/cancel/.test(row.path))); harness.observer.stop();
});

test('different-account and same-account new-session invalidation synchronously hides results and suppresses old timers and late responses', async () => {
  for (const next of [accountA, accountB]) {
    const response = deferred<Response>();
    const harness = observationHarness(async () => response.promise);
    harness.observer.start(); await flush(); harness.context.changeSession(next);
    assert.equal(harness.requests[0].signal.aborted, true); assert.equal(harness.latest().entry, null); assert.equal(harness.latest().checking, false);
    response.resolve(Response.json({ entry: completed })); await flush(); await harness.advance(60_000);
    assert.equal(harness.latest().entry, null); assert.equal(harness.requests.length, 1); assert.equal(harness.timers.size, 0);
  }
  const saved = observationHarness(async () => Response.json({ entry: completed })); saved.observer.start(); await flush(); assert.equal(saved.latest().entry?.kind, 'preview');
  saved.context.changeSession(accountB); assert.equal(saved.latest().entry, null); assert.equal(saved.latest().error, '');
});

test('hidden or offline observation stops reads and becoming visible or online resumes actual task state', async () => {
  const harness = observationHarness(async () => Response.json({ entry: task('pending') }));
  harness.observer.start(); await flush(); harness.visibility(false); await harness.advance(60_000); assert.equal(harness.requests.length, 1);
  harness.visibility(true); await flush(); assert.equal(harness.requests.length, 2);
  harness.online(false); await harness.advance(60_000); assert.equal(harness.requests.length, 2);
  harness.online(true); await flush(); assert.equal(harness.requests.length, 3); harness.observer.stop();
  const fresh = observationHarness(async () => Response.json({ entry: completed })); fresh.online(false); fresh.observer.start(); await flush(); assert.equal(fresh.requests.length, 0);
  fresh.online(true); await flush(); assert.equal(fresh.latest().entry?.kind, 'preview'); fresh.observer.stop();
});

test('throttle deadlines also apply to manual refresh and long server delays are observed in bounded segments', async () => {
  for (const delay of [undefined, 90_000, 2 * 24 * 60 * 60_000 + 5_000]) {
    let calls = 0;
    const harness = observationHarness(async () => ++calls === 1 ? Response.json({ error: { code: 'RATE_LIMITED', message: 'Fictional throttled.' } }, { status: 429, headers: delay === undefined ? {} : { 'Retry-After': String(delay / 1000) } }) : Response.json({ entry: completed }));
    harness.observer.start(); await flush(); assert.match(harness.latest().error, /太频繁/);
    harness.observer.refresh(); await flush(); assert.equal(harness.requests.length, 1);
    const expected = delay ?? 60_000; await harness.advance(expected - 1); assert.equal(harness.requests.length, 1);
    await harness.advance(1); assert.equal(harness.requests.length, 2); assert.equal(harness.latest().entry?.kind, 'preview'); harness.observer.stop();
  }
});

test('a throttle after POST acceptance waits before reconciling and never dispatches a second intent', async () => {
  let accepted = false;
  const harness = observationHarness(async (_, init) => {
    if (init?.method === 'POST') { accepted = true; return Response.json({ error: { code: 'RATE_LIMITED', message: 'Fictional late throttle.' } }, { status: 429, headers: { 'Retry-After': '90' } }); }
    return Response.json({ entry: accepted ? completed : ready });
  });
  harness.observer.start(); await flush(); assert.equal(harness.requests.length, 2);
  harness.visibility(false); harness.visibility(true); await flush(); assert.equal(harness.requests.length, 2);
  await harness.advance(89_999); assert.equal(harness.requests.length, 2);
  await harness.advance(1); assert.equal(harness.latest().entry?.kind, 'preview'); assert.equal(harness.requests.length, 3);
  assert.equal(harness.requests.filter(row => row.method === 'POST').length, 1); harness.observer.stop();
});
