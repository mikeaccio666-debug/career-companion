import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';

import { createDirectoryRun } from '../lib/directoryRun';

/**
 * 面板问资料的那一道门（2026-09-27）。
 *
 * 后台只回答「报到过、而且还停在那一页」的标签页。报到表那一条丢了（别的标签页的写入冲掉、站内换路径没赶上报到），
 * 后台答 PAGE_NOT_REGISTERED——正确的动作是这一页重新报到一次再问一次，而不是让用户对着「稍后再试」干等。
 * 只重问一次；别的失败原样交回（它们各有各的话）。
 */
describe('面板问资料：这一页没登记就重新报到、再问一次', () => {
  it('第一次答没登记：重新报到一次，交回第二次的回答', async () => {
    const send = vi.fn()
      .mockResolvedValueOnce({ ok: false, code: 'PAGE_NOT_REGISTERED' })
      .mockResolvedValueOnce({ ok: true, text: '{}' });
    const rehello = vi.fn(async () => {});
    const run = createDirectoryRun({ send, rehello });
    expect(await run('PROFILE_V2_READ')).toEqual({ ok: true, text: '{}' });
    expect(rehello).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('重新报到之后还是没登记：照实交回，不转圈', async () => {
    const send = vi.fn(async () => ({ ok: false, code: 'PAGE_NOT_REGISTERED' }));
    const rehello = vi.fn(async () => {});
    const run = createDirectoryRun({ send, rehello });
    expect(await run('PROFILE_V2_READ')).toEqual({ ok: false, code: 'PAGE_NOT_REGISTERED' });
    expect(rehello).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('别的失败不重问：登录过期、服务器答不上来，各有各的话', async () => {
    for (const code of ['LOGIN_REQUIRED', 'UNAVAILABLE', 'STALE']) {
      const send = vi.fn(async () => ({ ok: false, code }));
      const rehello = vi.fn(async () => {});
      expect(await createDirectoryRun({ send, rehello })('PROFILE_V2_READ')).toEqual({ ok: false, code });
      expect(rehello).not.toHaveBeenCalled();
    }
  });

  it('后台没答（worker 没醒、通道断了）或答了认不出的东西：NO_REPLY，不当成结果', async () => {
    for (const reply of [undefined, null, 'ok', { text: '{}' }]) {
      const run = createDirectoryRun({ send: async () => reply, rehello: async () => {} });
      expect(await run('PROFILE_V2_READ')).toEqual({ ok: false, code: 'NO_REPLY' });
    }
    const throwing = createDirectoryRun({ send: async () => { throw new Error('Receiving end does not exist.'); }, rehello: async () => {} });
    expect(await throwing('PROFILE_V2_READ')).toEqual({ ok: false, code: 'NO_REPLY' });
  });

  it('重新报到失败也不挡：照样再问一次', async () => {
    const send = vi.fn()
      .mockResolvedValueOnce({ ok: false, code: 'PAGE_NOT_REGISTERED' })
      .mockResolvedValueOnce({ ok: true, text: '{}' });
    const run = createDirectoryRun({ send, rehello: async () => { throw new Error('channel'); } });
    expect(await run('PROFILE_V2_READ')).toEqual({ ok: true, text: '{}' });
  });

  it('这一版不认得的操作：一个请求都不发', async () => {
    const send = vi.fn();
    const run = createDirectoryRun({ send, rehello: async () => {} });
    expect(await run('NOT_AN_OPERATION' as never)).toEqual({ ok: false, code: 'UNAVAILABLE' });
    expect(send).not.toHaveBeenCalled();
  });

  it('申请页的内容脚本用的就是这道门', () => {
    const content = readFileSync(new URL('../entrypoints/apply.content.ts', import.meta.url), 'utf8');
    expect(content).toMatch(/createProfileDirectoryClient\(\{(?:\s*\/\/[^\n]*)*\s*run: createDirectoryRun\(/u);
  });
});

describe('写的时候带上「这是谁的资料」（2026-10-04）', () => {
  it('存（写）带上内容脚本此刻认的那个人；读不带', async () => {
    const send = vi.fn(async (_message: Readonly<Record<string, unknown>>) => ({ ok: true, text: '{}' }));
    const run = createDirectoryRun({ send, rehello: async () => {}, session: () => 'abcdefghijklmnopqrstuv' });
    await run('PROFILE_V2_SAVE', { schemaVersion: 2 });
    await run('PROFILE_V2_READ');
    expect(send.mock.calls[0]?.[0]).toEqual({ kind: 'profile-directory/run', operation: 'PROFILE_V2_SAVE', body: { schemaVersion: 2 }, session: 'abcdefghijklmnopqrstuv' });
    expect(send.mock.calls[1]?.[0]).toEqual({ kind: 'profile-directory/run', operation: 'PROFILE_V2_READ' });
  });

  it('还不知道是谁（还没报到过）：不带，照旧', async () => {
    const send = vi.fn(async (_message: Readonly<Record<string, unknown>>) => ({ ok: true, text: '{}' }));
    const run = createDirectoryRun({ send, rehello: async () => {}, session: () => undefined });
    await run('PROFILE_V2_SAVE', { schemaVersion: 2 });
    expect(send.mock.calls[0]?.[0]).toEqual({ kind: 'profile-directory/run', operation: 'PROFILE_V2_SAVE', body: { schemaVersion: 2 } });
  });
});
