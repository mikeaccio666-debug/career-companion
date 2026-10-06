import { expect, it } from 'vitest';
import { parseAssistantJobsDeliveryRequest, parseAssistantJobDecisionRequest, parseAssistantJobsQuery } from '../src/assistant-jobs.ts';
const id = '11111111-1111-4111-8111-111111111111';
it('binds delivery to an exact Role and batch without client-supplied quantities', () => {
  expect(parseAssistantJobsDeliveryRequest({ conversationId: id, batchId: id })).not.toBeNull();
  expect(parseAssistantJobsDeliveryRequest({ conversationId: id, batchId: id, units: 0 })).toBeNull();
  expect(parseAssistantJobsDeliveryRequest({ conversationId: 'other', batchId: id })).toBeNull();
});
it('requires versioned, idempotent shortlist decisions and cannot create applications', () => {
  const value = { clientRequestId: id, expectedRevision: 1, state: 'SAVED' };
  expect(parseAssistantJobDecisionRequest(value)).not.toBeNull();
  for (const change of [{ expectedRevision: 0 }, { expectedRevision: 1.5 }, { state: 'APPLY' }, { role: 'ADMIN' }]) {
    expect(parseAssistantJobDecisionRequest({ ...value, ...change })).toBeNull();
  }
});
it('bounds owner-scoped listing and rejects unknown filters', () => {
  expect(parseAssistantJobsQuery({ conversationId: id })).not.toBeNull();
  expect(parseAssistantJobsQuery({ conversationId: id, before: id })).not.toBeNull();
  expect(parseAssistantJobsQuery({ conversationId: id, owner: id })).toBeNull();
});
