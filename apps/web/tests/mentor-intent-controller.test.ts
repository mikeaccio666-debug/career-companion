import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { MENTOR_INTENT_PRIVACY, MENTOR_INTENT_PRIVACY_VERSION } from '@companion/platform-contracts';
import { ApiError } from '../src/api-error.ts';
import { MentorIntentController, type MentorControllerClient } from '../src/mentor-intent-controller.ts';
const owner = randomUUID(), id = randomUUID(), offerId = randomUUID(), org = randomUUID(), at = '2026-10-08T10:00:00.000Z';
const offer = (patch: object = {}) => ({ id: offerId, organizationId: org, revision: 1, kind: 'resume_direction', title: 'Fictional service',
  description: 'Fictional purpose', exclusions: 'Fictional exclusions', priceCents: 9900, currency: 'USD', durationMin: 45,
  collector: 'Fictional collector', refundVersion: 'fictional-1', refundRules: 'Fictional refund', appealInstructions: 'Fictional appeal',
  disclosureVersion: 'fictional-1', disclosure: 'Fictional relationship', intentPrivacy: MENTOR_INTENT_PRIVACY,
  updatedAt: at, validFrom: '2025-01-01T00:00:00.000Z', validUntil: '2028-01-01T00:00:00.000Z', earliestSlotAt: '2027-01-01T00:00:00.000Z', availability: 'available', ...patch });
const entry = (patch: object = {}) => ({ configured: true, contactEmail: 'fictional@example.invalid', privacyVersion: MENTOR_INTENT_PRIVACY_VERSION,
  intentPrivacy: MENTOR_INTENT_PRIVACY, offers: [offer()], ...patch });
const intent = () => ({ action: 'create' as const, sessionId: null, body: { operationId: randomUUID(), offerId, offerRevision: 1,
  contactName: 'Fictional student', intentNote: 'Fictional own demand', privacyVersion: MENTOR_INTENT_PRIVACY_VERSION, confirmVisibility: true } });
const record = (patch: object = {}) => ({ id, ownerId: owner, organizationId: org, offerId, offerRevision: 1, kind: 'resume_direction', durationMin: 45,
  contactName: 'Fictional student', contactEmail: 'fictional@example.invalid', intentNote: 'Fictional own demand', status: 'requested', orderId: null,
  mentorId: null, privacyVersion: MENTOR_INTENT_PRIVACY_VERSION, visibilityConfirmedAt: at, revision: 1, createdAt: at, updatedAt: at,
  lastOperationId: randomUUID(), ...patch });
function response(body: any, replayed = false) { return { session: record({ lastOperationId: body.operationId }),
  operation: { id: body.operationId, sessionId: id, appliedRevision: 1, replayed } }; }
