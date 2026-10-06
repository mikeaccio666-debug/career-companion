import { describe, expect, it, vi } from 'vitest';
import { createJobIntakeClient } from '../lib/jobIntakeClient';

const ORIGIN = 'https://job-boards.greenhouse.io';
const PATH = '/anthropic/jobs/4020567008';
/** `missions/page-context` 的答复形状（argoland 契约）。 */
const CONTEXT = Object.freeze({
  schemaVersion: 1,
  conversationId: '9fa85f64-5717-4562-b3fc-2c963f66afa6',
  canonicalJobId: '2c963f66-afa6-4562-b3fc-3fa85f645717',
  job: { jobId: 'greenhouse:anthropic:4020567008', title: 'Senior Engineer', company: 'Anthropic' },
  page: { canonicalOrigin: ORIGIN, pathname: PATH },
});

/** 投影之后交给面板的那几项。 */
const JOB = Object.freeze({
  canonicalJobId: '2c963f66-afa6-4562-b3fc-3fa85f645717',
  jobSelector: 'greenhouse:anthropic:4020567008',
  title: 'Senior Engineer',
  company: 'Anthropic',
  canonicalOrigin: ORIGIN,
  applicationPathname: PATH,
});

const client = (fetchFn: unknown, token: string | null = 'token') =>
  createJobIntakeClient({
    apiBase: 'https://api-staging.example.test',
    getAccessToken: async () => token,
    fetchFn: fetchFn as typeof fetch,
    requestId: () => '3fa85f64-5717-4562-b3fc-2c963f66afa6',
  });

const reply = (status: number, body: unknown) =>
  vi.fn(async () => ({ status, ok: status < 400, json: async () => body } as unknown as Response));

describe('createJobIntakeClient', () => {
  it('认出这一页的岗位，并只投影面板用得上的那几项', async () => {
    // conversationId 不跨这道边界：那是门户那边的东西。
    const fetchFn = reply(200, CONTEXT);
    await expect(client(fetchFn).add(ORIGIN, PATH))
      .resolves.toEqual({ kind: 'RESOLVED', job: JOB });

    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    // 2026-09-18 改指这一条：`jobs/from-url` 在 argoland 里没有控制器，生产 404。
    expect(url).toBe('https://api-staging.example.test/api/v1/agent/missions/page-context');
    // 页面由 worker 从已登记的 sender 拼出，body 里不带别的关于这个岗位的东西。
    expect(JSON.parse(init.body as string)).toEqual({
      schemaVersion: 1,
      clientRequestId: '3fa85f64-5717-4562-b3fc-2c963f66afa6',
      canonicalOrigin: ORIGIN,
      pathname: PATH,
      generationLocale: 'zh-CN',
    });
  });

  it('刚建的与本来就有的，答复形状一样——这个区别对用户没有意义', async () => {
    const fetchFn = reply(200, CONTEXT);
    await expect(client(fetchFn).add(ORIGIN, PATH))
      .resolves.toEqual({ kind: 'RESOLVED', job: JOB });
  });

  it('carries the backend refusal out as its stable code', async () => {
    const fetchFn = reply(400, { code: 'JOB_INTAKE_PROVIDER_UNSUPPORTED' });
    await expect(client(fetchFn).add('https://example.com', '/jobs/1'))
      .resolves.toEqual({ kind: 'REFUSED', code: 'JOB_INTAKE_PROVIDER_UNSUPPORTED' });
  });

  it('never reads an arbitrary string out of an error body', async () => {
    const fetchFn = reply(500, { message: 'Error: connect ECONNREFUSED 10.0.0.4:5432' });
    await expect(client(fetchFn).add(ORIGIN, PATH))
      .resolves.toEqual({ kind: 'REFUSED', code: 'JOB_INTAKE_UNAVAILABLE' });
  });

  it('refuses locally when the browser is not connected, without calling out', async () => {
    const fetchFn = reply(201, {});
    await expect(client(fetchFn, null).add(ORIGIN, PATH))
      .resolves.toEqual({ kind: 'REFUSED', code: 'JOB_INTAKE_NO_SESSION' });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('refuses a body it cannot decode rather than inventing an identity', async () => {
    const fetchFn = reply(200, { ...CONTEXT, canonicalJobId: 'nope' });
    await expect(client(fetchFn).add(ORIGIN, PATH))
      .resolves.toEqual({ kind: 'REFUSED', code: 'JOB_INTAKE_UNREADABLE' });
  });
});
