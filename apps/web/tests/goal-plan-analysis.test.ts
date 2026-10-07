import assert from 'node:assert/strict';
import test from 'node:test';
import type { BoundPlatformClient, StreamEvent } from '../src/api.ts';
import { goalPlanAnalysisBody, streamGoalPlanAnalysis } from '../src/goal-plan-analysis.ts';
import { conversationId, deferred, messageId, planId } from './goal-plans-fixture.ts';

const continuation = { planId, conversationId, revision: 1, stepIndex: 0 };
const done: StreamEvent = { event: 'done', data: { message: { id: messageId, role: 'assistant', status: 'complete', content: 'Fictional saved analysis.' } } };
test('analysis sends only the fixed plan reference and accepts only its server-bound complete assistant', async () => {
  const requests: unknown[] = [], observed: StreamEvent[] = [];
  const client: Pick<BoundPlatformClient, 'isCurrent' | 'streamMessage'> = { isCurrent: () => true, async streamMessage(id, body, _signal, event) { requests.push({ id, body }); event({ event: 'start', data: { messageId } }); event({ event: 'delta', data: { text: 'Fictional' } }); event(done); } };
  const source = { ...continuation, provider: 'forged', content: 'Not submitted', attachmentIds: [messageId] };
  assert.equal(await streamGoalPlanAnalysis(client, source, conversationId, new AbortController().signal, () => true, (event) => observed.push(event)), 'complete');
  assert.deepEqual(requests, [{ id: conversationId, body: { goalPlanStep: continuation } }]); assert.equal(observed.length, 3);
});

test('wrong conversation/index/revision fails before a stream request; invalid completion cannot fake success', async () => {
  for (const value of [{ ...continuation, conversationId: planId }, { ...continuation, revision: 0 }, { ...continuation, stepIndex: 8 }]) assert.throws(() => goalPlanAnalysisBody(value, conversationId));
  for (const terminal of [undefined, { event: 'done', data: { message: { id: planId, role: 'assistant', status: 'complete' } } } as StreamEvent, { event: 'done', data: { message: { id: messageId, role: 'assistant', status: 'failed' } } } as StreamEvent]) {
    const client: Pick<BoundPlatformClient, 'isCurrent' | 'streamMessage'> = { isCurrent: () => true, async streamMessage(_id, _body, _signal, event) { event({ event: 'start', data: { messageId } }); if (terminal) event(terminal); } };
    await assert.rejects(streamGoalPlanAnalysis(client, continuation, conversationId, new AbortController().signal, () => true, () => {}));
  }
});

test('navigation/account invalidation drops late analysis events and never retries the model request', async () => {
  for (const invalidateAccount of [false, true]) {
    let account = true, selected = true, calls = 0; const pending = deferred<void>(), observed: StreamEvent[] = [];
    const client: Pick<BoundPlatformClient, 'isCurrent' | 'streamMessage'> = { isCurrent: () => account, async streamMessage(_id, _body, _signal, event) { calls++; await pending.promise; event({ event: 'start', data: { messageId } }); event(done); } };
    const result = streamGoalPlanAnalysis(client, continuation, conversationId, new AbortController().signal, () => selected, (event) => observed.push(event));
    if (invalidateAccount) account = false; else selected = false; pending.resolve(); assert.equal(await result, 'discarded'); assert.equal(observed.length, 0); assert.equal(calls, 1);
  }
});

test('stale analysis and an already-aborted operation emit no request', async () => {
  let calls = 0; const client: Pick<BoundPlatformClient, 'isCurrent' | 'streamMessage'> = { isCurrent: () => true, async streamMessage() { calls++; } };
  await assert.rejects(streamGoalPlanAnalysis(client, continuation, conversationId, new AbortController().signal, () => false, () => {}));
  const controller = new AbortController(); controller.abort(); await assert.rejects(streamGoalPlanAnalysis(client, continuation, conversationId, controller.signal, () => true, () => {})); assert.equal(calls, 0);
});
