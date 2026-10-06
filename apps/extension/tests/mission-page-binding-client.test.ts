import { describe, expect, it, vi } from 'vitest';

import { createMissionPageBindingClient } from '../lib/missionPageBindingClient';
import { installBundledApplyAdapters } from '@edaix/apply-kernel/bundledAdapters';

// 识别路径的适配器表生产由后端 release 装配；单测不连后端，装随包内置那份。
installBundledApplyAdapters();

const PAGE = Object.freeze({
  canonicalOrigin: 'https://boards.greenhouse.io',
  pathname: '/acme/jobs/123',
});
// Synthetic ids only.
const BINDING = Object.freeze({
  missionId: '00000000-0000-4000-8000-000000000001',
  missionRevision: '3',
  status: 'QUEUED',
  job: { title: 'Business Analyst', company: 'Acme' },
  target: { ...PAGE, atsProvider: 'GREENHOUSE' },
  application: {
    canonicalJobId: '00000000-0000-4000-8000-000000000002',
    canonicalJobStatus: 'OPEN',
    lastVerifiedAt: '2026-09-24T10:00:00.000Z',
    applicationId: '00000000-0000-4000-8000-000000000003',
    applicationBundleVersion: '1',
    applicationRevision: '1',
    submissionState: 'ELIGIBLE',
  },
  startApproval: 'AVAILABLE',
});
const client = (fetchFn: typeof fetch, refreshAccessToken = vi.fn()) =>
  createMissionPageBindingClient({
    apiBase: 'https://api.edaix.io',
    getAccessToken: vi.fn().mockResolvedValue('token'),
    refreshAccessToken,
    fetchFn,
  });
// A fresh Response per call: a body can be read once.
const answer = (body: unknown, status = 200) =>
  vi.fn().mockImplementation(async () => new Response(JSON.stringify(body), { status }));

// 2026-09-24：从 GET「有没有」改成 POST「是哪一个任务」（argoland §4.15）。GET 那一版后端从没实现。
describe('Mission page binding client', () => {
  it('asks the owner-scoped read about exactly this page and returns the bound Mission', async () => {
    const fetchFn = answer({ schemaVersion: 1, binding: BINDING });

    await expect(client(fetchFn).resolve(PAGE)).resolves.toEqual(BINDING);
    await expect(client(fetchFn).isBound(PAGE)).resolves.toBe(true);

    const [url, init] = fetchFn.mock.calls[0] as [string, RequestInit];
    expect(new URL(url).pathname).toBe('/api/v1/agent/missions/page-binding');
    expect(new URL(url).search).toBe('');
    expect(init).toMatchObject({
      method: 'POST',
      cache: 'no-store',
      headers: expect.objectContaining({ authorization: 'Bearer token', 'content-type': 'application/json' }),
    });
    expect(JSON.parse(init.body as string)).toEqual({ schemaVersion: 1, ...PAGE });
  });

  it('retries one LOGIN_REQUIRED response with a refreshed token', async () => {
    const fetchFn = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ code: 'LOGIN_REQUIRED' }), { status: 401 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ schemaVersion: 1, binding: BINDING }), { status: 200 }));

    await expect(client(fetchFn, vi.fn().mockResolvedValue('fresh')).isBound(PAGE)).resolves.toBe(true);
    expect((fetchFn.mock.calls[1]?.[1] as RequestInit).headers)
      .toMatchObject({ authorization: 'Bearer fresh' });
  });

  it.each([
    ['no binding', { schemaVersion: 1, binding: null }, 200],
    ['a server fault', { code: 'INTERNAL_ERROR' }, 500],
    ['the old boolean shape', { schemaVersion: 1, bound: true }, 200],
    ['a binding for another page', { schemaVersion: 1, binding: { ...BINDING, target: { ...BINDING.target, pathname: '/acme/jobs/999' } } }, 200],
    ['a binding with an unknown Start state', { schemaVersion: 1, binding: { ...BINDING, startApproval: 'MAYBE' } }, 200],
    ['a binding carrying anything more', { schemaVersion: 1, binding: { ...BINDING, resumeVersionId: 'r1' } }, 200],
  ])('fails closed on %s', async (_label, body, status) => {
    await expect(client(answer(body, status)).resolve(PAGE)).resolves.toBeNull();
    await expect(client(answer(body, status)).isBound(PAGE)).resolves.toBe(false);
  });

  it('fails closed when the request never settles', async () => {
    const fetchFn = vi.fn().mockReturnValue(new Promise<Response>(() => {}));
    const pending = createMissionPageBindingClient({
      apiBase: 'https://api.edaix.io',
      getAccessToken: vi.fn().mockResolvedValue('token'),
      fetchFn,
      timeoutMs: 1,
    }).isBound(PAGE);

    await expect(pending).resolves.toBe(false);
  });

  it.each([
    ['a vendor with no adapter', { canonicalOrigin: 'https://acme.wd1.myworkdayjobs.com', pathname: '/en-US/careers/job/1' }],
    ['a page that is not an application form', { ...PAGE, pathname: '/' }],
    ['an origin it cannot parse', { canonicalOrigin: 'not a url', pathname: '/acme/jobs/123' }],
  ])('never asks the backend about %s', async (_label, page) => {
    const fetchFn = answer({ schemaVersion: 1, binding: BINDING });

    await expect(client(fetchFn).isBound(page)).resolves.toBe(false);
    expect(fetchFn).not.toHaveBeenCalled();
  });
});
