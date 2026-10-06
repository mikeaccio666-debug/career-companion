import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseUuid } from '@edaix/contracts';

import { createAuthHandoffHandler, type PendingHandoff, type PendingHandoffStore } from '../lib/authHandoff';
import type { AuthClient } from '../lib/authClient';

/**
 * 刀八特征测试：门户↔扩展登录交接——state 一次性、TTL、origin 纵深复核。
 */

const PORTAL = 'https://edaix.io';
const USER_ID = parseUuid('10000000-0000-4000-8000-000000000001')!;
const INSTALL_ID = parseUuid('20000000-0000-4000-8000-000000000001')!;
const CORRELATION_ID = parseUuid('30000000-0000-4000-8000-000000000001')!;

function harness(options: {
  redeemResult?: boolean;
  clock?: { t: number };
  attestation?: Readonly<{ userId: typeof USER_ID; installId: typeof INSTALL_ID }> | null;
  store?: PendingHandoffStore;
} = {}) {
  const clock = options.clock ?? { t: 1_800_000_000 };
  const redeems: Array<{ code: string; state: string; extensionId: string }> = [];
  const attestedOwners: string[] = [];
  const diags: string[] = [];
  const authClient = {
    redeemHandoff: async (input: { code: string; state: string; extensionId: string }) => {
      redeems.push(input);
      return options.redeemResult ?? true;
    },
    attestInstallLinked: async (expectedOwnerId: string) => {
      attestedOwners.push(expectedOwnerId);
      return options.attestation === undefined
        ? { userId: USER_ID, installId: INSTALL_ID }
        : options.attestation;
    },
  } as unknown as AuthClient;

  const handle = createAuthHandoffHandler({
    authClient,
    extensionId: 'ext_1',
    allowedOrigins: [PORTAL],
    now: () => clock.t,
    onDiagnostic: (code) => diags.push(code),
    ...(options.store === undefined ? {} : { pendingStore: options.store }),
  });
  return { handle, redeems, diags, clock, attestedOwners };
}

/** storage.session 的替身：只存一个值，读写都走 Promise。 */
function sessionStore(initial: unknown = undefined) {
  const box = { value: initial as unknown };
  const store: PendingHandoffStore = {
    read: async () => box.value,
    write: async (value: PendingHandoff | null) => {
      box.value = value === null ? undefined : { ...value };
    },
  };
  return { store, box };
}

