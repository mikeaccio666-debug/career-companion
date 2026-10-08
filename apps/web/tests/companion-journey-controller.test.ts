import assert from 'node:assert/strict';
import test from 'node:test';
import { PLATFORM_ACCOUNT_HEADER } from '@companion/platform-contracts';
import { AccountRequestContext } from '../src/account-context.ts';
import { createPlatformClient } from '../src/api.ts';
import { createPlatformEndpoints } from '../src/platform-endpoints.ts';
import { CompanionJourneyController, type CompanionJourneyObservation } from '../src/companion-journey-controller.ts';
import type { CompanionNamingEnvironment } from '../src/companion-naming-controller.ts';

const id = (n: number) => `25000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const account = id(1), taskId = id(2), companionId = id(3), submissionId = id(4), dispatchId = id(5);
const input = { taskId, expectedIdentityRevision: 1, expectedRevision: 0, sealChar: '稳' };
const selection = { taskId, companionId, previewRevision: 1 as const, identityRevision: 1, revision: 0, selectedSeal: null as string | null };
const progress = { dispatchId, taskId, submissionId, submittedRevision: 1, phase: 'detected' as const, hold: null,
  detection: { status: 'detected' as const, generation: 1, level: 'L0' as const, mode: 'full' as const },
  application: { status: 'applied' as const, rejectedCategory: null, identityRevision: 1 }, resource: 'not_required' as const };
const journey = { kind: 'journey' as const, taskId, companionId, stage: 'seal_ready' as const,
  latestNamingOperationId: id(44),
  preview: { taskId, companionId, revision: 1, generatedBy: 'fallback', summary: '虚构预览', samples: ['虚构一', '虚构二', '虚构三'], inkToken: 'dai' },
  naming: { kind: 'naming', entry: { taskId, companionId, revision: 1, latestSubmissionId: submissionId }, latest: progress },
  identity: { taskId, companionId, previewRevision: 1, revision: 1, name: 'Milo', nameOrigin: 'user_typed', inkToken: 'dai',
    sealCandidates: [{ char: '米', reason: '虚构读音' }, { char: '稳', reason: '虚构性格' }, { char: '启', reason: '虚构阶段' }] }, selection };
const saved = (operation: string, revision = 1) => ({ selection: { ...selection, revision, selectedSeal: revision > 1 ? '启' : '稳' },
  operation: { id: operation, appliedRevision: 1, replayed: true } });
const flush = async () => { for (let i = 0; i < 12; i++) await new Promise<void>(done => setImmediate(done)); };
function harness(transport: (path: string, init?: RequestInit) => Promise<Response>) {
  const context = new AccountRequestContext(); context.changeSession(account);
  const requests: { path: string; method: string; body: any }[] = [], observed: CompanionJourneyObservation[] = [];
  const client = createPlatformClient(createPlatformEndpoints('https://api.example.invalid'), async (url, init) => {
    assert.equal(new Headers(init?.headers).get(PLATFORM_ACCOUNT_HEADER), account);
    assert.equal(init?.credentials, 'include'); assert.equal(init?.redirect, 'error');
    const path = new URL(String(url)).pathname.replace('/api/platform', '');
    requests.push({ path, method: init?.method ?? 'GET', body: init?.body ? JSON.parse(String(init.body)) : null });
    return transport(path, init);
  }, context).capture();
  let now = 0, sequence = 0, operations = 0, visible = true, online = true;
  const timers = new Map<number, { at: number; run: () => void }>();
  const timing: CompanionNamingEnvironment = {
    now: () => now, isVisible: () => visible, isOnline: () => online, operationId: () => id(100 + ++operations),
    setTimer(run, delay) { const token = ++sequence; timers.set(token, { at: now + delay, run }); return token; },
    clearTimer(timer) { timers.delete(timer as number); },
  };
  const controller = new CompanionJourneyController(client, state => observed.push(state), timing);
  return { controller, context, requests, timers, latest: () => observed.at(-1)!, operations: () => operations,
    visibility(value: boolean) { visible = value; controller.resume(); }, connectivity(value: boolean) { online = value; controller.resume(); },
    async advance(delay: number) {
      const target = now + delay;
      while (true) {
        const next = [...timers.entries()].filter(([, value]) => value.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break; now = next[1].at; timers.delete(next[0]); next[1].run(); await flush();
      }
      now = target; await flush();
    } };
}

test('mount, refresh, StrictMode restart and connectivity only read journey facts', async () => {
  const h = harness(async () => Response.json({ journey }));
  h.controller.start(); await flush(); h.controller.stop(); h.controller.start(); await flush();
  h.visibility(false); h.connectivity(false); h.controller.refresh(); await flush();
  h.visibility(true); h.connectivity(true); await flush(); h.controller.refresh(); await flush();
  assert.deepEqual(h.latest().journey, journey); assert.equal(h.operations(), 0);
  assert(h.requests.every(request => request.method === 'GET' && request.path === '/companion/journey'));
  assert.equal(h.timers.size, 0); h.controller.stop();
});

test('explicit choice snapshots one candidate and recovers saved state without a second write', async () => {
  let committed: ReturnType<typeof saved> | null = null;
  const h = harness(async (path, init) => {
    if (init?.method === 'POST') { committed = saved(JSON.parse(String(init.body)).operationId); return Response.json({ saved: committed }); }
    return Response.json(path === '/companion/journey' ? { journey: committed ? { ...journey, stage: 'seal_saved', selection: committed.selection } : journey }
      : { saved: committed });
  });
  h.controller.start(); await flush(); const mutable = { ...input };
  assert(h.controller.select(mutable)); mutable.sealChar = '启'; assert.equal(h.controller.select(input), false); await flush();
  assert.equal(h.latest().acceptance, 'saved'); assert.equal(h.latest().selection?.selection.selectedSeal, '稳');
  assert.equal(h.requests.find(request => request.method === 'POST')!.body.sealChar, '稳');
  h.controller.stop(); h.controller.start(); await flush(); h.controller.resume(); await flush(); await h.advance(60_000);
  assert.equal(h.requests.filter(request => request.method === 'POST').length, 1); assert.equal(h.operations(), 1); h.controller.stop();
});

test('lost selection response observes its original operation beside a later choice from another device', async () => {
  let committed = false;
  const h = harness(async (path, init) => {
    if (init?.method === 'POST') { committed = true; throw new TypeError('Fictional response lost after commit'); }
    return Response.json(path === '/companion/journey' ? { journey: committed ? { ...journey, stage: 'seal_saved', selection: saved(id(101), 3).selection } : journey }
      : { saved: committed ? saved(id(101), 3) : null });
  });
  h.controller.start(); await flush(); h.controller.select(input); await flush();
  assert.equal(h.latest().acceptance, 'saved'); assert.equal(h.latest().selection?.operation.appliedRevision, 1);
  assert.equal(h.latest().selection?.selection.revision, 3); assert.equal(h.latest().selection?.selection.selectedSeal, '启');
  assert(h.requests.some(request => request.path.endsWith('/operations/' + id(101))));
  h.controller.resume(); await flush(); assert.equal(h.operations(), 1);
  assert.equal(h.requests.filter(request => request.method === 'POST').length, 1); h.controller.stop();
});

test('opaque conflict and absent own-operation read remain uncertain across restart without resubmission', async () => {
  const h = harness(async (path, init) => init?.method === 'POST'
    ? Response.json({ error: { code: 'COMPANION_SEAL_SELECTION_OPERATION_CONFLICT', message: 'Fictional conflict' } }, { status: 409 })
    : Response.json(path === '/companion/journey' ? { journey } : { saved: null }));
  h.controller.start(); await flush(); h.controller.select(input); await flush();
  assert.equal(h.latest().acceptance, 'unknown'); assert.equal(h.controller.select(input), false);
  h.controller.stop(); h.controller.start(); await flush(); assert.equal(h.latest().acceptance, 'unknown');
  await h.advance(9_000); assert.equal(h.operations(), 1); assert.equal(h.requests.filter(request => request.method === 'POST').length, 1);
  h.controller.stop();
});

test('exact seal and identity CAS refusal permits a new explicit choice after read-only refresh', async () => {
  for (const code of ['COMPANION_IDENTITY_REVISION_CHANGED', 'COMPANION_SEAL_SELECTION_REVISION_CHANGED']) {
    const h = harness(async (_path, init) => init?.method === 'POST'
      ? Response.json({ error: { code, message: 'Fictional stale revision' } }, { status: 409 }) : Response.json({ journey }));
    h.controller.start(); await flush(); h.controller.select(input); await flush();
    assert.equal(h.latest().acceptance, 'idle'); assert.equal(h.controller.select(input), true); await flush();
    assert.equal(h.operations(), 2); assert.equal(h.requests.filter(request => request.method === 'POST').length, 2); h.controller.stop();
  }
});

test('account switch immediately clears observations and refuses a late response or further requests', async () => {
  let resolve!: (response: Response) => void;
  const response = new Promise<Response>(done => { resolve = done; });
  const h = harness(async () => response);
  h.controller.start(); await flush(); h.context.changeSession(id(9)); resolve(Response.json({ journey })); await flush();
  assert.equal(h.latest().journey, null); assert.equal(h.controller.select(input), false);
  h.controller.start(); h.controller.refresh(); await flush(); assert.equal(h.requests.length, 1); assert.equal(h.timers.size, 0);
});

test('quota refusal uses a bounded conservative pause and cannot trigger another automatic choice', async () => {
  let refused = false;
  const h = harness(async (_path, init) => {
    if (init?.method === 'POST') { refused = true; return Response.json({ error: { code: 'REQUEST_LIMIT_REACHED', message: 'Fictional quota' } },
      { status: 429, headers: { 'Retry-After': '2' } }); }
    return Response.json({ journey });
  });
  h.controller.start(); await flush(); h.controller.select(input); await flush(); assert(refused);
  const before = h.requests.length; h.controller.refresh(); await h.advance(59_999); assert.equal(h.requests.length, before);
  await h.advance(1); assert(h.requests.length > before); assert.equal(h.requests.filter(request => request.method === 'POST').length, 1);
  h.controller.stop();
});

test('preparation recovery is one explicit original operation and resumes through GET rather than another intent', async () => {
  const accepted = { acceptance: { dispatchId, taskId, submissionId, operation: { id: id(44), appliedRevision: 1, replayed: true } }, progress };
  const h = harness(async (path, init) => Response.json(init?.method === 'POST' || path.startsWith('/companion/naming/submissions/')
    ? { accepted } : { journey }));
  h.controller.start(); await flush(); assert(h.controller.resumePreparation(id(44))); await flush();
  assert.equal(h.operations(), 0); assert.equal(h.latest().acceptance, 'saved');
  assert.deepEqual(h.requests.find(request => request.method === 'POST')!.body, { operationId: id(44) });
  h.controller.resume(); await flush(); h.controller.stop(); h.controller.start(); await flush();
  assert.equal(h.requests.filter(request => request.method === 'POST').length, 1); h.controller.stop();
});

test('a confirmed preparation receipt with a pending application permits another explicit original-op recovery', async () => {
  const pending = { ...progress, phase: 'held', hold: 'requires_review', application: { status: 'pending', rejectedCategory: null, identityRevision: null } };
  const accepted = { acceptance: { dispatchId, taskId, submissionId, operation: { id: id(44), appliedRevision: 1, replayed: true } }, progress: pending };
  const h = harness(async (path, init) => Response.json(init?.method === 'POST' || path.startsWith('/companion/naming/submissions/')
    ? { accepted } : { journey: { ...journey, stage: 'naming', identity: null, selection: null, naming: { ...journey.naming, latest: pending } } }));
  h.controller.start(); await flush(); assert(h.controller.resumePreparation(id(44))); await flush();
  assert.equal(h.latest().acceptance, 'saved');
  h.controller.refresh(); await flush(); assert.equal(h.latest().acceptance, 'saved');
  assert(h.controller.resumePreparation(id(44))); await flush();
  const writes = h.requests.filter(request => request.method === 'POST');
  assert.equal(writes.length, 2); assert(writes.every(request => request.body.operationId === id(44)));
  assert.equal(h.operations(), 0); h.controller.stop();
});

test('a lost preparation response keeps the original pending operation uncertain and never retries the write automatically', async () => {
  const pending = { ...progress, phase: 'held', hold: 'requires_review', application: { status: 'pending', rejectedCategory: null, identityRevision: null } };
  const accepted = { acceptance: { dispatchId, taskId, submissionId, operation: { id: id(44), appliedRevision: 1, replayed: true } }, progress: pending };
  const h = harness(async (path, init) => {
    if (init?.method === 'POST') throw new TypeError('Fictional preparation response lost');
    return Response.json(path.startsWith('/companion/naming/submissions/') ? { accepted }
      : { journey: { ...journey, stage: 'naming', identity: null, selection: null, naming: { ...journey.naming, latest: pending } } });
  });
  h.controller.start(); await flush(); assert(h.controller.resumePreparation(id(44))); await flush();
  assert.equal(h.latest().acceptance, 'unknown'); assert.equal(h.controller.resumePreparation(id(44)), false);
  h.controller.stop(); h.controller.start(); await flush(); await h.advance(9_000);
  assert.equal(h.latest().acceptance, 'unknown'); assert.equal(h.requests.filter(request => request.method === 'POST').length, 1);
  assert.equal(h.operations(), 0); h.controller.stop();
});
