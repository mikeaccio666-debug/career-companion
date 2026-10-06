import { describe, expect, it } from 'vitest';

import { parseDirectoryRequest } from '../lib/directoryRequest';

describe('what the panel may ask the worker to fetch', () => {
  // The panel names an operation, never a URL. This parser is the place that
  // stays true: an operation it cannot name reaches no route and no token.
  it('takes the eight named operations and nothing else', () => {
    expect(parseDirectoryRequest({ kind: 'profile-directory/run', operation: 'PERSONAL_READ' }))
      .toEqual({ operation: 'PERSONAL_READ', body: undefined });
    expect(parseDirectoryRequest({ kind: 'profile-directory/run', operation: 'WHATEVER_READ' })).toBeNull();
    expect(parseDirectoryRequest({ kind: 'something-else', operation: 'PERSONAL_READ' })).toBeNull();
    expect(parseDirectoryRequest({ kind: 'profile-directory/run', operation: 'PERSONAL_READ', extra: 1 }))
      .toBeNull();
    expect(parseDirectoryRequest(null)).toBeNull();
  });
});

describe('profile-directory/cached（2026-10-04）', () => {
  it('只认那一个不带值的形状', async () => {
    const { DIRECTORY_CACHED_REQUEST, isDirectoryCachedRequest } = await import('../lib/directoryRequest');
    expect(isDirectoryCachedRequest(DIRECTORY_CACHED_REQUEST)).toBe(true);
    for (const bad of [{ kind: 'profile-directory/cached', operation: 'PROFILE_V2_READ' }, { kind: 'profile-directory/run' }, {}, null, 'profile-directory/cached']) {
      expect(isDirectoryCachedRequest(bad)).toBe(false);
    }
  });
});

describe('写的时候带上「这是谁的资料」（2026-10-04）', () => {
  it('写可以带会话代号（字符串或没登录的 null）；形状不对整条不认', () => {
    const stamp = 'abcdefghijklmnopqrstuv';
    expect(parseDirectoryRequest({ kind: 'profile-directory/run', operation: 'PROFILE_V2_SAVE', body: {}, session: stamp }))
      .toEqual({ operation: 'PROFILE_V2_SAVE', body: {}, session: stamp });
    expect(parseDirectoryRequest({ kind: 'profile-directory/run', operation: 'SIGNING_CONSENT_REVOKE', session: stamp }))
      .toEqual({ operation: 'SIGNING_CONSENT_REVOKE', body: undefined, session: stamp });
    expect(parseDirectoryRequest({ kind: 'profile-directory/run', operation: 'PROFILE_V2_SAVE', body: {}, session: 'x' })).toBeNull();
    expect(parseDirectoryRequest({ kind: 'profile-directory/run', operation: 'PROFILE_V2_SAVE', body: {}, session: 7 })).toBeNull();
  });
});
