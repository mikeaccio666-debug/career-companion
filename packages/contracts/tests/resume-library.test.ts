import { describe, expect, it } from 'vitest';

import {
  AGENT_ENDPOINTS,
  AGENT_ENDPOINT_ERROR_CODES,
  parseResumeLibrarySnapshotV1,
  RESUME_LIBRARY_CACHE_POLICY,
  RESUME_LIBRARY_MAX_ACTIVE_TRACKS,
  RESUME_LIBRARY_MAX_TRACKS,
  RESUME_LIBRARY_MAX_VERSIONS_PER_TRACK,
} from '../src/index.ts';

describe('T9 Resume Library core contract', () => {
  it('pins bounded owner-only metadata without resume content or storage material', () => {
    expect(RESUME_LIBRARY_MAX_ACTIVE_TRACKS).toBe(5);
    expect(RESUME_LIBRARY_MAX_TRACKS).toBe(50);
    expect(RESUME_LIBRARY_MAX_VERSIONS_PER_TRACK).toBe(101);
    expect(RESUME_LIBRARY_CACHE_POLICY).toEqual({
      responseHeaders: {
        'Cache-Control': 'private, no-store, no-transform',
        Pragma: 'no-cache',
        Expires: '0',
      },
      etag: 'forbidden',
    });

    const response = librarySnapshot();
    expect(parseResumeLibrarySnapshotV1(response)).toEqual(response);
    // 2026-09-28：应答里多出来的成员不拒整份（「我的资料」的简历列表不该因为后端多给一样东西就读不出），
    // 但也**不往下传**：解析结果只从认得的字段重建，存储路径一类的东西到不了任何消费方。
    const withStorage = parseResumeLibrarySnapshotV1({
      ...response,
      tracks: [{
        ...response.tracks[0],
        versions: [{ ...response.tracks[0]!.versions[0], storageKey: 'private/a.pdf' }, response.tracks[0]!.versions[1]],
      }],
    });
    expect(withStorage).toEqual(response);
    expect(JSON.stringify(withStorage)).not.toContain('storageKey');
    expect(parseResumeLibrarySnapshotV1({
      ...response,
      tracks: [{ ...response.tracks[0], isDefault: false }],
    })).toBeNull();
    expect(parseResumeLibrarySnapshotV1({
      ...response,
      tracks: [{
        ...response.tracks[0],
        currentVersionId: '20000000-0000-4000-8000-000000000099',
      }],
    })).toBeNull();
    expect(parseResumeLibrarySnapshotV1({
      ...response,
      defaultTrackId: null,
      tracks: [{ ...response.tracks[0], isDefault: false }],
    })).toBeNull();
    expect(parseResumeLibrarySnapshotV1({
      ...response,
      tracks: [{
        ...response.tracks[0],
        versions: response.tracks[0]!.versions.map((version) =>
          version.isCurrent
            ? { ...version, lifecycleStatus: 'PROCESSING' }
            : version),
      }],
    })).toBeNull();
  });

  /**
   * 后端先发的加法（2026-09-28）：新的版本来源（比如为某个岗位改写出来的那一种）、新的生命周期状态、
   * 任何一层多一个字段。在此之前任何一样都让「我的资料」的简历列表整个读不出。现在：多出来的成员不解释、
   * 不转发；长得像枚举的陌生来源与状态原样留着——消费方只拿已知值比对（选简历只认 READY），陌生状态
   * 因此永远不会被当成「可用」。「当前版本必须 READY」「默认简历恰好一份」这些不变量照旧。
   */
  it('tolerates additive members, unknown origins and unknown lifecycle states without treating them as ready', () => {
    const response = librarySnapshot();
    const [current, older] = response.tracks[0]!.versions;
    const future = {
      ...response,
      nextCursor: null,
      tracks: [{
        ...response.tracks[0],
        pinned: false,
        versions: [
          { ...current, origin: 'JOB_TAILORED', tailoredFor: { jobId: 'j-1' } },
          { ...older, lifecycleStatus: 'QUARANTINED' },
        ],
      }],
    };
    const parsed = parseResumeLibrarySnapshotV1(future);
    expect(parsed).not.toBeNull();
    expect(parsed!.tracks[0]!.versions.map((version) => [version.origin, version.lifecycleStatus])).toEqual([
      ['JOB_TAILORED', 'READY'],
      ['UPLOAD', 'QUARANTINED'],
    ]);
    expect(JSON.stringify(parsed)).not.toMatch(/nextCursor|pinned|tailoredFor/u);
    // 当前版本是陌生状态：不是 READY，照旧整份不要（不变量没有放松）。
    expect(parseResumeLibrarySnapshotV1({
      ...response,
      tracks: [{ ...response.tracks[0], versions: [{ ...current, lifecycleStatus: 'QUARANTINED' }, older] }],
    })).toBeNull();
    // 不像枚举的值是坏数据，不是新版本。
    for (const bad of [{ origin: 'job tailored' }, { lifecycleStatus: 'ready' }, { origin: 7 }]) {
      expect(parseResumeLibrarySnapshotV1({
        ...response,
        tracks: [{ ...response.tracks[0], versions: [{ ...current, ...bad }, older] }],
      }), JSON.stringify(bad)).toBeNull();
    }
  });

  it('registers exact read and mutation endpoints with stable fail-closed errors', () => {
    expect(AGENT_ENDPOINTS.getResumeLibrary).toMatchObject({
      method: 'GET',
      path: '/api/v1/agent/resume-library',
      sourceSection: '4.9',
      auth: 'bearer',
      callerConstraint: 'owner-bearer',
      responseCache: RESUME_LIBRARY_CACHE_POLICY,
    });
    expect(AGENT_ENDPOINTS.createResumeTrack.path).toBe(
      '/api/v1/agent/resume-library/tracks',
    );
    expect(AGENT_ENDPOINTS.setResumeTrackCurrentVersion.path).toBe(
      '/api/v1/agent/resume-library/tracks/:trackId/versions/:resumeVersionId/current',
    );
    for (const endpoint of [
      AGENT_ENDPOINTS.createResumeTrack,
      AGENT_ENDPOINTS.renameResumeTrack,
      AGENT_ENDPOINTS.archiveResumeTrack,
      AGENT_ENDPOINTS.restoreResumeTrack,
      AGENT_ENDPOINTS.setDefaultResumeTrack,
      AGENT_ENDPOINTS.setResumeTrackCurrentVersion,
    ]) {
      expect(endpoint).toMatchObject({ responseCache: RESUME_LIBRARY_CACHE_POLICY });
    }
    expect(AGENT_ENDPOINT_ERROR_CODES.createResumeTrack).toEqual(expect.arrayContaining([
      'LIBRARY_REVISION_MISMATCH',
      'RESUME_TRACK_LIMIT_REACHED',
      'AGENT_UNAVAILABLE',
    ]));
    expect(AGENT_ENDPOINT_ERROR_CODES.setResumeTrackCurrentVersion).toEqual(
      expect.arrayContaining([
        'RESUME_TRACK_NOT_FOUND',
        'RESUME_TRACK_ARCHIVED',
        'RESUME_VERSION_NOT_FOUND',
        'VERSION_NOT_READY',
      ]),
    );
  });
});

