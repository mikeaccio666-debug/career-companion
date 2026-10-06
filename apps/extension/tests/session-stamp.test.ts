import { describe, expect, it } from 'vitest';

import { SESSION_STAMP_PATTERN, createSessionStamp } from '../lib/sessionStamp';

/**
 * 「此刻登录的是谁」的不透明代号（2026-10-04）：同一个人在这次浏览器会话里一直是同一个，换了人就不同，没登录是 null；
 * 代号里看不出账号 id。
 */
function harness() {
  const store = new Map<string, unknown>();
  let user: string | null = '11111111-1111-4111-8111-111111111111';
  const stamp = createSessionStamp({
    userId: async () => user,
    area: () => ({
      get: async (keys) => Object.fromEntries(keys.filter((key) => store.has(key)).map((key) => [key, store.get(key)])),
      set: async (items) => { for (const [key, value] of Object.entries(items)) store.set(key, value); },
    }),
  });
  return { stamp, store, as: (next: string | null) => { user = next; } };
}

describe('会话代号', () => {
  it('同一个人一直是同一个；换了人就不同；没登录是 null', async () => {
    const h = harness();
    const a = await h.stamp();
    expect(a).toMatch(SESSION_STAMP_PATTERN);
    expect(await h.stamp()).toBe(a);
    h.as('22222222-2222-4222-8222-222222222222');
    const b = await h.stamp();
    expect(b).toMatch(SESSION_STAMP_PATTERN);
    expect(b).not.toBe(a);
    h.as(null);
    expect(await h.stamp()).toBeNull();
  });

  it('看不出账号 id；盐只记在会话存储里，worker 重启后同一个人还是同一个代号', async () => {
    const h = harness();
    const a = await h.stamp();
    expect(a).not.toContain('1111');
    expect([...h.store.keys()]).toEqual(['sessionStampSaltV1']);
    const restarted = createSessionStamp({
      userId: async () => '11111111-1111-4111-8111-111111111111',
      area: () => ({
        get: async (keys) => Object.fromEntries(keys.filter((key) => h.store.has(key)).map((key) => [key, h.store.get(key)])),
        set: async () => { throw new Error('不该再造一个盐'); },
      }),
    });
    expect(await restarted()).toBe(a);
  });
});
