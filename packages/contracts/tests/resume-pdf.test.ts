import { describe, expect, it } from 'vitest';
import { parseResumePdfMetadataV1, parseResumePdfReadRequestV1 } from '../src/resumePdf.ts';

const id = '11111111-1111-4111-8111-111111111111';
const metadata = {
  schemaVersion: 1, resumeVersionId: id, trackId: id, artifactId: id,
  contentRevision: '1', libraryRevision: '4', lifecycleStatus: 'READY',
  versionNumber: 2, label: 'Software Engineer', fileName: 'resume.pdf',
  mimeType: 'application/pdf', size: 1200, createdAt: '2026-08-31T00:00:00.000Z',
};

describe('owner PDF contract', () => {
  it('accepts bounded metadata, never storage, hashes or body fields', () => {
    expect(parseResumePdfMetadataV1(metadata)).toEqual(metadata);
    for (const extra of ['storageKey', 'signedUrl', 'checksum', 'contentHash', 'document']) {
      expect(parseResumePdfMetadataV1({ ...metadata, [extra]: 'private' })).toBeNull();
    }
    for (const invalid of [
      { fileName: '../resume.pdf' }, { fileName: 'resume\r\n.pdf' },
      { size: 100_000_000 }, { lifecycleStatus: 'PROCESSING' },
      { contentRevision: '-1' }, { versionNumber: 0 },
    ]) expect(parseResumePdfMetadataV1({ ...metadata, ...invalid })).toBeNull();
  });
  it('requires the exact artifact and revision snapshot, not a default/latest flag', () => {
    const body = { artifactId: id, expectedContentRevision: '1', expectedLibraryRevision: '4' };
    expect(parseResumePdfReadRequestV1(body)).toEqual(body);
    expect(parseResumePdfReadRequestV1({ ...body, latest: true })).toBeNull();
    expect(parseResumePdfReadRequestV1({ ...body, artifactId: null })).toBeNull();
  });
});