describe('登录交接消息面', () => {
  it('keeps request and ACK validation on the shared executable contract authority', () => {
    const source = readFileSync(
      new URL('../lib/authHandoff.ts', import.meta.url),
      'utf8',
    );
    expect(source).toContain('parseExtensionConnectionStatusRequest(message)');
    expect(source).toContain('return parseExtensionConnectionStatusResponse({');
  });

  it('does not start credential or install recovery merely because an MV3 worker wakes', () => {
    const background = readFileSync(
      new URL('../entrypoints/background.ts', import.meta.url),
      'utf8',
    );
    expect(background).not.toContain('authClient.ensureInstallLinked()');
  });

  it('a connection-status ACK never recovers the native submission outbox', () => {
    const background = readFileSync(
      new URL('../entrypoints/background.ts', import.meta.url),
      'utf8',
    );
    expect(background).toContain("if (kind === 'auth/handoff-complete' && response?.ok)");
    expect(background).not.toMatch(/if \(response\?\.ok\)\s*\{?\s*recoverSubmissionBoundaryOutbox/);
  });

  it('begin → 高熵一次性 state；complete 用同一 state 兑换成功', async () => {
    const h = harness();
    const begun = (await h.handle({ kind: 'auth/handoff-begin' }, PORTAL)) as {
      ok: true; extensionId: string; state: string;
    };
    expect(begun).toMatchObject({ ok: true, extensionId: 'ext_1' });
    expect(begun.state).toMatch(/^[0-9a-f]{64}$/); // 256 bit hex

    const done = await h.handle({ kind: 'auth/handoff-complete', code: 'code_1' }, PORTAL);
    expect(done).toEqual({ ok: true });
    expect(h.redeems).toEqual([{ code: 'code_1', state: begun.state, extensionId: 'ext_1' }]);

    // 一次性：同一 state 不可复用。
    const again = await h.handle({ kind: 'auth/handoff-complete', code: 'code_2' }, PORTAL);
    expect(again).toEqual({ ok: false });
    expect(h.diags).toContain('HANDOFF_NO_PENDING_STATE');
  });

  it('发信 origin 不在门户白名单 → 拒绝（manifest 之外的纵深复核）', async () => {
    const h = harness();
    expect(await h.handle({ kind: 'auth/handoff-begin' }, 'https://evil.example')).toEqual({ ok: false });
    expect(await h.handle({ kind: 'auth/handoff-begin' }, undefined)).toEqual({ ok: false });
    expect(h.diags).toEqual(['HANDOFF_SENDER_REJECTED', 'HANDOFF_SENDER_REJECTED']);
    expect(h.redeems).toHaveLength(0);
  });

  it('挂起超时 / 缺 code / 无关消息各按其道', async () => {
    const h = harness();
    await h.handle({ kind: 'auth/handoff-begin' }, PORTAL);
    h.clock.t += 601; // TTL 600s
    expect(await h.handle({ kind: 'auth/handoff-complete', code: 'late' }, PORTAL)).toEqual({ ok: false });
    expect(h.diags).toContain('HANDOFF_NO_PENDING_STATE');

    await h.handle({ kind: 'auth/handoff-begin' }, PORTAL);
    expect(await h.handle({ kind: 'auth/handoff-complete' }, PORTAL)).toEqual({ ok: false });
    expect(h.diags).toContain('HANDOFF_MALFORMED');

    // 无关消息让路（不吞其他监听器的活）。
    expect(await h.handle({ kind: 'run/start' }, PORTAL)).toBeUndefined();
    expect(await h.handle(null, PORTAL)).toBeUndefined();
  });

  it('重新 begin 替换旧挂起：complete 只认最新 state', async () => {
    const h = harness();
    await h.handle({ kind: 'auth/handoff-begin' }, PORTAL);
    const second = (await h.handle({ kind: 'auth/handoff-begin' }, PORTAL)) as { state: string };
    await h.handle({ kind: 'auth/handoff-complete', code: 'c' }, PORTAL);
    expect(h.redeems[0]!.state).toBe(second.state);
  });

  it('兑换被后端拒 → ok:false 原样传导（不粉饰）', async () => {
    const h = harness({ redeemResult: false });
    await h.handle({ kind: 'auth/handoff-begin' }, PORTAL);
    expect(await h.handle({ kind: 'auth/handoff-complete', code: 'bad' }, PORTAL)).toEqual({ ok: false });
  });

  it('only emits a versioned read-only connection ACK after fresh owner/install attestation', async () => {
    const h = harness();
    expect(await h.handle({
      kind: 'auth/connection-status',
      expectedOwnerId: USER_ID,
      correlationId: CORRELATION_ID,
    }, PORTAL)).toEqual({
      ok: true,
      protocolVersion: 1,
      extensionId: 'ext_1',
      userId: USER_ID,
      installId: INSTALL_ID,
      correlationId: CORRELATION_ID,
      capabilities: ['DISCOVERY_READ_ONLY'],
    });
    expect(h.attestedOwners).toEqual([USER_ID]);

    const unavailable = harness({ attestation: null });
    expect(await unavailable.handle({
      kind: 'auth/connection-status',
      expectedOwnerId: USER_ID,
      correlationId: CORRELATION_ID,
    }, PORTAL))
      .toEqual({ ok: false });
  });

  it('fails closed on hostile origin or any widened connection-status request', async () => {
    const h = harness();
    expect(await h.handle({
      kind: 'auth/connection-status',
      expectedOwnerId: USER_ID,
      correlationId: CORRELATION_ID,
    }, 'https://evil.example'))
      .toEqual({ ok: false });
    const hostileRequests: readonly unknown[] = [
      { kind: 'auth/connection-status' },
      { kind: 'auth/connection-status', expectedOwnerId: USER_ID },
      { kind: 'auth/connection-status', expectedOwnerId: USER_ID, correlationId: CORRELATION_ID, extra: true },
      { kind: 'auth/connection-status', expectedOwnerId: 'not-a-uuid', correlationId: CORRELATION_ID },
      { kind: 'auth/connection-status', expectedOwnerId: USER_ID, correlationId: 'not-a-uuid' },
    ];
    for (const request of hostileRequests) {
      expect(await h.handle(request, PORTAL)).toEqual({ ok: false });
    }
    expect(h.attestedOwners).toEqual([]);
    expect(h.diags).toEqual([
      'HANDOFF_SENDER_REJECTED',
      'HANDOFF_MALFORMED',
      'HANDOFF_MALFORMED',
      'HANDOFF_MALFORMED',
      'HANDOFF_MALFORMED',
      'HANDOFF_MALFORMED',
    ]);
  });
});

// ── 2026-09-20：连接门要在开门前预铸 state（P0-2）──────────────────────────
//
// /extension-auth/complete 用 URL 里的 state 去建 handoff，再把 code 发回插件；
// 插件兑换时用的是自己 pending 的 state。两者必须是同一个，所以开门那一刻就得铸好。
describe('beginPending：开门前预铸 state', () => {
  it('返回的 state 能被随后的 handoff-complete 兑换', async () => {
    const h = harness();
    const state = await h.handle.beginPending();
    expect(state).toMatch(/^[A-Za-z0-9._~-]{16,256}$/);
    const response = await h.handle({ kind: 'auth/handoff-complete', code: 'code_9' }, PORTAL);
    expect(response).toEqual({ ok: true });
    expect(h.redeems).toHaveLength(1);
    expect(h.redeems[0]).toMatchObject({ code: 'code_9', state });
  });

  it('之后再来一次 handoff-begin 会替换它（用户重试的正常路径）', async () => {
    const h = harness();
    const first = await h.handle.beginPending();
    const begun = await h.handle({ kind: 'auth/handoff-begin' }, PORTAL);
    expect(begun).toMatchObject({ ok: true });
    expect((begun as { state: string }).state).not.toBe(first);
  });
});


describe('门户 /extension-auth/complete 实际说的 wire（2026-09-21 实测：type: VIBE_*）', () => {
  it('{ type: VIBE_AUTH_HANDOFF_CODE, code, state } 与 auth/handoff-complete 同路：state 对得上就兑换', async () => {
    const h = harness();
    const state = await h.handle.beginPending();
    expect(await h.handle({ type: 'VIBE_AUTH_HANDOFF_CODE', code: 'code-1', state }, PORTAL)).toEqual({ ok: true });
    expect(h.redeems).toEqual([{ code: 'code-1', state, extensionId: 'ext_1' }]);
  });

  it('state 对不上不兑换，也不作废挂起的那一个——正确的那一页还能完成', async () => {
    const h = harness();
    const state = await h.handle.beginPending();
    expect(await h.handle({ type: 'VIBE_AUTH_HANDOFF_CODE', code: 'code-1', state: 'someone-elses-state' }, PORTAL)).toEqual({ ok: false });
    expect(h.diags).toContain('HANDOFF_STATE_MISMATCH');
    expect(h.redeems).toEqual([]);
    expect(await h.handle({ type: 'VIBE_AUTH_HANDOFF_CODE', code: 'code-1', state }, PORTAL)).toEqual({ ok: true });
  });

  it('VIBE_OPEN_OPTIONS 应答 ok（dock 没有设置页）；不认的 origin 照旧拒；别的 type 让路', async () => {
    const h = harness();
    expect(await h.handle({ type: 'VIBE_OPEN_OPTIONS' }, PORTAL)).toEqual({ ok: true });
    expect(await h.handle({ type: 'VIBE_OPEN_OPTIONS' }, 'https://evil.example')).toEqual({ ok: false });
    expect(await h.handle({ type: 'SOMETHING_ELSE' }, PORTAL)).toBeUndefined();
    expect(await h.handle({ kind: 'auth/handoff-begin', type: 'VIBE_OPEN_OPTIONS' }, PORTAL)).toMatchObject({ ok: true, extensionId: 'ext_1' });
  });
});

// ── 2026-09-23：挂起要跨 SW 重启 ────────────────────────────────────────────
//
// MV3 SW 空闲约 30 秒就被回收。装完开的连接页上，新用户要先注册或登录，回来时门户唤起的是
// 一个新 SW：内存里的挂起已经没了，从前握手必败（HANDOFF_NO_PENDING_STATE）。下面用「同一个
// store、换一个处理器实例」模拟 SW 换了实例。
describe('挂起跨 SW 重启（storage.session）', () => {
  it('新实例从 store 读回挂起的 state 兑换；兑换后 store 清空，再来一次不认', async () => {
    const { store, box } = sessionStore();
    const clock = { t: 1_800_000_000 };
    const before = harness({ store, clock });
    const state = await before.handle.beginPending();
    expect(box.value).toEqual({ state, expiresAt: clock.t + 600 });

    clock.t += 300; // 用户花了五分钟注册
    const after = harness({ store, clock });
    expect(await after.handle({ type: 'VIBE_AUTH_HANDOFF_CODE', code: 'code-1', state }, PORTAL)).toEqual({ ok: true });
    expect(after.redeems).toEqual([{ code: 'code-1', state, extensionId: 'ext_1' }]);
    expect(box.value).toBeUndefined();

    const again = harness({ store, clock });
    expect(await again.handle({ type: 'VIBE_AUTH_HANDOFF_CODE', code: 'code-2', state }, PORTAL)).toEqual({ ok: false });
    expect(again.diags).toEqual(['HANDOFF_NO_PENDING_STATE']);
    expect(again.redeems).toEqual([]);
  });

  it('没接 store 时，换了实例就兑换不了（这就是从前的样子）', async () => {
    const clock = { t: 1_800_000_000 };
    const state = await harness({ clock }).handle.beginPending();
    const after = harness({ clock });
    expect(await after.handle({ type: 'VIBE_AUTH_HANDOFF_CODE', code: 'code-1', state }, PORTAL)).toEqual({ ok: false });
    expect(after.diags).toEqual(['HANDOFF_NO_PENDING_STATE']);
  });

  it('store 里的挂起过了 TTL → 不兑换，并清掉', async () => {
    const { store, box } = sessionStore();
    const clock = { t: 1_800_000_000 };
    const state = await harness({ store, clock }).handle.beginPending();
    clock.t += 601;
    const after = harness({ store, clock });
    expect(await after.handle({ type: 'VIBE_AUTH_HANDOFF_CODE', code: 'late', state }, PORTAL)).toEqual({ ok: false });
    expect(after.diags).toEqual(['HANDOFF_NO_PENDING_STATE']);
    expect(after.redeems).toEqual([]);
    expect(box.value).toBeUndefined();
  });

  it.each([
    ['不是对象', 'deadbeefdeadbeefdeadbeef'],
    ['state 太短', { state: 'short', expiresAt: 1_800_000_600 }],
    ['到期时刻不是数', { state: 'a'.repeat(64), expiresAt: '1800000600' }],
    ['多了一个键', { state: 'a'.repeat(64), expiresAt: 1_800_000_600, code: 'x' }],
  ])('store 里的值形状不对（%s）→ 当没有，不兑换', async (_why, persisted) => {
    const { store } = sessionStore(persisted);
    const h = harness({ store });
    expect(await h.handle({ kind: 'auth/handoff-complete', code: 'code-1' }, PORTAL)).toEqual({ ok: false });
    expect(h.diags).toEqual(['HANDOFF_NO_PENDING_STATE']);
    expect(h.redeems).toEqual([]);
  });

  it('store 写不进：同一个实例里照样能兑换，并留下原因码', async () => {
    const store: PendingHandoffStore = {
      read: async () => undefined,
      write: async () => { throw new Error('QUOTA'); },
    };
    const h = harness({ store });
    const state = await h.handle.beginPending();
    expect(await h.handle({ type: 'VIBE_AUTH_HANDOFF_CODE', code: 'code-1', state }, PORTAL)).toEqual({ ok: true });
    expect(h.diags).toContain('HANDOFF_PENDING_STORE_FAILED');
  });

  it('store 读不出：换了实例就当没有挂起，并留下原因码', async () => {
    const store: PendingHandoffStore = {
      read: async () => { throw new Error('UNAVAILABLE'); },
      write: async () => undefined,
    };
    const h = harness({ store });
    expect(await h.handle({ kind: 'auth/handoff-complete', code: 'code-1' }, PORTAL)).toEqual({ ok: false });
    expect(h.diags).toEqual(['HANDOFF_PENDING_STORE_FAILED', 'HANDOFF_NO_PENDING_STATE']);
  });

  it('同一个 state 在一个实例里只兑换一次：store 的清除还没落地时，第二条消息读到旧值也不认', async () => {
    const box = { value: undefined as unknown };
    const reads: unknown[] = [];
    const clears: Array<() => void> = [];
    const store: PendingHandoffStore = {
      read: async () => {
        reads.push(box.value);
        return box.value;
      },
      write: (value) => {
        if (value !== null) {
          box.value = { ...value };
          return Promise.resolve();
        }
        // 清除迟迟不落地，直到下面统一放行。
        return new Promise<void>((resolve) => {
          clears.push(() => {
            box.value = undefined;
            resolve();
          });
        });
      },
    };
    const h = harness({ store });
    const state = await h.handle.beginPending();
    const first = h.handle({ type: 'VIBE_AUTH_HANDOFF_CODE', code: 'code-1', state }, PORTAL);
    const second = h.handle({ type: 'VIBE_AUTH_HANDOFF_CODE', code: 'code-2', state }, PORTAL);
    await new Promise((resolve) => setTimeout(resolve, 0));
    // 第二条消息确实从 store 读到了还没清掉的旧值。
    expect(reads).toEqual([{ state, expiresAt: 1_800_000_600 }]);
    for (const clear of clears) clear();
    expect(await first).toEqual({ ok: true });
    expect(await second).toEqual({ ok: false });
    expect(h.redeems.map((redeem) => redeem.code)).toEqual(['code-1']);
    expect(h.diags).toEqual(['HANDOFF_NO_PENDING_STATE']);
  });
});

describe('background 的接线', () => {
  const background = readFileSync(new URL('../entrypoints/background.ts', import.meta.url), 'utf8');

  it('交接处理器接了 storage.session 与诊断环', () => {
    expect(background).toMatch(/createAuthHandoffHandler\(\{[\s\S]*?onDiagnostic: recordDiagnostic,[\s\S]*?pendingStore: \{[\s\S]*?browser\.storage\.session/);
  });

  it('开门之前先等 state 写好', () => {
    expect(background).not.toMatch(/portalConnectUrl\([^)]*(?<!await )handleAuthMessage\.beginPending\(\)\)/);
    expect(background.match(/await handleAuthMessage\.beginPending\(\)/g)?.length).toBe(2);
  });
});
