import { describe, expect, it } from 'vitest';

import {
  AGENT_ENDPOINTS,
  AGENT_ENDPOINT_ERROR_CODES,
  parseListResumeSelectionOptionsResponseV1,
  RESUME_SELECTION_CACHE_POLICY,
  RESUME_SELECTION_MAX_ACTIVE_TRACKS,
} from '../src/index.ts';

describe('ResumeVersion selection metadata contract', () => {
  it('pins the five-track product limit and private response policy', () => {
    expect(RESUME_SELECTION_MAX_ACTIVE_TRACKS).toBe(5);
    expect(RESUME_SELECTION_CACHE_POLICY).toEqual({
      responseHeaders: {
        'Cache-Control': 'private, no-store, no-transform',
        Pragma: 'no-cache',
        Expires: '0',
      },
      etag: 'forbidden',
    });
  });

  it('registers one owner-only, body-free read endpoint', () => {
    expect(AGENT_ENDPOINTS.listResumeSelectionOptions).toMatchObject({
      method: 'GET',
      path: '/api/v1/agent/resume-selection-options',
      sourceSection: '4.8',
      auth: 'bearer',
      callerConstraint: 'owner-bearer',
      successStatuses: [200],
      responseCache: RESUME_SELECTION_CACHE_POLICY,
    });
    expect(AGENT_ENDPOINT_ERROR_CODES.listResumeSelectionOptions).toContain(
      'AGENT_UNAVAILABLE',
    );
  });

  it('decodes bounded metadata; drops hidden material instead of passing it on; rejects drift', () => {
    const response = resumeSelectionResponse();

    expect(parseListResumeSelectionOptionsResponseV1(response)).toEqual(response);
    // 2026-09-28：条目里多出来的成员从前整份拒；现在丢掉、不往下传（见下面「后端先发的加法」）。
    const withHidden = parseListResumeSelectionOptionsResponseV1({
      ...response,
      items: [{ ...response.items[0], storageKey: 'private/resume.pdf' }],
    });
    expect(withHidden).toEqual(response);
    expect(JSON.stringify(withHidden)).not.toContain('private/resume.pdf');
    expect(parseListResumeSelectionOptionsResponseV1({
      ...response,
      items: Array.from({ length: 6 }, () => response.items[0]),
    })).toBeNull();
    expect(parseListResumeSelectionOptionsResponseV1({
      ...response,
      defaultResumeVersionId: '20000000-0000-4000-8000-000000000099',
    })).toBeNull();

    const hostileRevision = '9'.repeat(10_000);
    expect(() => parseListResumeSelectionOptionsResponseV1({
      ...response,
      libraryRevision: hostileRevision,
    })).not.toThrow();
    expect(parseListResumeSelectionOptionsResponseV1({
      ...response,
      libraryRevision: hostileRevision,
    })).toBeNull();
    expect(parseListResumeSelectionOptionsResponseV1({
      ...response,
      items: [{ ...response.items[0], contentRevision: hostileRevision }],
    })).toBeNull();
  });
});

/**
 * 后端先发的加法（2026-09-28）：答复多一个字段，从前旧包整份清单解不出——浮层说「暂时读不到简历」，
 * 附件路也跟着停。现在多出来的成员不解释、不往下传；认得的字段、条数上限、唯一性与默认版一致性照旧。
 */