function harness(run: (path: string, init: RequestInit) => unknown) {
  let active = true; const listeners = new Set<() => void>();
  const client: MentorControllerClient = { account: { accountId: owner }, isCurrent: () => active,
    subscribe: (fn: () => void) => { listeners.add(fn); return () => listeners.delete(fn); },
    request: async (path: string, init: RequestInit = {}) => await run(path, init) };
  const controller = new MentorIntentController(client, () => {}, { read: 100, write: 20 });
  return { controller, invalidate() { active = false; for (const fn of [...listeners]) fn(); } };
}
async function until(check: () => boolean) { for (let i = 0; i < 200; i++) { if (check()) return; await new Promise(r => setTimeout(r, 2)); } assert(check()); }
const read = (path: string) => path.endsWith('/entry') ? entry() : { sessions: [], nextCursor: null };
async function ready(h: ReturnType<typeof harness>) { h.controller.start(); await until(() => h.controller.snapshot().loaded && !h.controller.snapshot().busy); }
test('only an actually read available service can begin; stale, unavailable and unknown services do not post', async () => {
  for (const catalog of [entry({ configured: false, offers: [] }), entry({ offers: [offer({ availability: 'unavailable', earliestSlotAt: null })] }),
      entry({ offers: [offer({ revision: 2 })] }), entry({ offers: [] })]) {
    let posts = 0; const h = harness((p, init) => { if (init.method) posts++; return p.endsWith('/entry') ? catalog : { sessions: [], nextCursor: null }; });
    await ready(h); h.controller.begin(intent()); assert.equal(posts, 0); assert(h.controller.snapshot().needsRefresh); h.controller.stop();
  }
});
test('lost acknowledgement keeps an immutable nonce, observer 404 cannot release it, and retry never creates a second effect', async () => {
  const posts: string[] = []; let saved: any, effects = 0;
  const h = harness((p, init) => {
    if (p.includes('/operations/')) throw new ApiError('Not yet visible', 404, 'NOT_FOUND');
    if (!init.method) return read(p);
    const body = JSON.parse(String(init.body)); posts.push(body.operationId);
    if (saved) return { ...saved, operation: { ...saved.operation, replayed: true } };
    effects++; saved = response(body); throw Error('Response lost');
  });
  await ready(h); const original = intent(); h.controller.begin(original); original.body.intentNote = 'Later fictional edit';
  await until(() => h.controller.snapshot().uncertain); assert.equal((h.controller.snapshot().pending!.body as any).intentNote, 'Fictional own demand');
  await h.controller.observe(); assert(h.controller.snapshot().pending); h.controller.begin(intent()); assert.equal(posts.length, 1);
  await h.controller.retry(); assert.equal(effects, 1); assert.deepEqual(posts, [original.body.operationId, original.body.operationId]);
  assert.equal(h.controller.snapshot().records.length, 1); assert.equal(h.controller.snapshot().pending, null); h.controller.stop();
});
test('never resolving writes are bounded and their late success cannot paint a receipt before explicit observation', async () => {
  let saved: any, resolve!: (v: unknown) => void;
  const h = harness((p, init) => {
    if (p.includes('/operations/')) return { ...saved, operation: { ...saved.operation, replayed: true } };
    if (!init.method) return read(p); saved = response(JSON.parse(String(init.body))); return new Promise(r => { resolve = r; });
  });
  await ready(h); h.controller.begin(intent()); await until(() => h.controller.snapshot().uncertain);
  resolve(saved); await new Promise(r => setTimeout(r, 5)); assert.equal(h.controller.snapshot().records.length, 0); assert.equal(h.controller.snapshot().lastResult, null);
  await h.controller.observe(); assert.equal(h.controller.snapshot().records.length, 1); assert.equal(h.controller.snapshot().pending, null); h.controller.stop();
});
test('suspend clears private loaded content, fences late writes and resume performs reads without any automatic retry', async () => {
  let saved: any, resolve!: (v: unknown) => void, posts = 0, signal: AbortSignal | null = null;
  const h = harness((p, init) => {
    if (p.includes('/operations/')) return { ...saved, operation: { ...saved.operation, replayed: true } };
    if (!init.method) return p.endsWith('/entry') ? entry() : { sessions: [record()], nextCursor: null };
    posts++; saved = response(JSON.parse(String(init.body))); signal = init.signal as AbortSignal; return new Promise(r => { resolve = r; });
  });
  await ready(h); h.controller.begin(intent()); await until(() => signal !== null); const nonce = h.controller.snapshot().pending!.body.operationId;
  h.controller.suspend(); assert((signal as unknown as AbortSignal).aborted); assert.equal(h.controller.snapshot().entry, null); assert.equal(h.controller.snapshot().records.length, 0);
  resolve(saved); await new Promise(r => setTimeout(r, 5)); assert(h.controller.snapshot().suspended); assert.equal(h.controller.snapshot().lastResult, null);
  h.controller.resume(); await until(() => h.controller.snapshot().loaded); assert.equal(posts, 1); assert(h.controller.snapshot().uncertain);
  assert.equal(h.controller.snapshot().pending!.body.operationId, nonce); await h.controller.observe(); assert.equal(h.controller.snapshot().pending, null); h.controller.stop();
});
test('failed catalog refresh clears stale private display but does not prevent original receipt reconciliation', async () => {
  let saved: any, unavailable = false;
  const h = harness((p, init) => {
    if (p.includes('/operations/')) return { ...saved, operation: { ...saved.operation, replayed: true } };
    if (!init.method) { if (unavailable) throw Error('Catalog unavailable'); return read(p); }
    saved = response(JSON.parse(String(init.body))); throw Error('Lost response');
  });
  await ready(h); h.controller.begin(intent()); await until(() => h.controller.snapshot().uncertain); const pending = h.controller.snapshot().pending;
  unavailable = true; await h.controller.refresh(); assert.equal(h.controller.snapshot().entry, null); assert.equal(h.controller.snapshot().loaded, false);
  assert.equal(h.controller.snapshot().pending, pending); await h.controller.observe(); assert.equal(h.controller.snapshot().lastResult!.session.id, id);
  assert.equal(h.controller.snapshot().pending, null); assert(h.controller.snapshot().needsRefresh); h.controller.stop();
});
test('known conflict requires fresh reading; bare proxy and server/time-out errors remain uncertain', async () => {
  for (const failure of [new ApiError('Proxy', 400), new ApiError('Timeout', 408, 'TIMEOUT'), new ApiError('Unavailable', 503, 'UNAVAILABLE')]) {
    const h = harness((p, init) => !init.method ? read(p) : Promise.reject(failure)); await ready(h); h.controller.begin(intent());
    await until(() => h.controller.snapshot().uncertain); assert(h.controller.snapshot().pending); h.controller.stop();
  }
  let posts = 0; const h = harness((p, init) => { if (!init.method) return read(p); posts++; throw new ApiError('Changed', 409, 'MENTOR_SERVICE_OFFER_CHANGED'); });
  await ready(h); h.controller.begin(intent()); await until(() => !h.controller.snapshot().busy); assert.equal(h.controller.snapshot().pending, null);
  assert(h.controller.snapshot().needsRefresh); h.controller.begin(intent()); assert.equal(posts, 1); await h.controller.refresh(); assert(!h.controller.snapshot().needsRefresh); h.controller.stop();
});
test('account invalidation clears source, private demand and nonce while fencing the actual late response', async () => {
  let resolve!: (v: unknown) => void, saved: any;
  const h = harness((p, init) => { if (!init.method) return read(p); saved = response(JSON.parse(String(init.body))); return new Promise(r => { resolve = r; }); });
  await ready(h); h.controller.begin(intent()); h.invalidate(); resolve(saved); await new Promise(r => setTimeout(r, 5));
  assert.equal(h.controller.snapshot().records.length, 0); assert.equal(h.controller.snapshot().entry, null);
  assert.equal(h.controller.snapshot().pending, null); assert.equal(h.controller.snapshot().loaded, false);
});
test('read-only refresh cannot treat a matching list row as confirmation of the original operation', async () => {
  let saved: any;
  const h = harness((p, init) => !init.method ? p.endsWith('/entry') ? entry() : { sessions: saved ? [saved.session] : [], nextCursor: null }
    : (saved = response(JSON.parse(String(init.body))), Promise.reject(Error('Lost response'))));
  await ready(h); const original = intent(); h.controller.begin(original); await until(() => h.controller.snapshot().uncertain);
  await h.controller.refresh(); assert.equal(h.controller.snapshot().records.length, 1); assert.equal(h.controller.snapshot().lastResult, null);
  assert.equal(h.controller.snapshot().pending!.body.operationId, original.body.operationId); assert(h.controller.snapshot().uncertain); h.controller.stop();
});
test('restart fences an abandoned read and cannot clear the next generation busy state', async () => {
  const resolves: Array<(v: unknown) => void> = []; const h = harness(p => p.endsWith('/entry') ? new Promise(r => resolves.push(r)) : { sessions: [record()], nextCursor: null });
  h.controller.start(); await until(() => resolves.length === 1); h.controller.stop(); h.controller.start(); await until(() => resolves.length === 2);
  await new Promise(r => setTimeout(r, 5)); assert(h.controller.snapshot().busy); resolves[1](entry()); await until(() => h.controller.snapshot().loaded);
  resolves[0](entry({ offers: [] })); await new Promise(r => setTimeout(r, 5)); assert.equal(h.controller.snapshot().entry!.offers.length, 1); h.controller.stop();
});
test('actual 50-row cursors append every row, reject duplicates and cancelling preserves earlier read history', async () => {
  const page = Array.from({ length: 50 }, () => record({ id: randomUUID() })), cursor = page.at(-1)!.id, last = record({ id: randomUUID() }); let duplicate = true;
  const h = harness((p, init) => {
    if (init.method) { const body = JSON.parse(String(init.body)); return { session: { ...page[0], status: 'cancelled', revision: 2, updatedAt: '2026-10-08T11:00:00.000Z', lastOperationId: body.operationId },
      operation: { id: body.operationId, sessionId: page[0].id, appliedRevision: 2, replayed: false } }; }
    if (p.endsWith('/entry')) return entry(); if (p.includes('?after=')) return { sessions: [duplicate ? page[0] : last], nextCursor: null };
    return { sessions: page, nextCursor: cursor };
  });
  await ready(h); await h.controller.loadMore(); assert.equal(h.controller.snapshot().records.length, 50); assert.equal(h.controller.snapshot().nextCursor, cursor);
  duplicate = false; await h.controller.loadMore(); assert.equal(h.controller.snapshot().records.length, 51);
  h.controller.begin({ action: 'cancel', sessionId: page[0].id, body: { operationId: randomUUID(), expectedRevision: 1 } });
  await until(() => h.controller.snapshot().lastResult !== null); assert.equal(h.controller.snapshot().records[0].status, 'cancelled');
  assert.equal(h.controller.snapshot().records.length, 51); assert.equal(h.controller.snapshot().records.at(-1)!.id, last.id); h.controller.stop();
});
