import { describe, expect, it } from 'vitest';
import { APPLICATION_PROFILE_FIELD_KEYS, parseResumeLibrarySnapshotV1, type ProfileDirectoryPersonalV1 } from '@edaix/contracts';
import { emptyProfile, projectPersonal, projectResumeLibrary } from '../assistant/features/session/read-model';

const personal = {
  schemaVersion: 1, revision: '1', deletionEpoch: '0', updatedAt: null,
  fields: { ...Object.fromEntries(APPLICATION_PROFILE_FIELD_KEYS.map((key) => [key, null])),
    firstName: 'Test', lastName: 'Reader', email: 'reader@example.test', location: 'Legacy city' },
} as unknown as ProfileDirectoryPersonalV1;

export function resumeLibrary(status: 'READY' | 'PROCESSING' = 'READY') {
  const current = status === 'READY';
  const snapshot = parseResumeLibrarySnapshotV1({ schemaVersion: 1, libraryRevision: '1',
    defaultTrackId: '10000000-0000-4000-8000-000000000001', tracks: [{
      trackId: '10000000-0000-4000-8000-000000000001', name: 'Design', archivedAt: null, isDefault: true,
      currentVersionId: current ? '20000000-0000-4000-8000-000000000001' : null, hasMoreVersions: false,
      createdAt: '2026-09-13T00:00:00.000Z', updatedAt: '2026-09-13T00:00:00.000Z', versions: [{
        resumeVersionId: '20000000-0000-4000-8000-000000000001', trackId: '10000000-0000-4000-8000-000000000001',
        label: null, fileName: 'Design.pdf', mimeType: 'application/pdf', fileSize: 100, versionNumber: 1,
        lifecycleStatus: status, origin: 'UPLOAD', parentVersionId: null, contentRevision: '1', isCurrent: current,
        createdAt: '2026-09-13T00:00:00.000Z', updatedAt: '2026-09-13T00:00:00.000Z',
      }],
    }] });
  if (!snapshot) throw new Error('TEST_LIBRARY_INVALID');
  return snapshot;
}

describe('assistant owner read projections', () => {
  it('projects only supplied ordinary facts and never fills unknown facts from the preview', () => {
    const profile = projectPersonal(personal);
    expect(profile.name).toBe('Test Reader');
    expect(profile.city).toBe('Legacy city');
    expect(profile.nick).toBe('');
    expect(profile.workAuth).toBe('');
    expect(profile.race).toBe('');
    expect(profile.role).toBe('');
    expect(profile.experience).toEqual([]);
    expect(emptyProfile().email).toBe('');
  });

  it('keeps processing metadata visible without treating it as a selectable or deliverable resume', () => {
    const pending = projectResumeLibrary(resumeLibrary('PROCESSING'));
    expect(pending.options).toEqual([]);
    expect(pending.processingCount).toBe(1);
    expect(pending.selectedId).toBe('');
    const ready = projectResumeLibrary(resumeLibrary());
    expect(ready.options).toHaveLength(1);
    expect(ready.selectedId).toBe(ready.options[0]?.id);
    expect(ready.options[0]?.note).toContain('Delivery permission is checked during application');
  });
});
