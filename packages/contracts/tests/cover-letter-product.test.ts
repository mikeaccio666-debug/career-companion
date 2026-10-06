import { describe, expect, it } from 'vitest';
import { parseCoverLetterProductRequestV1, parseCoverLetterProductResultV1, parseCoverLetterRequirementResultV1 } from '../src/coverLetterProduct.ts';
const request = { clientRequestId: '11111111-1111-4111-8111-111111111111', jobId: 'catalog:one',
  canonicalJobId: '22222222-2222-4222-8222-222222222222', canonicalJobRevision: '2', requirementRevision: '1', unknownRequirementChoice: null };
const candidate = { schemaVersion: 1, ...request, body: 'Synthetic letter.', mimeType: 'text/plain',
  generatedAt: '2026-08-31T00:00:00.000Z', persisted: false, artifactId: null, deliveryAuthorized: false };
const result = () => { const { unknownRequirementChoice: _choice, ...body } = candidate; return { schemaVersion: 1, ok: true, candidate: body }; };
describe('Cover Letter product closed wire', () => {
  it('allows exact ephemeral output and closed failures', () => {
    expect(parseCoverLetterProductRequestV1(request)).not.toBeNull();
    expect(parseCoverLetterProductResultV1(result())).not.toBeNull();
    expect(parseCoverLetterProductResultV1({ schemaVersion: 1, ok: false, code: 'COVER_LETTER_JOB_STALE' })).not.toBeNull();
    expect(parseCoverLetterProductResultV1({ schemaVersion: 1, ok: false, code: 'private raw error' })).toBeNull();
  });
  it.each([{ persisted: true }, { artifactId: request.canonicalJobId }, { deliveryAuthorized: true },
    { storageKey: 'private' }, { body: 'x'.repeat(12_001) }, { mimeType: 'application/pdf' }])('rejects false persistence or unsafe extra material %o', change => {
    const value = result(); Object.assign(value.candidate, change);
    expect(parseCoverLetterProductResultV1(value)).toBeNull();
  });
  it('rejects caller JD, invalid revisions and unknown requirement', () => {
    expect(parseCoverLetterProductRequestV1({ ...request, description: 'caller JD' })).toBeNull();
    expect(parseCoverLetterProductRequestV1({ ...request, requirementRevision: '-1' })).toBeNull();
    expect(parseCoverLetterRequirementResultV1({ schemaVersion: 1, ok: true, context: { schemaVersion: 1, jobId: request.jobId,
      canonicalJobId: request.canonicalJobId, canonicalJobRevision: '2', requirementRevision: '1', requirement: 'GUESSED' } })).toBeNull();
  });
});
