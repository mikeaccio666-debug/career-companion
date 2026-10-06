import { describe, expect, it } from 'vitest';
import { parseApplicationPreparationsResponse, parseRetryApplicationPreparationRequest } from '../src/applicationPreparations.ts';

const uuid = (n: number) => `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const item = { preparationId: uuid(1), itemId: uuid(2), revision: '1', status: 'QUEUED',
  failureCode: null, retryable: false, resumeVersionId: null, missionId: null, updatedAt: '2026-09-10T09:00:00.000Z' };
const response = { schemaVersion: 1, batchId: uuid(3), conversationId: uuid(4), items: [item] };

describe('durable per-job preparation wire', () => {
  it('accepts queued, failed-with-saved-CV and ready projections', () => {
    expect(parseApplicationPreparationsResponse(response)).not.toBeNull();
    expect(parseApplicationPreparationsResponse({ ...response, items: [{ ...item, status: 'FAILED',
      failureCode: 'MISSION_UNAVAILABLE', resumeVersionId: uuid(5) }] })).not.toBeNull();
    expect(parseApplicationPreparationsResponse({ ...response, items: [{ ...item, status: 'READY',
      resumeVersionId: uuid(5), missionId: uuid(6) }] })).not.toBeNull();
  });

  it('rejects false completion, free-form errors, duplicate identities and unbounded data', () => {
    for (const invalid of [
      { ...response, body: 'unexpected' },
      { ...response, items: [{ ...item, status: 'READY' }] },
      { ...response, items: [{ ...item, status: 'GENERATING_RESUME', missionId: uuid(6) }] },
      { ...response, items: [{ ...item, status: 'FAILED', failureCode: 'arbitrary provider text' }] },
      { ...response, items: [{ ...item, status: 'FAILED', failureCode: null }] },
      { ...response, items: [{ ...item, revision: '0' }] },
      { ...response, items: [{ ...item, retryable: true }] },
      { ...response, items: [{ ...item, retryable: 'true' }] },
      { ...response, items: [item, item] },
      { ...response, items: [item, { ...item, preparationId: uuid(8) }] },
      { ...response, items: Array.from({ length: 501 }, (_, i) => ({ ...item, preparationId: uuid(i + 10), itemId: uuid(i + 800) })) },
    ]) expect(parseApplicationPreparationsResponse(invalid)).toBeNull();
  });

  it('preserves server retry eligibility for the same closed job-unavailable reason', () => {
    for (const retryable of [false, true]) {
      const candidate = { ...response, items: [{ ...item, status: 'FAILED', failureCode: 'JOB_UNAVAILABLE', retryable }] };
      expect(parseApplicationPreparationsResponse(candidate)?.items[0]?.retryable).toBe(retryable);
    }
  });

  it('requires an explicit bounded retry identity and current revision', () => {
    const request = { clientRequestId: uuid(7), expectedRevision: '2' };
    expect(parseRetryApplicationPreparationRequest(request)).toEqual(request);
    for (const invalid of [{ ...request, force: true }, { ...request, expectedRevision: '0' },
      { ...request, expectedRevision: '9223372036854775808' }, { ...request, clientRequestId: 'bad' }]) {
      expect(parseRetryApplicationPreparationRequest(invalid)).toBeNull();
    }
  });
});
