import assert from 'node:assert/strict';
import test from 'node:test';
import { PLATFORM_ACCOUNT_HEADER, type CompanionNamingAccepted, type CompanionNamingProgress, type CompanionNamingState } from '@companion/platform-contracts';
import { AccountRequestContext } from '../src/account-context.ts';
import { createPlatformClient } from '../src/api.ts';
import { createPlatformEndpoints } from '../src/platform-endpoints.ts';
import { CompanionNamingController, type CompanionNamingEnvironment, type CompanionNamingObservation } from '../src/companion-naming-controller.ts';

const id = (n: number) => `23000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const accountA = id(1), accountB = id(2), taskId = id(3), companionId = id(4), dispatchId = id(5), submissionId = id(6);
const input = { taskId, expectedEntryRevision: 0, expectedIdentityRevision: 0, name: '  Sensitive fictional input\n第二行  ' };
const endpoints = createPlatformEndpoints('https://api.example.invalid');
const flush = async () => { for (let i = 0; i < 12; i++) await new Promise<void>(done => setImmediate(done)); };
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
function acceptance(operationId: string, phase: 'queued' | 'detected' | 'held' = 'queued'): CompanionNamingAccepted {
  const progress: CompanionNamingProgress = { dispatchId, taskId, submissionId, submittedRevision: 1, phase,
    hold: phase === 'held' ? 'requires_review' : null,
    detection: phase === 'detected' ? { status: 'detected', generation: 1, level: 'L0', mode: 'full' }
      : { status: 'pending', generation: phase === 'held' ? 1 : 0, level: null, mode: null },
    application: phase === 'detected' ? { status: 'applied', rejectedCategory: null, identityRevision: 1 }
      : { status: 'pending', rejectedCategory: null, identityRevision: null }, resource: phase === 'detected' ? 'not_required' : 'not_determined' };
  return { acceptance: { dispatchId, taskId, submissionId, operation: { id: operationId, appliedRevision: 1, replayed: false } }, progress };
}
function current(accepted: CompanionNamingAccepted): CompanionNamingState {
  return { kind: 'naming', entry: { taskId: accepted.progress.taskId, companionId,
    revision: accepted.progress.submittedRevision, latestSubmissionId: accepted.progress.submissionId }, latest: accepted.progress };
}
function harness(transport: (path: string, init?: RequestInit) => Promise<Response>) {
  const context = new AccountRequestContext(); context.changeSession(accountA);
  const observed: CompanionNamingObservation[] = [], requests: { path: string; method: string; body: any; signal: AbortSignal }[] = [];
  const client = createPlatformClient(endpoints, async (url, init) => {
    assert.equal(new Headers(init?.headers).get(PLATFORM_ACCOUNT_HEADER), accountA);
    assert.equal(init?.credentials, 'include'); assert.equal(init?.redirect, 'error');
    const path = new URL(String(url)).pathname.replace('/api/platform', '');
    requests.push({ path, method: init?.method ?? 'GET', body: init?.body ? JSON.parse(String(init.body)) : null, signal: init!.signal! });
    return transport(path, init);
  }, context).capture();
  let at = 0, sequence = 0, operations = 0, visible = true, online = true;
  const timers = new Map<number, { at: number; run: () => void }>();
  const environment: CompanionNamingEnvironment = {
    now: () => at, isVisible: () => visible, isOnline: () => online, operationId: () => id(100 + ++operations),
    setTimer(run, delay) { const token = ++sequence; timers.set(token, { at: at + delay, run }); return token; },
    clearTimer(timer) { timers.delete(timer as number); },
  };
  const controller = new CompanionNamingController(client, value => observed.push(value), environment);
  return { controller, context, requests, observed, timers, operations: () => operations, latest: () => observed.at(-1)!,
    visible(value: boolean) { visible = value; controller.resume(); }, online(value: boolean) { online = value; controller.resume(); },
    async advance(delay: number) {
      const target = at + delay;
      while (true) {
        const next = [...timers.entries()].filter(([, timer]) => timer.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        at = next[1].at; timers.delete(next[0]); next[1].run(); await flush();
      }
      at = target; await flush();
    } };
}

test('mount, StrictMode restart, visibility and connectivity only observe naming and never submit a name', async () => {
  const h = harness(async () => Response.json({ state: { kind: 'not_started' } }));
  h.controller.start(); h.controller.start(); await flush();
  h.controller.stop(); h.controller.start(); await flush();
  h.visible(false); h.online(false); await flush(); const before = h.requests.length;
  h.visible(true); await flush(); assert.equal(h.requests.length, before);
  h.online(true); await flush(); h.controller.refresh(); await flush();
  assert(h.requests.every(value => value.method === 'GET' && value.path === '/companion/naming'));
  assert.equal(h.operations(), 0); assert.equal(h.latest().acceptance, 'idle'); assert.equal(h.timers.size, 0);
  h.controller.stop();
});

test('one explicit submit snapshots raw input and polls actual phases without a second intent', async () => {
  let saved: CompanionNamingAccepted | null = null;
  const h = harness(async (path, init) => {
    if (init?.method === 'POST') { saved = acceptance(JSON.parse(String(init.body)).operationId); return Response.json(saved, { status: 202 }); }
    return Response.json(path === '/companion/naming' ? { state: saved ? current(saved) : { kind: 'not_started' } } : { accepted: saved });
  });
  h.controller.start(); await flush();
  const mutable = { ...input }; assert.equal(h.controller.submit(mutable), true);
  mutable.name = 'Changed fictional input'; assert.equal(h.controller.submit(input), false); await flush();
  assert.equal(h.operations(), 1); assert.equal(h.latest().acceptance, 'saved');
  assert.equal(h.requests.find(value => value.method === 'POST')!.body.name, input.name);
  assert.equal(h.requests.filter(value => value.method === 'POST').length, 1);
  saved = acceptance(id(101), 'detected'); await h.advance(3_000);
  assert.equal(h.latest().accepted?.progress.application.status, 'applied'); assert.equal(h.timers.size, 0);
  await h.advance(60_000); assert.equal(h.requests.filter(value => value.method === 'POST').length, 1);
  assert(h.observed.every(value => !JSON.stringify(value).includes('Sensitive fictional')));
  h.controller.stop();
});

test('lost202 uses its own operation even when another device has already moved the current head', async () => {
  let saved: CompanionNamingAccepted | null = null;
  const newer = acceptance(id(111));
  const other: CompanionNamingState = { kind: 'naming', entry: { taskId, companionId, revision: 2, latestSubmissionId: id(33) },
    latest: { ...newer.progress, dispatchId: id(34), submissionId: id(33), submittedRevision: 2 } };
  const h = harness(async (path, init) => {
    if (init?.method === 'POST') { saved = acceptance(JSON.parse(String(init.body)).operationId); throw new TypeError('Fictional response lost after commit'); }
    return Response.json(path === '/companion/naming' ? { state: saved ? other : { kind: 'not_started' } } : { accepted: saved });
  });
  h.controller.start(); await flush(); h.controller.submit(input); await flush();
  assert.equal(h.latest().acceptance, 'saved'); assert.equal(h.latest().accepted?.acceptance.operation.id, id(101));
  assert.equal(h.latest().state?.kind, 'naming'); assert.deepEqual(h.latest().state, other);
  const firstPost = h.requests.findIndex(value => value.method === 'POST');
  assert.equal(h.requests[firstPost + 1].path, '/companion/naming/submissions/' + id(101));
  h.controller.refresh(); await flush(); assert.equal(h.operations(), 1);
  assert.equal(h.requests.filter(value => value.method === 'POST').length, 1); h.controller.stop();
});

test('an absent own-operation observation retains uncertainty through restart and never automatically resubmits', async () => {
  let confirmed = false;
  const h = harness(async (path, init) => {
    if (init?.method === 'POST') throw new TypeError('Fictional ambiguous transport');
    return Response.json(path === '/companion/naming' ? { state: { kind: 'not_started' } }
      : { accepted: confirmed ? acceptance(id(101)) : null });
  });
  h.controller.start(); await flush(); h.controller.submit(input); await flush();
  assert.equal(h.latest().acceptance, 'unknown'); assert.equal(h.controller.submit(input), false);
  h.controller.stop(); h.controller.start(); await flush();
  assert.equal(h.latest().acceptance, 'unknown'); assert.equal(h.operations(), 1);
  confirmed = true; await h.advance(3_000); assert.equal(h.latest().acceptance, 'saved');
  assert.equal(h.requests.filter(value => value.method === 'POST').length, 1); h.controller.stop();
});

test('a retained original intent is unknown immediately on restart while its own read is delayed, fails or is throttled', async () => {
  for (const mode of ['delayed', 'failure', 'quota'] as const) {
    let restarting = false;
    const pending = deferred<Response>();
    const later = acceptance(id(111), 'detected');
    const newer: CompanionNamingState = { kind: 'naming', entry: { taskId, companionId, revision: 2, latestSubmissionId: id(33) },
      latest: { ...later.progress, dispatchId: id(34), submissionId: id(33), submittedRevision: 2 } };
    const h = harness(async (path, init) => {
      if (init?.method === 'POST') throw new TypeError('Fictional original acceptance response lost');
      if (path === '/companion/naming') return Response.json({ state: newer });
      if (!restarting) return Response.json({ accepted: null });
      if (mode === 'delayed') return pending.promise;
      if (mode === 'failure') throw new TypeError('Fictional original operation temporarily unreadable');
      return Response.json({ error: { code: 'RATE_LIMITED', message: 'Fictional observer quota' } }, { status: 429 });
    });
    h.controller.start(); await flush(); assert(h.controller.submit(input)); await flush();
    assert.equal(h.latest().acceptance, 'unknown'); h.controller.stop(); restarting = true;
    h.controller.start(); assert.equal(h.latest().acceptance, 'unknown'); assert.equal(h.latest().accepted, null);
    await flush(); assert.equal(h.latest().acceptance, 'unknown'); assert.equal(h.controller.submit(input), false);
    if (mode === 'delayed') { pending.resolve(Response.json({ accepted: null })); await flush(); assert.deepEqual(h.latest().state, newer); }
    assert.equal(h.latest().acceptance, 'unknown'); assert.equal(h.latest().accepted, null);
    assert.equal(h.operations(), 1); assert.equal(h.requests.filter(value => value.method === 'POST').length, 1);
    assert(h.requests.filter(value => value.path.startsWith('/companion/naming/submissions/')).every(value => value.path.endsWith(id(101))));
    h.controller.stop();
  }
});

test('stopping transport clears local observation while a later start reads the original accepted submission', async () => {
  const pending = deferred<Response>(); let saved = false;
  const h = harness(async (path, init) => {
    if (init?.method === 'POST') { saved = true; return pending.promise; }
    return Response.json(path === '/companion/naming' ? { state: saved ? current(acceptance(id(101))) : { kind: 'not_started' } }
      : { accepted: saved ? acceptance(id(101)) : null });
  });
  h.controller.start(); await flush(); h.controller.submit(input); await flush();
  const post = h.requests.find(value => value.method === 'POST')!;
  h.controller.stop(); assert.equal(post.signal.aborted, true); assert.equal(h.latest().state, null); assert.equal(h.latest().accepted, null);
  const observations = h.observed.length; pending.resolve(Response.json(acceptance(id(101)), { status: 202 })); await flush();
  assert.equal(h.observed.length, observations);
  h.controller.start(); await flush(); assert.equal(h.latest().acceptance, 'saved');
  assert.equal(h.requests.filter(value => value.method === 'POST').length, 1); h.controller.stop();
});

test('an account change discards late naming results and the old client cannot submit or observe for the new account', async () => {
  const pending = deferred<Response>();
  const h = harness(async (_, init) => init?.method === 'POST' ? pending.promise : Response.json({ state: { kind: 'not_started' } }));
  h.controller.start(); await flush(); h.controller.submit(input); await flush();
  const post = h.requests.find(value => value.method === 'POST')!;
  h.context.changeSession(accountB); await flush(); assert.equal(post.signal.aborted, true);
  assert.equal(h.latest().state, null); assert.equal(h.latest().accepted, null);
  const observations = h.observed.length, requests = h.requests.length;
  pending.resolve(Response.json(acceptance(id(101)), { status: 202 })); await flush();
  assert.equal(h.observed.length, observations); h.controller.start(); h.controller.refresh();
  assert.equal(h.controller.submit(input), false); await flush();
  assert.equal(h.requests.length, requests); assert.equal(h.operations(), 1);
});

test('held execution is read-only and observer timers cannot turn uncertainty into a new model intent', async () => {
  const held = acceptance(id(101), 'held');
  const h = harness(async () => Response.json({ state: current(held) }));
  h.controller.start(); await flush(); assert.deepEqual(h.latest().state, current(held));
  assert.equal(h.timers.size, 0); const requests = h.requests.length; await h.advance(60_000);
  assert.equal(h.requests.length, requests); h.controller.refresh(); await flush();
  assert.equal(h.operations(), 0); assert(h.requests.every(value => value.method === 'GET')); h.controller.stop();
});

test('429 observation honors Retry-After across restarts and blocks new explicit intents until the read cooldown ends', async () => {
  let reads = 0;
  const h = harness(async () => ++reads === 1
    ? Response.json({ error: { code: 'RATE_LIMITED', message: 'Fictional quota' } }, { status: 429, headers: { 'Retry-After': '90' } })
    : Response.json({ state: { kind: 'not_started' } }));
  h.controller.start(); await flush(); assert.equal(h.controller.submit(input), false);
  h.controller.stop(); h.controller.start(); await flush();
  await h.advance(89_999); assert.equal(reads, 1); await h.advance(1); assert.equal(reads, 2);
  assert.equal(h.operations(), 0); assert.equal(h.latest().checking, false); h.controller.stop();
});

test('offline input, hidden input and unclosed accessors never dispatch or generate an operation ID', async () => {
  const h = harness(async () => Response.json({ state: { kind: 'not_started' } }));
  h.controller.start(); await flush(); h.online(false); assert.equal(h.controller.submit(input), false);
  h.online(true); await flush(); h.visible(false); assert.equal(h.controller.submit(input), false);
  h.visible(true); await flush(); let evaluated = 0;
  const accessor = Object.defineProperty({ ...input }, 'name', { enumerable: true, get() { evaluated++; return ''; } });
  assert.throws(() => h.controller.submit(accessor)); assert.equal(evaluated, 0);
  assert.throws(() => h.controller.submit({ ...input, provider: 'openai' } as typeof input));
  assert.equal(h.operations(), 0); assert(h.requests.every(value => value.method === 'GET')); h.controller.stop();
});

test('detected L0 continues observation until reported application finishes without resubmitting', async () => {
  const applied = acceptance(id(101), 'detected');
  let saved: CompanionNamingAccepted | null = null;
  const h = harness(async (path, init) => {
    if (init?.method === 'POST') {
      saved = { ...applied, progress: { ...applied.progress, application: { status: 'pending', rejectedCategory: null, identityRevision: null } } };
      return Response.json(saved, { status: 202 });
    }
    return Response.json(path === '/companion/naming' ? { state: saved ? current(saved) : { kind: 'not_started' } } : { accepted: saved });
  });
  h.controller.start(); await flush(); h.controller.submit(input); await flush();
  assert.equal(h.latest().accepted?.progress.phase, 'detected');
  assert.equal(h.latest().accepted?.progress.application.status, 'pending'); assert.equal(h.timers.size, 1);
  saved = applied; await h.advance(3_000); assert.equal(h.latest().accepted?.progress.application.status, 'applied');
  assert.equal(h.timers.size, 0); assert.equal(h.requests.filter(value => value.method === 'POST').length, 1); h.controller.stop();
});

test('detected risk continues observation until reported fixed capture is ready without treating capture as handling', async () => {
  let saved: CompanionNamingAccepted | null = null;
  const risk: CompanionNamingAccepted = { ...acceptance(id(101), 'detected'), progress: { ...acceptance(id(101), 'detected').progress,
    detection: { status: 'detected', generation: 1, level: 'L2', mode: 'full' },
    application: { status: 'pending', rejectedCategory: null, identityRevision: null }, resource: 'pending' } };
  const h = harness(async (path, init) => {
    if (init?.method === 'POST') { saved = risk; return Response.json(saved, { status: 202 }); }
    return Response.json(path === '/companion/naming' ? { state: saved ? current(saved) : { kind: 'not_started' } } : { accepted: saved });
  });
  h.controller.start(); await flush(); h.controller.submit(input); await flush(); assert.equal(h.timers.size, 1);
  saved = { ...risk, progress: { ...risk.progress, resource: 'ready' } }; await h.advance(3_000);
  assert.equal(h.latest().accepted?.progress.resource, 'ready'); assert.equal(h.latest().accepted?.progress.application.status, 'pending');
  assert.equal(h.timers.size, 0); assert.equal(h.requests.filter(value => value.method === 'POST').length, 1); h.controller.stop();
});

test('only the known before-handler POST429 restores explicit submission after cooldown; it never retries automatically', async () => {
  let posts = 0, saved: CompanionNamingAccepted | null = null;
  const h = harness(async (path, init) => {
    if (init?.method === 'POST') {
      if (++posts === 1) return Response.json({ error: { code: 'REQUEST_LIMIT_REACHED', message: 'Fictional before-handler quota' } },
        { status: 429, headers: { 'Retry-After': '90' } });
      saved = acceptance(JSON.parse(String(init.body)).operationId); return Response.json(saved, { status: 202 });
    }
    return Response.json(path === '/companion/naming' ? { state: saved ? current(saved) : { kind: 'not_started' } } : { accepted: saved });
  });
  h.controller.start(); await flush(); h.controller.submit(input); await flush();
  assert.equal(h.latest().acceptance, 'idle'); assert.equal(h.controller.submit(input), false);
  await h.advance(90_000); assert.equal(posts, 1); assert.equal(h.operations(), 1);
  assert.equal(h.controller.submit(input), true); await flush();
  assert.equal(posts, 2); assert.equal(h.operations(), 2); assert.equal(h.latest().acceptance, 'saved');
  assert.deepEqual(h.requests.filter(value => value.method === 'POST').map(value => value.body.operationId), [id(101), id(102)]);
  h.controller.stop();
  const ambiguous = harness(async (path, init) => init?.method === 'POST'
    ? Response.json({ error: { code: 'UNKNOWN_PROXY_LIMIT', message: 'Fictional ambiguous quota' } }, { status: 429, headers: { 'Retry-After': '90' } })
    : Response.json(path === '/companion/naming' ? { state: { kind: 'not_started' } } : { accepted: null }));
  // Unknown quota codes retain their operation even after the cooldown.
  ambiguous.controller.start(); await flush(); ambiguous.controller.submit(input); await flush();
  assert.equal(ambiguous.latest().acceptance, 'unknown'); await ambiguous.advance(90_000);
  assert.equal(ambiguous.controller.submit(input), false); assert.equal(ambiguous.operations(), 1); ambiguous.controller.stop();
});

test('a known rolled-back entry conflict refreshes the other device head and permits only a new explicit submission', async () => {
  let posts = 0, saved: CompanionNamingAccepted | null = null;
  const other = acceptance(id(901), 'detected');
  const h = harness(async (path, init) => {
    if (init?.method === 'POST') {
      if (++posts === 1) return Response.json({ error: { code: 'COMPANION_NAME_ENTRY_REVISION_CHANGED', message: 'Fictional rolled-back CAS' } }, { status: 409 });
      const command = JSON.parse(String(init.body)), accepted = acceptance(command.operationId);
      saved = { ...accepted, acceptance: { ...accepted.acceptance, operation: { ...accepted.acceptance.operation, appliedRevision: 2 } },
        progress: { ...accepted.progress, submittedRevision: 2 } };
      return Response.json(saved, { status: 202 });
    }
    return Response.json(path === '/companion/naming' ? { state: current(saved ?? other) } : { accepted: saved });
  });
  h.controller.start(); await flush(); h.controller.submit(input); await flush();
  assert.equal(h.latest().acceptance, 'idle'); assert.equal(posts, 1); assert.equal(h.operations(), 1);
  assert.equal(h.latest().state?.kind, 'naming');
  assert.equal(h.requests.some(value => value.path.endsWith('/' + id(101))), false);
  await h.advance(60_000); assert.equal(posts, 1);
  assert.equal(h.controller.submit({ ...input, expectedEntryRevision: 1 }), true); await flush();
  assert.equal(posts, 2); assert.equal(h.operations(), 2); assert.equal(h.latest().acceptance, 'saved');
  assert.equal(h.latest().accepted?.acceptance.operation.appliedRevision, 2);
  assert.deepEqual(h.requests.filter(value => value.method === 'POST').map(value => value.body.operationId), [id(101), id(102)]);
  h.controller.stop();
});

test('an operation conflict, unknown409 or mismatched conflict status preserves the original uncertain operation', async () => {
  for (const [status, code] of [[409, 'COMPANION_NAME_OPERATION_CONFLICT'], [409, 'REQUEST_FAILED'], [503, 'COMPANION_NAME_ENTRY_REVISION_CHANGED']] as const) {
    const h = harness(async (path, init) => init?.method === 'POST'
      ? Response.json({ error: { code, message: 'Fictional uncertain outcome' } }, { status })
      : Response.json(path === '/companion/naming' ? { state: { kind: 'not_started' } } : { accepted: null }));
    h.controller.start(); await flush(); h.controller.submit(input); await flush();
    assert.equal(h.latest().acceptance, 'unknown');
    assert(h.requests.some(value => value.path.endsWith('/' + id(101)) && value.method === 'GET'));
    await h.advance(60_000); assert.equal(h.controller.submit(input), false);
    assert.equal(h.operations(), 1); assert.equal(h.requests.filter(value => value.method === 'POST').length, 1);
    h.controller.stop();
  }
});
