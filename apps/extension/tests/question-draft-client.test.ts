import { describe, expect, it, vi } from 'vitest';
import { createQuestionDraftClient } from '../lib/questionDraftClient';

/**
 * 起草端点的客户端：与答案记忆同一条边界——凭据只在 worker，状态码各有各的稳定码，
 * 应答按契约解析（题目 id 对不上请求、requestId 对不上的整份不要）。
 */
const REQUEST = {
  schemaVersion: 1 as const,
  requestId: '22222222-2222-4222-8222-222222222222',
  job: { company: 'Acme', title: null, location: null },
  questions: [{ questionId: 'q1', text: 'Why Acme?', maxLength: 300 }],
};
const respond = (status: number, body: unknown) =>
  vi.fn(async () => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status }));
const client = (fetchFn: typeof fetch, token: string | null = 'tok') =>
  createQuestionDraftClient({ apiBase: 'https://api.argoland.ai', getAccessToken: async () => token, fetchFn });

describe('起草客户端', () => {
  it('200 且形状对 → 草稿；请求打的是契约里的路径、带 bearer', async () => {
    const fetchFn = respond(200, { schemaVersion: 1, ok: true, requestId: REQUEST.requestId, drafts: [{ questionId: 'q1', text: 'Because…' }] });
    expect(await client(fetchFn as never).create(REQUEST)).toEqual({ ok: true, value: [{ questionId: 'q1', text: 'Because…' }] });
    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.argoland.ai/api/v1/agent/application-question-drafts');
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer tok');
  });

  it.each([
    [401, 'AUTH_REQUIRED'], [402, 'PAYWALL_REQUIRED'], [403, 'PAYWALL_REQUIRED'], [429, 'QUOTA_EXCEEDED'], [500, 'UNAVAILABLE'],
  ])('%s → %s', async (status, code) => {
    expect(await client(respond(status, {}) as never).create(REQUEST)).toEqual({ ok: false, code });
  });

  it('没有 token → AUTH_REQUIRED，不发请求', async () => {
    const fetchFn = respond(200, {});
    expect(await client(fetchFn as never, null).create(REQUEST)).toEqual({ ok: false, code: 'AUTH_REQUIRED' });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  /**
   * 起草是计量的：额度在服务端写完草稿时就扣了。在此之前应答多一个字段（比如模型名、用量），旧包就把整份
   * 草稿判坏——钱花了，草稿一个字都拿不到（2026-09-28 起多出来的成员不拒、不转发）。
   */
  it('应答与草稿里多出来的成员不拒、也不转发', async () => {
    const fetchFn = respond(200, {
      schemaVersion: 1, ok: true, requestId: REQUEST.requestId, model: 'm', usage: { tokens: 9 },
      drafts: [{ questionId: 'q1', text: 'Because…', confidence: 0.9 }],
    });
    expect(await client(fetchFn as never).create(REQUEST)).toEqual({ ok: true, value: [{ questionId: 'q1', text: 'Because…' }] });
    expect(await client(respond(200, { schemaVersion: 1, ok: false, code: 'QUESTION_DRAFT_DISABLED', retryAfterMs: 5 }) as never).create(REQUEST))
      .toEqual({ ok: false, code: 'REJECTED' });
  });

  it('服务端说 ok:false → REJECTED；题目 id 对不上、requestId 对不上、超过 maxLength、不是 JSON → UNAVAILABLE', async () => {
    expect(await client(respond(200, { schemaVersion: 1, ok: false, code: 'QUESTION_DRAFT_DISABLED' }) as never).create(REQUEST)).toEqual({ ok: false, code: 'REJECTED' });
    expect(await client(respond(200, { schemaVersion: 1, ok: true, requestId: REQUEST.requestId, drafts: [{ questionId: 'zz', text: 'x' }] }) as never).create(REQUEST)).toEqual({ ok: false, code: 'UNAVAILABLE' });
    expect(await client(respond(200, { schemaVersion: 1, ok: true, requestId: '33333333-3333-4333-8333-333333333333', drafts: [] }) as never).create(REQUEST)).toEqual({ ok: false, code: 'UNAVAILABLE' });
    expect(await client(respond(200, { schemaVersion: 1, ok: true, requestId: REQUEST.requestId, drafts: [{ questionId: 'q1', text: 'x'.repeat(301) }] }) as never).create(REQUEST)).toEqual({ ok: false, code: 'UNAVAILABLE' });
    expect(await client(respond(200, 'not json') as never).create(REQUEST)).toEqual({ ok: false, code: 'UNAVAILABLE' });
  });
});
