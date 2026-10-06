import { describe, expect, it, vi } from 'vitest';

import { createProfileDirectoryCache, type SessionArea } from '../lib/profileDirectoryCache';
import type { DirectoryResponseText, ProfileDirectoryTransport, ProfileDirectoryTransportResult } from '../lib/profileDirectoryTransport';

/**
 * 「我的资料」上一次读到的那一份（2026-10-04，先显示旧的、后台换新）：worker 记在 chrome.storage.session——只在这次浏览器
 * 会话里、只在内存里，不落盘（不是 storage.local），只给读到它的那个账号；退出登录、换了账号就清掉。
 */
const text = (value: string) => value as DirectoryResponseText;

function memoryArea(): SessionArea & { store: Map<string, unknown> } {
  const store = new Map<string, unknown>();
  return {
    store,
    get: async (keys) => Object.fromEntries(keys.filter((key) => store.has(key)).map((key) => [key, store.get(key)])),
    set: async (items) => { for (const [key, value] of Object.entries(items)) store.set(key, value); },
    remove: async (keys) => { for (const key of keys) store.delete(key); },
  };
}

function harness(answers: Partial<Record<string, ProfileDirectoryTransportResult | Promise<ProfileDirectoryTransportResult>>> = {}) {
  const area = memoryArea();
  let user: string | null = 'user-a';
  let clock = 1_000;
  const diags: string[] = [];
  const inner: ProfileDirectoryTransport = {
    run: vi.fn(async (operation) => answers[operation] ?? { ok: true as const, text: text(`{"op":"${operation}"}`) }),
  };
  const cache = createProfileDirectoryCache({
    area: () => area,
    userId: async () => user,
    now: () => clock,
    onDiagnostic: (code) => diags.push(code),
  });
  const transport = cache.wrap(inner);
  const settle = async () => { for (let i = 0; i < 20; i += 1) await Promise.resolve(); };
  return {
    area, cache, transport, inner, diags, settle,
    as: (next: string | null) => { user = next; },
    tick: (ms: number) => { clock += ms; },
  };
}

describe('「我的资料」上一次读到的那一份', () => {
  it('读到的、存成的都记下来（资料、自我认同、代填授权、默认简历四样），只给读到它的那个账号', async () => {
    const h = harness();
    await h.transport.run('PROFILE_V2_READ');
    await h.transport.run('EEO_SAVE', { schemaVersion: 1 });
    await h.transport.run('SIGNING_CONSENT_REVOKE');
    await h.transport.run('RESUME_LIBRARY_READ');
    await h.settle();
    expect(await h.cache.read()).toEqual({
      PROFILE_V2: { at: 1_000, text: '{"op":"PROFILE_V2_READ"}' },
      EEO: { at: 1_000, text: '{"op":"EEO_SAVE"}' },
      SIGNING_CONSENT: { at: 1_000, text: '{"op":"SIGNING_CONSENT_REVOKE"}' },
      RESUME_LIBRARY: { at: 1_000, text: '{"op":"RESUME_LIBRARY_READ"}' },
    });
    h.as('user-b');
    expect(await h.cache.read(), '换了一个账号：上一个人的一样都拿不到').toEqual({});
    h.as(null);
    expect(await h.cache.read(), '没登录：什么都没有').toEqual({});
  });

  it('只在 storage.session 里（不落盘），换了账号读一次就把上一个人的删掉', async () => {
    const h = harness();
    await h.transport.run('PROFILE_V2_READ');
    await h.settle();
    expect([...h.area.store.keys()]).toEqual(['profileDirectoryCacheV1:PROFILE_V2']);
    h.as('user-b');
    await h.cache.read();
    await h.settle();
    expect(h.area.store.size).toBe(0);
  });

  it('请求途中换了账号：那一份不记（不知道它是谁的）', async () => {
    let release!: (value: ProfileDirectoryTransportResult) => void;
    const h = harness({ PROFILE_V2_READ: new Promise((resolve) => { release = resolve; }) });
    const pending = h.transport.run('PROFILE_V2_READ');
    await h.settle();
    h.as('user-b');
    release({ ok: true, text: text('{"who":"a"}') });
    await pending;
    await h.settle();
    expect(h.area.store.size).toBe(0);
    h.as('user-a');
    expect(await h.cache.read()).toEqual({});
  });

  it('退出登录、换账号时清掉', async () => {
    const h = harness();
    await h.transport.run('PROFILE_V2_READ');
    await h.settle();
    await h.cache.clear();
    expect(h.area.store.size).toBe(0);
    expect(await h.cache.read()).toEqual({});
  });

  it('清掉之前就在路上的答复晚到：不把上一个人的那一份写回来（退出登录后又登回同一个账号也一样）', async () => {
    let release!: (value: ProfileDirectoryTransportResult) => void;
    const h = harness({ PROFILE_V2_READ: new Promise((resolve) => { release = resolve; }) });
    const pending = h.transport.run('PROFILE_V2_READ');
    await h.settle();
    await h.cache.clear();
    release({ ok: true, text: text('{"stale":true}') });
    await pending;
    await h.settle();
    expect(h.area.store.size).toBe(0);
  });

  it('先发出的答复晚到，不盖掉后发出的那一份', async () => {
    let releaseOld!: (value: ProfileDirectoryTransportResult) => void;
    const h = harness();
    (h.inner.run as ReturnType<typeof vi.fn>)
      .mockImplementationOnce(() => new Promise((resolve) => { releaseOld = resolve; }))
      .mockImplementationOnce(async () => ({ ok: true, text: text('{"revision":"2"}') }));
    const older = h.transport.run('PROFILE_V2_READ');
    await h.settle();
    h.tick(500);
    await h.transport.run('PROFILE_V2_SAVE', { schemaVersion: 2 });
    await h.settle();
    releaseOld({ ok: true, text: text('{"revision":"1"}') });
    await older;
    await h.settle();
    expect((await h.cache.read()).PROFILE_V2).toEqual({ at: 1_500, text: '{"revision":"2"}' });
  });

  it('失败的答复、没有登记的操作都不记；请求本身原样交回', async () => {
    const h = harness({ PROFILE_V2_READ: { ok: false, code: 'TIMEOUT' } });
    expect(await h.transport.run('PROFILE_V2_READ')).toEqual({ ok: false, code: 'TIMEOUT' });
    expect(await h.transport.run('PERSONAL_READ')).toEqual({ ok: true, text: '{"op":"PERSONAL_READ"}' });
    await h.settle();
    expect(h.area.store.size).toBe(0);
  });

  it('存不下（会话存储满了、出错）：不影响请求本身，只记一个码', async () => {
    const h = harness();
    h.area.set = async () => { throw new Error('QUOTA_BYTES quota exceeded'); };
    expect(await h.transport.run('PROFILE_V2_READ')).toEqual({ ok: true, text: '{"op":"PROFILE_V2_READ"}' });
    await h.settle();
    expect(h.diags).toEqual(['PROFILE_CACHE_WRITE_FAILED']);
  });

  it('坏的记录（形状不对）当没有', async () => {
    const h = harness();
    h.area.store.set('profileDirectoryCacheV1:PROFILE_V2', { owner: 'user-a', at: 'x', text: 7 });
    expect(await h.cache.read()).toEqual({});
  });
});

