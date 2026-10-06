import { describe, it, expect } from 'vitest';
import { parseCoverLetterProductRequestV1, parseCoverLetterRequirementRequestV1 } from '../src/coverLetterProduct.ts';
import { parseCoverLetterProductRequestV2, parseCoverLetterProductResultV2, parseCoverLetterRequirementRequestV2,
  parseCoverLetterRequirementResultV2 } from '../src/coverLetterProductV2.ts';

const request = { schemaVersion: 2, revisionDialect: 'AGGREGATE_V1', statusProjectionRevision: '7',
  clientRequestId: '11111111-1111-4111-8111-111111111111', jobId: 'catalog:one',
  canonicalJobId: '22222222-2222-4222-8222-222222222222', canonicalJobRevision: '42',
  requirementRevision: '1', unknownRequirementChoice: null };
describe('Cover Letter explicit aggregate product wire', () => {
  it('requires explicit V2 and never broadens old unmarked parsers', () => {
    expect(parseCoverLetterProductRequestV2(request)).toEqual(request);
    expect(parseCoverLetterProductRequestV1(request)).toBeNull();
    const requirement = { schemaVersion: 2, revisionDialect: 'AGGREGATE_V1', jobId: 'catalog:one' };
    expect(parseCoverLetterRequirementRequestV2(requirement)).toEqual(requirement);
    expect(parseCoverLetterRequirementRequestV1(requirement)).toBeNull();
    expect(parseCoverLetterProductRequestV2({ ...request, revisionDialect: undefined })).toBeNull();
    expect(parseCoverLetterProductRequestV2({ ...request, canonicalJobRevision: '0' })).toBeNull();
    expect(parseCoverLetterProductRequestV2({ ...request, statusProjectionRevision: '-1' })).toBeNull();
  });
  it('keeps all body/source digests and provenance private, and remains ephemeral', () => {
    const { unknownRequirementChoice: _choice, ...base } = request;
    const candidate = { ...base, body: 'Synthetic letter.', mimeType: 'text/plain', generatedAt: '2026-09-09T00:00:00.000Z',
      persisted: false, artifactId: null, deliveryAuthorized: false };
    expect(parseCoverLetterProductResultV2({ schemaVersion: 2, ok: true, candidate })).not.toBeNull();
    for (const extra of [{ materialSourceRevision: '8' }, { jobDescriptionDigest: `sha256:${'a'.repeat(64)}` },
      { objectRef: 'private' }, { persisted: true }, { deliveryAuthorized: true }]) {
      expect(parseCoverLetterProductResultV2({ schemaVersion: 2, ok: true, candidate: { ...candidate, ...extra } })).toBeNull();
    }
    expect(parseCoverLetterRequirementResultV2({ schemaVersion: 2, ok: true, context: {
      schemaVersion: 2, revisionDialect: 'AGGREGATE_V1', statusProjectionRevision: '7', jobId: request.jobId,
      canonicalJobId: request.canonicalJobId, canonicalJobRevision: '42', requirement: 'UNKNOWN', requirementRevision: '1' } })).not.toBeNull();
    expect(parseCoverLetterProductResultV2({ schemaVersion: 2, ok: false, code: 'COVER_LETTER_JOB_STALE' })).not.toBeNull();
  });
});
