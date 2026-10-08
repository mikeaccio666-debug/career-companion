import assert from 'node:assert/strict';
import test from 'node:test';
import { PLATFORM_ACCOUNT_HEADER } from '@companion/platform-contracts';
import { AccountRequestContext } from '../src/account-context.ts';
import { createPlatformClient } from '../src/api.ts';
import { createPlatformEndpoints } from '../src/platform-endpoints.ts';
import { SafetyResourceController, type SafetyResourceDomPort, type SafetyResourceEnvironment, type SafetyResourceObservation } from '../src/safety-resource-controller.ts';
import { at, claim, id, projection, questionState, receipt, reservationToken, resourceState } from './fixtures/safety-resource.ts';

// Synthetic HTTP replies and DOM ports test browser orchestration. Real PG/service/DOM acceptance is separate.
const flush = async () => { for (let i = 0; i < 20; i++) await new Promise<void>(done => setImmediate(done)); };
function deferred<T>() { let resolve!: (v: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
type Call = { path: string; method: string; data: any; signal: AbortSignal };
function harness(custom?: (call: Call, reply: any) => unknown | Promise<unknown>) {
  const context = new AccountRequestContext(); context.changeSession(id(1));
  let now = 0, visible = true, online = true, sequence = 100, timerSequence = 0, projectionSequence = 20, changes = 0;
  const server = { state: resourceState(), published: true, availability: 'ready' as 'ready' | 'pending' | 'unavailable', q: questionState(), indexFailure: false };
  const calls: Call[] = [], observed: SafetyResourceObservation[] = [], blockers: boolean[] = [], timers = new Map<number, { at: number; run: () => void }>();
  const client = createPlatformClient(createPlatformEndpoints('https://api.example.invalid'), async (url, init) => {
    assert.equal(new Headers(init?.headers).get(PLATFORM_ACCOUNT_HEADER), id(1)); assert.equal(init?.credentials, 'include');
    const path = new URL(String(url)).pathname.replace('/api/platform', ''), data = init?.body ? JSON.parse(String(init.body)) : null;
    const call = { path, data, method: init?.method ?? 'GET', signal: init!.signal! }; calls.push(call); let reply: unknown;
    if (path === '/companion/support') {
      if (server.indexFailure) throw new Error('Fictional lost observation.');
      reply = { index: { sources: [{ sourceRef: { kind: server.state.sourceKind, submissionId: server.state.submissionId }, availability: server.availability,
        publication: server.published && server.availability === 'ready' ? server.state : null }] } };
    } else if (path.includes('/publications')) {
      server.published = true;
      if (path.endsWith('/recovery')) server.state = resourceState({ ...server.state, publicationId: id(30), edition: server.state.edition + 1, status: 'ready', revision: 0 });
      reply = { publication: { sourceKind: server.state.sourceKind, publicationId: server.state.publicationId,
        submissionId: server.state.submissionId, edition: server.state.edition, replayed: false } };
    } else if (path === '/companion/support/body') reply = { projection: projection(server.state, id(++projectionSequence)) };
    else if (path === '/companion/support/actions') {
      assert.equal(data.expectedPublicationRevision, server.state.revision);
      const action = data.action;
      server.state = resourceState({ ...server.state, revision: server.state.revision + 1,
        presented: server.state.presented || action.kind === 'present_body', acknowledged: server.state.acknowledged || action.kind === 'acknowledge',
        handled: server.state.handled || ['continue_intake', 'continue_naming', 'clarify_exaggeration'].includes(action.kind),
        clarifiedAt: action.kind === 'clarify_exaggeration' ? at : server.state.clarifiedAt });
      reply = { result: { state: server.state, operation: { id: data.operationId, appliedRevision: server.state.revision, replayed: false },
        ...(action.kind === 'present_body' ? { presentationReceipt: receipt } : {}) } };
    } else if (path.endsWith('/reservations')) reply = { reservation: { sourceKind: server.state.sourceKind, publicationId: server.state.publicationId,
      occurrenceId: id(6), reservationId: id(8), generation: 1, reservedUntil: at, scopeRevision: data.expectedQuestionScopeRevision + 1,
      reservationToken, operation: { id: data.operationId, appliedRevision: data.expectedQuestionScopeRevision + 1, replayed: false } } };
    else if (path.endsWith('/claims')) reply = { claim: claim(data) };
    else if (path.endsWith('/presentations')) {
      server.q = questionState({ sourcePhase: 'declared', receiptReceivedAt: at, scopeRevision: 3 });
      reply = { presentation: { occurrenceId: data.occurrenceId, receiptReceivedAt: at, scopeRevision: 3,
        operation: { id: data.operationId, appliedRevision: 3, replayed: false } } };
    } else if (path.includes('/questions/')) reply = { state: server.q };
    else reply = { state: server.state };
    const result = custom ? await custom(call, reply) : reply;
    return result instanceof Response ? result : Response.json(result);
  }, context).capture();
  const environment: SafetyResourceEnvironment = { monotonicNow: () => now, isVisible: () => visible, isOnline: () => online, operationId: () => id(++sequence),
    setTimer(run, delay) { const n = ++timerSequence; timers.set(n, { at: now + delay, run }); return n; }, clearTimer(n) { timers.delete(n as number); } };
  const controller = new SafetyResourceController(client, view => observed.push(view), () => changes++, environment, b => blockers.push(b));
  const target = () => ({ sourceKind: server.state.sourceKind, publicationId: server.state.publicationId });
  function dom(bodyConnected = true, questionConnected = true) {
    let connected = true, content = ''; const writes: string[] = [];
    const port: SafetyResourceDomPort = { bodyConnected: () => connected && bodyConnected, questionConnected: () => connected && questionConnected,
      writeQuestion(text) { assert(connected && questionConnected && visible); content = text; writes.push(text); }, clearQuestion() { content = ''; } };
    return { port, writes, text: () => content, disconnect() { connected = false; } };
  }
  return { controller, client, context, calls, server, observed, blockers, timers, target, dom, changes: () => changes,
    latest: () => observed.at(-1)!, moveTime: (v: number) => { now = v; }, visible(v: boolean) { visible = v; controller.resume(); },
    online(v: boolean) { online = v; controller.resume(); }, async advance(ms: number) { now += ms;
      for (const [n, timer] of [...timers]) if (timer.at <= now) { timers.delete(n); timer.run(); } await flush(); } };
}
const count = (h: ReturnType<typeof harness>, ending: string) => h.calls.filter(c => c.path.endsWith(ending)).length;

test('resource mount loads only typed support/body; no question reservation or declaration occurs before connected DOM ownership', async () => {
  const h = harness(); h.controller.start(); await flush();
  assert.equal(h.latest().cards[0].projection?.body.text, 'Fictional reviewed body.');
  assert.equal(count(h, '/reservations'), 0); assert.equal(count(h, '/claims'), 0); assert.equal(count(h, '/presentations'), 0);
  assert.equal(h.calls.filter(c => c.path.endsWith('/actions')).length, 0); assert.equal(h.changes(), 0);
  assert(h.calls.every(c => !c.path.startsWith('/onboarding'))); assert.deepEqual(h.blockers, [true]); h.controller.stop();
});
test('one real-shaped committed live claim writes one connected question and an honest presentation, separate from resource acknowledgment', async () => {
  const h = harness(); h.controller.start(); await flush(); const dom = h.dom(); const detach = h.controller.attach(h.target(), dom.port); await flush();
  assert.deepEqual(dom.writes, ['Fictional direct safety question?']); assert.equal(count(h, '/claims'), 1); assert.equal(count(h, '/presentations'), 1);
  assert.equal(h.latest().cards[0].canAcknowledge, true); assert.equal(h.latest().cards[0].canContinue, false); assert.equal(h.changes(), 0);
  assert(!JSON.stringify(h.observed).includes('Fictional direct safety question?')); assert(!JSON.stringify(h.observed).includes(receipt));
  const present = h.calls.find(c => c.path.endsWith('/presentations'))!, reservation = h.calls.find(c => c.path.endsWith('/reservations'))!;
  assert.equal(present.data.renderOwnerId, reservation.data.renderOwnerId);
  await h.controller.acknowledge(h.target()); assert.equal(h.latest().cards[0].canContinue, true); assert.equal(h.changes(), 0);
  await h.controller.continue(h.target()); assert.equal(h.changes(), 1); assert.equal(h.latest().cards[0].state.handled, true);
  assert(h.blockers.at(-1)); h.controller.refresh(); await flush(); assert.equal(h.blockers.at(-1), false);
  detach(); h.controller.stop();
});
test('StrictMode stop/start, refresh and remount consume the original grant without showing or posting it again', async () => {
  const h = harness(); h.controller.start(); await flush(); const dom = h.dom(); const detach = h.controller.attach(h.target(), dom.port); await flush();
  h.controller.refresh(); await flush(); assert.equal(dom.writes.length, 1);
  h.controller.stop(); assert.equal(dom.text(), ''); detach(); h.controller.start(); await flush();
  assert(h.latest().cards[0].projection); assert.equal(h.latest().cards[0].canAcknowledge, false);
  const next = h.dom(); h.controller.attach(h.target(), next.port); await flush();
  assert.equal(next.writes.length, 0); assert.equal(count(h, '/claims'), 1); assert.equal(count(h, '/presentations'), 1);
  assert.equal(h.latest().cards[0].canAcknowledge, true); h.controller.stop();
});
test('request-start monotonic latency and conservative margin discard a spent ticket without losing usable body resources', async () => {
  let h!: ReturnType<typeof harness>;
  h = harness((call, reply) => { if (call.path.endsWith('/claims')) h.moveTime(9751); return reply; });
  h.controller.start(); await flush(); const dom = h.dom(); h.controller.attach(h.target(), dom.port); await flush();
  assert.equal(dom.writes.length, 0); assert.equal(count(h, '/claims'), 1); assert.equal(count(h, '/presentations'), 0);
  assert.equal(h.latest().cards[0].canAcknowledge, true); assert.equal(h.latest().cards[0].projection?.body.text, 'Fictional reviewed body.'); h.controller.stop();
});
test('a live question is cleared on its monotonic deadline while already displayed resources remain available', async () => {
  const h = harness(); h.controller.start(); await flush(); const dom = h.dom(); h.controller.attach(h.target(), dom.port); await flush();
  assert(dom.text()); await h.advance(9750); assert.equal(dom.text(), ''); assert.equal(h.latest().cards[0].canAcknowledge, true);
  h.controller.refresh(); await flush(); assert.equal(count(h, '/claims'), 1); h.controller.stop();
});
test('detached, hidden and separately disconnected question slots do not declare question exposure or block body presentation', async () => {
  const h = harness(); h.controller.start(); await flush(); const dom = h.dom(true, false); h.controller.attach(h.target(), dom.port); await flush();
  assert.equal(count(h, '/reservations'), 0); assert.equal(h.latest().cards[0].canAcknowledge, true); assert.equal(dom.writes.length, 0);
  h.visible(false); h.controller.refresh(); await flush(); assert.equal(count(h, '/claims'), 0); h.controller.stop();
});
test('a claim returning after hide/show loses its render epoch and cannot be adopted into the re-visible DOM', async () => {
  const held = deferred<unknown>(); let actual: unknown;
  const h = harness((call, reply) => { if (call.path.endsWith('/claims')) { actual = reply; return held.promise; } return reply; });
  h.controller.start(); await flush(); const dom = h.dom(); h.controller.attach(h.target(), dom.port); await flush(); assert(actual);
  h.visible(false); h.visible(true); held.resolve(actual); await flush();
  assert.equal(dom.writes.length, 0); assert.equal(count(h, '/presentations'), 0); assert.equal(h.latest().cards[0].canAcknowledge, true); h.controller.stop();
});
test('same-account re-login and account change clear origin receipts and ignore a late committed claim', async () => {
  for (const account of [id(1), id(2)]) {
    const held = deferred<unknown>(); let actual: unknown;
    const h = harness((call, reply) => { if (call.path.endsWith('/claims')) { actual = reply; return held.promise; } return reply; });
    h.controller.start(); await flush(); const dom = h.dom(); h.controller.attach(h.target(), dom.port); await flush();
    assert.equal(h.latest().cards[0].canAcknowledge, true); h.context.changeSession(account); held.resolve(actual); await flush();
    assert.equal(dom.writes.length, 0); assert.equal(h.latest().cards.length, 0); assert.equal(count(h, '/presentations'), 0); assert.equal(h.blockers.at(-1), true);
  }
});
test('an already claimed same-source question stays uncertain while body acknowledgment and explicit continuation are independently usable', async () => {
  const h = harness(); h.server.q = questionState({ sourcePhase: 'claimed', deliveryUncertain: true });
  h.controller.start(); await flush(); const dom = h.dom(); h.controller.attach(h.target(), dom.port); await flush();
  assert.equal(count(h, '/reservations'), 0); assert.equal(dom.writes.length, 0); assert(h.latest().cards[0].questionNotice);
  await h.controller.continue(h.target()); assert.equal(h.changes(), 0);
  await h.controller.acknowledge(h.target()); await h.controller.continue(h.target(), true);
  const action = h.calls.filter(c => c.path.endsWith('/actions')).at(-1)!.data.action;
  assert.deepEqual(action, { kind: 'clarify_exaggeration', presentationReceipt: receipt, safe: true, exaggeration: true }); assert.equal(h.changes(), 1); h.controller.stop();
});
test('global legacy/uncertainty flags do not invent a same-source asked decision; the genuine new-signal server reserve and claim decide', async () => {
  const h = harness(); h.server.q = questionState({ possibleLegacyExposure: true, deliveryUncertain: true, sourcePhase: null });
  h.controller.start(); await flush(); const dom = h.dom(); h.controller.attach(h.target(), dom.port); await flush();
  assert.equal(count(h, '/reservations'), 1); assert.equal(dom.writes.length, 1); h.controller.stop();
});
test('lost question-presentation reply is not re-POSTed and neither refresh nor StrictMode redisplays its consumed grant', async () => {
  const h = harness((call, reply) => { if (call.path.endsWith('/presentations')) throw new Error('Fictional lost committed receipt.'); return reply; });
  h.controller.start(); await flush(); const dom = h.dom(); h.controller.attach(h.target(), dom.port); await flush();
  assert.equal(dom.writes.length, 1); assert(h.latest().cards[0].questionNotice); assert.equal(h.latest().cards[0].canAcknowledge, true);
  h.controller.refresh(); await flush(); h.controller.stop(); h.controller.start(); await flush(); const second = h.dom(); h.controller.attach(h.target(), second.port); await flush();
  assert.equal(second.writes.length, 0); assert.equal(count(h, '/presentations'), 1); assert.equal(count(h, '/claims'), 1); h.controller.stop();
});
test('lost body-presentation receipt never authorizes acknowledgment or auto-retry; an explicit new projection starts a fresh memory chain', async () => {
  let lost = true;
  const h = harness((call, reply) => { if (call.path.endsWith('/actions') && call.data.action.kind === 'present_body' && lost) { lost = false; throw new Error('Fictional lost body receipt.'); } return reply; });
  h.server.state = resourceState({ level: 'L1' }); h.controller.start(); await flush(); const dom = h.dom(); const detach = h.controller.attach(h.target(), dom.port); await flush();
  assert.equal(h.latest().cards[0].canAcknowledge, false); await h.controller.acknowledge(h.target()); await h.controller.continue(h.target());
  assert.equal(h.changes(), 0); h.controller.refresh(); await flush(); assert.equal(h.calls.filter(c => c.path.endsWith('/actions')).length, 1);
  await h.controller.redisplay(h.target()); detach(); h.controller.attach(h.target(), dom.port); await flush();
  assert.equal(h.latest().cards[0].canAcknowledge, true); assert.equal(h.latest().cards[0].canContinue, false); h.controller.stop();
});
test('a two-device body revision conflict is only observed until the user explicitly requests a fresh projection and presentation', async () => {
  let conflict = true;
  const h = harness((call, reply) => {
    if (call.path.endsWith('/actions') && call.data.action.kind === 'present_body' && conflict) {
      conflict = false; return Response.json({ error: { code: 'SAFETY_DELIVERY_REVISION_CHANGED', message: 'Fictional concurrent device revision.' } }, { status: 409 });
    }
    return reply;
  });
  h.server.state = resourceState({ level: 'L1' }); h.controller.start(); await flush(); const dom = h.dom(); const detach = h.controller.attach(h.target(), dom.port); await flush();
  assert.equal(h.latest().cards[0].canAcknowledge, false); const oldProjection = h.latest().cards[0].projection!.bodyProjectionId;
  h.controller.refresh(); await flush(); assert.equal(h.latest().cards[0].state.revision, 1);
  assert.equal(h.calls.filter(c => c.path.endsWith('/actions')).length, 1); assert.equal(h.latest().cards[0].canAcknowledge, false);
  await h.controller.redisplay(h.target()); detach(); h.controller.attach(h.target(), dom.port); await flush();
  assert.notEqual(h.latest().cards[0].projection!.bodyProjectionId, oldProjection);
  assert.equal(h.calls.filter(c => c.path.endsWith('/actions')).length, 2); assert.equal(h.latest().cards[0].canAcknowledge, true);
  assert.equal(h.changes(), 0); h.controller.stop();
});
test('a lost initial deterministic publication reply recovers through GET index without creating another publication operation', async () => {
  const h = harness((call, reply) => { if (call.path === '/companion/support/publications') throw new Error('Fictional lost publication reply.'); return reply; });
  h.server.published = false; h.server.state = resourceState({ level: 'L1' }); h.controller.start(); await flush();
  assert.equal(h.latest().cards.length, 0); assert.equal(count(h, '/publications'), 1);
  h.controller.refresh(); await flush(); assert.equal(count(h, '/publications'), 1); assert(h.latest().cards[0].projection); h.controller.stop();
});
test('expired resource recovery requires an explicit operation and lost recovery reply is only observed, without a new POST', async () => {
  const h = harness((call, reply) => { if (call.path.endsWith('/recovery')) throw new Error('Fictional lost recovery reply.'); return reply; });
  h.server.state = resourceState({ level: 'L1', status: 'expired' }); h.controller.start(); await flush();
  assert.equal(count(h, '/body'), 0); assert.equal(count(h, '/recovery'), 0);
  await h.controller.recover({ kind: 'companion_name', submissionId: id(4) }); await flush();
  assert.equal(count(h, '/recovery'), 1); assert.equal(h.latest().cards.find(c => c.state.edition === 2)?.state.status, 'ready');
  h.controller.refresh(); await flush(); assert.equal(count(h, '/recovery'), 1); h.controller.stop();
});
test('an uncommitted initial resource request remains explicitly retryable with the same operation after configuration becomes available', async () => {
  let failed = true, h!: ReturnType<typeof harness>;
  h = harness((call, reply) => {
    if (call.path === '/companion/support/publications' && failed) {
      // Synthetic configuration rejection/rollback: no committed publication exists in the subsequent genuine-shaped index.
      h.server.published = false; throw new Error('Fictional unavailable reviewed configuration.');
    }
    return reply;
  });
  h.server.published = false; h.server.state = resourceState({ level: 'L1' }); h.controller.start(); await flush();
  const first = h.calls.find(c => c.path === '/companion/support/publications')!;
  const source = h.latest().publicationRetries[0]; assert(source); assert.equal(h.latest().cards.length, 0);
  h.controller.refresh(); await flush(); assert.equal(count(h, '/publications'), 1);
  failed = false; const before = h.calls.length; await h.controller.retryPublication(source); await flush();
  const retry = h.calls.filter(c => c.path === '/companion/support/publications').at(-1)!;
  assert.deepEqual(retry.data, first.data); assert.equal(h.calls[before].method, 'GET'); assert.equal(h.calls[before].path, '/companion/support');
  assert.equal(count(h, '/publications'), 2); assert(h.latest().cards[0].projection); assert.equal(h.latest().publicationRetries.length, 0);
  assert.equal(h.changes(), 0); h.controller.stop();
});
test('explicit initial retry observes an existing committed publication without re-POSTing its lost reply', async () => {
  const h = harness((call, reply) => { if (call.path === '/companion/support/publications') throw new Error('Fictional lost committed publication reply.'); return reply; });
  h.server.published = false; h.server.state = resourceState({ level: 'L1' }); h.controller.start(); await flush();
  const source = h.latest().publicationRetries[0]; assert(source);
  await h.controller.retryPublication(source); await flush();
  assert.equal(count(h, '/publications'), 1); assert(h.latest().cards[0].projection); assert.equal(h.latest().publicationRetries.length, 0); h.controller.stop();
});
test('unknown index failure cannot authorize a resource retry and preserves the same original operation for a later explicit action', async () => {
  let h!: ReturnType<typeof harness>, failed = true;
  h = harness((call, reply) => { if (call.path === '/companion/support/publications' && failed) { h.server.published = false; throw new Error('Fictional request not accepted.'); } return reply; });
  h.server.published = false; h.server.state = resourceState({ level: 'L1' }); h.controller.start(); await flush();
  const source = h.latest().publicationRetries[0], original = h.calls.find(c => c.path === '/companion/support/publications')!.data;
  h.server.indexFailure = true; await h.controller.retryPublication(source); await flush();
  assert.equal(count(h, '/publications'), 1); assert(h.latest().publicationRetries.length); assert.equal(h.blockers.at(-1), true);
  h.server.indexFailure = false; failed = false; await h.controller.retryPublication(source); await flush();
  assert.deepEqual(h.calls.filter(c => c.path === '/companion/support/publications').at(-1)!.data, original);
  assert.equal(count(h, '/publications'), 2); h.controller.stop();
});
test('uncommitted expired recovery can be manually retried after rollback with the exact original operation and edition', async () => {
  let failed = true, h!: ReturnType<typeof harness>;
  const originalState = resourceState({ level: 'L1', status: 'expired' });
  h = harness((call, reply) => { if (call.path.endsWith('/recovery') && failed) { h.server.state = originalState; throw new Error('Fictional reviewed recovery configuration unavailable.'); } return reply; });
  h.server.state = originalState; h.controller.start(); await flush();
  const source = { kind: originalState.sourceKind, submissionId: originalState.submissionId };
  await h.controller.recover(source); await flush(); assert.equal(count(h, '/recovery'), 1); assert(h.latest().cards[0].recoveryUncertain);
  const original = h.calls.find(c => c.path.endsWith('/recovery'))!.data;
  h.controller.refresh(); await flush(); assert.equal(count(h, '/recovery'), 1);
  failed = false; const before = h.calls.length; await h.controller.recover(source); await flush();
  assert.deepEqual(h.calls.filter(c => c.path.endsWith('/recovery')).at(-1)!.data, original); assert.equal(original.expectedEdition, 1);
  assert.equal(h.calls[before].method, 'GET'); assert.equal(count(h, '/recovery'), 2);
  assert.equal(h.latest().cards.length, 1); assert.equal(h.latest().cards[0].state.edition, 2); assert.equal(h.latest().cards[0].recoveryUncertain, false);
  h.controller.stop();
});
test('a late retry observation cannot POST through a replaced same-account session generation', async () => {
  let h!: ReturnType<typeof harness>, held: ReturnType<typeof deferred<unknown>> | null = null;
  h = harness((call, reply) => {
    if (call.path === '/companion/support/publications') { h.server.published = false; throw new Error('Fictional uncommitted request.'); }
    if (call.path === '/companion/support' && held) return held.promise;
    return reply;
  });
  h.server.published = false; h.server.state = resourceState({ level: 'L1' }); h.controller.start(); await flush();
  const source = h.latest().publicationRetries[0]; held = deferred<unknown>();
  const retry = h.controller.retryPublication(source); await flush(); h.context.changeSession(id(1));
  held.resolve({ index: { sources: [{ sourceRef: source, availability: 'ready', publication: null }] } }); await retry; await flush();
  assert.equal(count(h, '/publications'), 1); assert.equal(h.latest().cards.length, 0); assert.equal(h.latest().publicationRetries.length, 0);
});
test('only a complete typed current index clears UI blockers; observation failure keeps displayed bodies and reports blocked', async () => {
  const h = harness(); h.server.state = resourceState({ level: 'L1', presented: true, acknowledged: true, handled: true });
  h.controller.start(); await flush(); assert.equal(h.blockers.at(-1), false); assert(h.latest().cards[0].projection);
  h.server.indexFailure = true; h.controller.refresh(); await flush(); assert.equal(h.blockers.at(-1), true); assert(h.latest().cards[0].projection);
  h.server.indexFailure = false; h.server.availability = 'unavailable'; h.controller.refresh(); await flush(); assert.equal(h.blockers.at(-1), true);
  assert(h.latest().cards[0].projection); h.controller.stop();
});

test('scroll ownership re-check sends no GET and consumes a question that leaves the visible DOM instead of displaying it again', async () => {
  const h = harness(); h.controller.start(); await flush(); const dom = h.dom(); h.controller.attach(h.target(), dom.port); await flush();
  const calls = h.calls.length; dom.disconnect(); h.controller.recheckDom(); await flush();
  assert.equal(dom.text(), ''); assert.equal(h.calls.length, calls); assert.equal(dom.writes.length, 1); h.controller.stop();
});
test('a replayed hash-only reservation cannot recreate a lost token or issue a claim', async () => {
  const h = harness((call, reply) => {
    if (call.path.endsWith('/reservations')) { const { reservationToken: _, ...r } = reply.reservation; return { reservation: { ...r, operation: { ...r.operation, replayed: true } } }; }
    return reply;
  });
  h.controller.start(); await flush(); const dom = h.dom(); h.controller.attach(h.target(), dom.port); await flush();
  assert.equal(count(h, '/claims'), 0); assert.equal(dom.writes.length, 0); assert.equal(h.latest().cards[0].canAcknowledge, true);
  h.controller.refresh(); await flush(); assert.equal(count(h, '/reservations'), 1); h.controller.stop();
});