describe('接线（源码形状闸）', () => {
  it('worker：资料目录经缓存那一层；会话一变（退出、换账号握手、会话被清）就清掉；先摆出来的那一份只答报到过的那一页', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const background = readFileSync(resolve(__dirname, '..', 'entrypoints', 'background.ts'), 'utf8');
    expect(background).toContain('const directory = profileDirectoryCache === null ? directoryTransport : profileDirectoryCache.wrap(directoryTransport);');
    const invalidated = background.indexOf('onSessionInvalidated: () => {');
    expect(invalidated).toBeGreaterThan(0);
    expect(background.slice(invalidated, invalidated + 160)).toContain('void profileDirectoryCache?.clear();');
    const handler = background.indexOf('if (profileDirectoryCache === null || !isDirectoryCachedRequest(message)) return;');
    expect(handler).toBeGreaterThan(0);
    const body = background.slice(handler, handler + 1200);
    expect(body).toContain('registeredExactPage(registry, tabId, senderUrl) === null');
    expect(body).toContain("code: 'PAGE_NOT_REGISTERED'");
    expect(body).toContain('profileDirectoryCache.read()');
    // 只在 storage.session：不落盘（storage.local 是持久的）。
    expect(background).toContain('area: () => browser.storage.session,');
  });
});

describe('写之前核一次是谁（源码形状闸，2026-10-04）', () => {
  it('worker：写带着的会话代号不是此刻登录的那个人就不写（SESSION_CHANGED）；内容脚本写的时候带上它认的那个人', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const background = readFileSync(resolve(__dirname, '..', 'entrypoints', 'background.ts'), 'utf8');
    const handler = background.indexOf('const request = parseDirectoryRequest(message);');
    expect(handler).toBeGreaterThan(0);
    const body = background.slice(handler, handler + 2600);
    expect(body).toContain('request.session !== undefined');
    expect(body).toContain("code: 'SESSION_CHANGED'");
    expect(body.indexOf("code: 'SESSION_CHANGED'")).toBeLessThan(body.indexOf('directory.run(request.operation, request.body)'));
    const content = readFileSync(resolve(__dirname, '..', 'entrypoints', 'apply.content.ts'), 'utf8');
    const run = content.indexOf('run: createDirectoryRun({');
    expect(run).toBeGreaterThan(0);
    expect(content.slice(run, run + 600)).toContain('session: () => sessionNow,');
  });
});
