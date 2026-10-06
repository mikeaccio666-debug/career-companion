import { fictionalProfileSnapshot } from './profile-snapshot';
import { parseResumeLibrarySnapshotV1, parseUuid } from '@edaix/contracts';
import { createProfileDirectoryClient } from '../../lib/profileDirectoryClient';
import type { DirectoryResponseText } from '../../lib/profileDirectoryTransport';
import { abortableDelay } from '../ports/assistant-ports';
import type { AssistantReadPorts, SessionIdentity } from '../features/session/read-ports';

/** Explicitly fictional session/read scenarios. Only preview and test entries may import. */
export function createSessionFixture() {
  let account: 'A' | 'B' | null = 'A', generation = 1;
  let scenario: 'normal' | 'empty' | 'processing' | 'unavailable' | 'locked' | 'slow' = 'normal';
  const identity = (): SessionIdentity | null => account ? {
    ownerId: parseUuid(account === 'A' ? '10000000-0000-4000-8000-000000000001' : '10000000-0000-4000-8000-000000000002')!, generation,
  } : null;
  const ports: AssistantReadPorts = {
    session: async () => ({ ok: true, value: identity() }),
    openPortal: async () => ({ ok: false, code: 'DISABLED' }),
    logout: async () => { account = null; generation++; return { ok: true, value: undefined }; },
    async personal(bound, signal) {
      if (!await abortableDelay(scenario === 'slow' ? 4000 : 350, signal)) return { ok: false, code: 'CANCELLED' };
      const name = bound.ownerId.endsWith('1') ? '测试用户 A' : '测试用户 B';
      const directory = createProfileDirectoryClient({ run: async () => ({ ok: true, text: JSON.stringify({
        schemaVersion: 1, revision: '1', deletionEpoch: '0', updatedAt: null,
        fields: { firstName: name, lastName: null, fullName: name, preferredName: null,
          email: bound.ownerId.endsWith('1') ? 'account-a@example.test' : 'account-b@example.test', phone: null,
          city: null, location: null, linkedinUrl: null, githubUrl: null, portfolioUrl: null },
      }) as DirectoryResponseText }) });
      const result = await directory.personal();
      return result.ok ? result : { ok: false, code: 'RESPONSE_MALFORMED' };
    },
    async profileV2(bound, signal) {
      if (!await abortableDelay(scenario === 'slow' ? 4000 : 400, signal)) return { ok: false, code: 'CANCELLED' };
      if (scenario === 'unavailable' || scenario === 'locked') return { ok: false, code: scenario === 'locked' ? 'LOCKED' : 'UNAVAILABLE' };
      const value = fictionalProfileSnapshot(bound.ownerId.endsWith('1') ? '测试用户 A' : '测试用户 B');
      return value ? { ok: true, value } : { ok: false, code: 'RESPONSE_MALFORMED' };
    },
    async resumes(_bound, signal) {
      if (!await abortableDelay(scenario === 'slow' ? 4000 : 600, signal)) return { ok: false, code: 'CANCELLED' };
      if (scenario === 'unavailable' || scenario === 'locked') return { ok: false, code: scenario === 'locked' ? 'LOCKED' : 'UNAVAILABLE' };
      const ready = scenario !== 'processing', time = '2026-09-13T00:00:00.000Z';
      const trackId = '30000000-0000-4000-8000-000000000001', versionId = '40000000-0000-4000-8000-000000000001';
      const value = parseResumeLibrarySnapshotV1({ schemaVersion: 1, libraryRevision: '1', defaultTrackId: scenario === 'empty' ? null : trackId,
        tracks: scenario === 'empty' ? [] : [{ trackId, name: '测试简历方向', archivedAt: null, isDefault: true,
          currentVersionId: ready ? versionId : null, hasMoreVersions: false, createdAt: time, updatedAt: time,
          versions: [{ resumeVersionId: versionId, trackId, label: '测试版本', fileName: 'fictional.pdf', mimeType: 'application/pdf',
            fileSize: 100, versionNumber: 1, lifecycleStatus: ready ? 'READY' : 'PROCESSING', origin: 'UPLOAD', parentVersionId: null,
            contentRevision: '1', isCurrent: ready, createdAt: time, updatedAt: time }],
        }],
      });
      return value ? { ok: true, value } : { ok: false, code: 'RESPONSE_MALFORMED' };
    },
  };
  return { ports,
    account(value: typeof account) { account = value; generation++; },
    scenario(value: typeof scenario) { scenario = value; },
  };
}