function librarySnapshot() {
  return {
    schemaVersion: 1,
    libraryRevision: '7',
    defaultTrackId: '10000000-0000-4000-8000-000000000001',
    tracks: [{
      trackId: '10000000-0000-4000-8000-000000000001',
      name: 'Product Manager',
      archivedAt: null,
      isDefault: true,
      currentVersionId: '20000000-0000-4000-8000-000000000002',
      hasMoreVersions: false,
      createdAt: '2026-08-20T10:00:00.000Z',
      updatedAt: '2026-08-21T10:00:00.000Z',
      versions: [
        {
          resumeVersionId: '20000000-0000-4000-8000-000000000002',
          trackId: '10000000-0000-4000-8000-000000000001',
          label: 'Acme Product Manager',
          fileName: 'acme-pm.pdf',
          mimeType: 'application/pdf',
          fileSize: 2048,
          versionNumber: 2,
          lifecycleStatus: 'READY',
          origin: 'REWRITE',
          parentVersionId: '20000000-0000-4000-8000-000000000001',
          contentRevision: '1',
          isCurrent: true,
          createdAt: '2026-08-21T10:00:00.000Z',
          updatedAt: '2026-08-21T10:00:00.000Z',
        },
        {
          resumeVersionId: '20000000-0000-4000-8000-000000000001',
          trackId: '10000000-0000-4000-8000-000000000001',
          label: 'Product Manager base',
          fileName: 'pm-base.pdf',
          mimeType: 'application/pdf',
          fileSize: 1024,
          versionNumber: 1,
          lifecycleStatus: 'READY',
          origin: 'UPLOAD',
          parentVersionId: null,
          contentRevision: '1',
          isCurrent: false,
          createdAt: '2026-08-20T10:00:00.000Z',
          updatedAt: '2026-08-20T10:00:00.000Z',
        },
      ],
    }],
  };
}