describe('ResumeVersion selection: answers tolerate what the server adds later', () => {
  it('ignores extra members at the top level and in each item and never passes them on', () => {
    const response = resumeSelectionResponse();
    const parsed = parseListResumeSelectionOptionsResponseV1({
      ...response,
      futureField: { nested: true },
      items: [{ ...response.items[0], futureField: 2, thumbnailUrl: 'https://cdn.example/t.png' }],
    });
    expect(parsed).toEqual(response);
    expect(JSON.stringify(parsed)).not.toContain('futureField');
    expect(JSON.stringify(parsed)).not.toContain('thumbnailUrl');
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(Object.isFrozen(parsed?.items)).toBe(true);
    expect(Object.isFrozen(parsed?.items[0])).toBe(true);
  });

  it('still checks every known field, the item cap, uniqueness and the default', () => {
    const response = resumeSelectionResponse();
    const item = response.items[0]!;
    const second = {
      ...item,
      trackId: '10000000-0000-4000-8000-000000000002',
      resumeVersionId: '20000000-0000-4000-8000-000000000002',
      isDefault: false,
    };
    const extra = { futureField: 1 };
    const six = [item, ...Array.from({ length: 5 }, (_, index) => ({
      ...second,
      trackId: `10000000-0000-4000-8000-00000000010${index}`,
      resumeVersionId: `20000000-0000-4000-8000-00000000010${index}`,
    }))].map((option) => ({ ...option, ...extra }));
    // 对照：两条、五条都收下（多出来的照样丢掉），下面每一条只因它点名的那一处被拒。
    expect(parseListResumeSelectionOptionsResponseV1({ ...response, ...extra, items: [{ ...item, ...extra }, { ...second, ...extra }] }))
      .toEqual({ ...response, items: [item, second] });
    expect(parseListResumeSelectionOptionsResponseV1({ ...response, items: six.slice(0, 5) })?.items).toHaveLength(5);
    for (const bad of [
      { ...response, schemaVersion: 2 },
      { ...response, libraryRevision: '07' },
      { ...response, libraryRevision: 7 },
      { ...response, defaultResumeVersionId: 'latest' },
      { ...response, items: 'nope' },
      { ...response, items: six },
      { ...response, items: [{ ...item, ...extra, trackId: 'x' }] },
      { ...response, items: [{ ...item, ...extra, trackName: '   ' }] },
      { ...response, items: [{ ...item, ...extra, label: 'x'.repeat(161) }] },
      { ...response, items: [{ ...item, ...extra, fileName: 'a\u0000.pdf' }] },
      { ...response, items: [{ ...item, ...extra, fileSize: 0 }] },
      { ...response, items: [{ ...item, ...extra, versionNumber: 1.5 }] },
      { ...response, items: [{ ...item, ...extra, isDefault: 'yes' }] },
      { ...response, items: [{ ...item, ...extra, updatedAt: 'yesterday' }] },
      // 同一条轨道或同一版出现两次。
      { ...response, items: [{ ...item, ...extra }, { ...second, ...extra, trackId: item.trackId }] },
      { ...response, items: [{ ...item, ...extra }, { ...second, ...extra, resumeVersionId: item.resumeVersionId }] },
      // 默认版：说了有却没有一条标默认、标了默认却说没有、默认的那条不在第一位。
      { ...response, items: [{ ...item, ...extra, isDefault: false }] },
      { ...response, defaultResumeVersionId: null, items: [{ ...item, ...extra }] },
      { ...response, defaultResumeVersionId: second.resumeVersionId, items: [{ ...item, ...extra, isDefault: false }, { ...second, ...extra, isDefault: true }] },
    ]) {
      expect(parseListResumeSelectionOptionsResponseV1({ ...bad, ...extra }), JSON.stringify(bad).slice(0, 80)).toBeNull();
    }
    for (const key of Object.keys(response)) {
      const value: Record<string, unknown> = { ...response, ...extra };
      delete value[key];
      expect(parseListResumeSelectionOptionsResponseV1(value), key).toBeNull();
    }
    for (const key of Object.keys(item)) {
      const value: Record<string, unknown> = { ...item, ...extra };
      delete value[key];
      expect(parseListResumeSelectionOptionsResponseV1({ ...response, items: [value] }), key).toBeNull();
    }
  });

  it('answers are still plain JSON objects; prototype-shaped member names are refused', () => {
    const response = resumeSelectionResponse();
    for (const key of ['__proto__', 'constructor', 'prototype']) {
      const member = `"${key}":{"isDefault":true}`;
      expect(parseListResumeSelectionOptionsResponseV1(JSON.parse(`{${JSON.stringify(response).slice(1, -1)},${member}}`))).toBeNull();
      const item = `{${JSON.stringify(response.items[0]).slice(1, -1)},${member}}`;
      expect(parseListResumeSelectionOptionsResponseV1({ ...response, items: [JSON.parse(item)] })).toBeNull();
    }
    expect(parseListResumeSelectionOptionsResponseV1(Object.assign(Object.create({ inherited: true }), response))).toBeNull();
    expect(parseListResumeSelectionOptionsResponseV1({
      ...response,
      items: [Object.assign(Object.create({ inherited: true }), response.items[0])],
    })).toBeNull();
  });
});

function resumeSelectionResponse() {
  return {
    schemaVersion: 1,
    libraryRevision: '7',
    defaultResumeVersionId: '20000000-0000-4000-8000-000000000001',
    items: [{
      trackId: '10000000-0000-4000-8000-000000000001',
      trackName: 'Product Manager',
      resumeVersionId: '20000000-0000-4000-8000-000000000001',
      label: 'PM final',
      fileName: 'pm-resume.pdf',
      mimeType: 'application/pdf',
      fileSize: 2048,
      versionNumber: 3,
      contentRevision: '2',
      isDefault: true,
      createdAt: '2026-08-20T10:00:00.000Z',
      updatedAt: '2026-08-21T10:00:00.000Z',
    }],
  };
}
