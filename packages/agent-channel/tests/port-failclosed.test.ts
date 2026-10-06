import { describe, expect, it } from 'vitest';

import type { ChannelEvent } from '@edaix/contracts/draft';
import { createChannelClient } from '../src/client';
import { createRunCoordinator, type ExecutionGrant } from '../src/coordinator';
import { startHeartbeat } from '../src/heartbeat';
import { createPortTransport, type RuntimePortLike } from '../src/portTransport';

/**
 * 第四刀特征测试：真实 Port 语义下的断连 fail-closed 与心跳探活。
 *
 * 用假 Port 对模拟 chrome.runtime 端口（异步投递、onDisconnect 双端触发），
 * 锁三件事：①端口版通道全链路等价于内存版；②端口断开 → 进行中的运行
 * 停在下一个检查点、绝不发回执（"绝不半途提交"的通道侧一半）；
 * ③心跳超时无 pong → chat 侧判失联。
 */

function createFakePortPair(): { a: RuntimePortLike; b: RuntimePortLike; severe: () => void } {
  const listeners = {
    a: { msg: new Set<(m: unknown) => void>(), dis: new Set<() => void>() },
    b: { msg: new Set<(m: unknown) => void>(), dis: new Set<() => void>() },
  };
  let severed = false;
  function make(self: 'a' | 'b', peer: 'a' | 'b'): RuntimePortLike {
    return {
      postMessage(message) {
        if (severed) return;
        queueMicrotask(() => {
          if (severed) return;
          for (const cb of listeners[peer].msg) cb(message);
        });
      },
      onMessage: {
        addListener: (cb) => listeners[self].msg.add(cb),
        removeListener: (cb) => listeners[self].msg.delete(cb),
      },
      onDisconnect: {
        addListener: (cb) => listeners[self].dis.add(cb),
        removeListener: (cb) => listeners[self].dis.delete(cb),
      },
      disconnect() {
        severe();
      },
    };
  }
  function severe(): void {
    if (severed) return;
    severed = true;
    for (const cb of [...listeners.a.dis, ...listeners.b.dis]) cb();
  }
  return { a: make('a', 'b'), b: make('b', 'a'), severe };
}

const GRANT: ExecutionGrant = {
  missionId: 'm_1',
  missionStepId: 'ms_1',
  fieldKeys: ['fullName', 'email'],
  allowedActions: ['FILL'],
  executionLease: 'lease_test_1',
  leaseExpiresAt: 2_000,
  intentVersion: 1,
  planDigest: `sha256:${'b'.repeat(64)}`,
  jobIdentityHash: `sha256:${'a'.repeat(64)}`,
  fieldSchemaVersion: 1,
  profileSnapshot: {
    revision: '7',
    deletionEpoch: '0',
    snapshotDigest: `sha256:${'c'.repeat(64)}`,
  },
};

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('Port 传输 · 断连 fail-closed · 心跳', () => {
  it('端口版通道整链路可用（等价内存版）', async () => {
    const pair = createFakePortPair();
    const chatSide = createPortTransport(pair.a);
    const extensionSide = createPortTransport(pair.b);
    const events: ChannelEvent[] = [];
    const client = createChannelClient(chatSide);
    client.onEvent((e) => events.push(e));

    createRunCoordinator({
      transport: extensionSide,
      acquirer: { acquire: async () => ({ ok: true, intent: { jws: 'x.y.z' } }) },
      scanner: { scan: async () => ({ jobId: 'j', canonicalOrigin: 'https://host.test', fieldKeys: GRANT.fieldKeys, scanDigest: 'd' }) },
      claimer: { claim: async () => ({ ok: true, grant: GRANT }) },
      filler: {
        fill: async (grant, _scan, progress) => {
          const outcomes = grant.fieldKeys.map((key) => ({ key, ok: true }) as const);
          outcomes.forEach((o) => progress.onOutcome(o));
          return outcomes;
        },
      },
      now: () => 1_500,
    });

    client.startRun('m_1', 'ms_1', '8');
    await settle();
    await settle();
    expect(events.some((e) => e.kind === 'run/receipt')).toBe(true);
  });

  it('执行中端口断开：运行停在下一检查点，绝不发回执', async () => {
    const pair = createFakePortPair();
    const chatSide = createPortTransport(pair.a);
    const events: ChannelEvent[] = [];
    const client = createChannelClient(chatSide);
    client.onEvent((e) => events.push(e));

    let releaseFill: () => void = () => {};
    const gate = new Promise<void>((resolve) => (releaseFill = resolve));
    let fillerFinished = false;

    // 扩展侧：端口断开 → dispose 协调器（fail-closed 的绑定方式）。
    const extensionSide = createPortTransport(pair.b, { onDisconnect: () => coordinator.dispose() });
    const coordinator = createRunCoordinator({
      transport: extensionSide,
      acquirer: { acquire: async () => ({ ok: true, intent: { jws: 'x' } }) },
      scanner: { scan: async () => ({ jobId: 'j', canonicalOrigin: 'https://host.test', fieldKeys: GRANT.fieldKeys, scanDigest: 'd' }) },
      claimer: { claim: async () => ({ ok: true, grant: GRANT }) },
      filler: {
        fill: async (grant, _scan, progress) => {
          progress.onOutcome({ key: grant.fieldKeys[0]!, ok: true });
          await gate; // 卡在半途，等测试掐断端口
          if (progress.shouldStop()) return [{ key: grant.fieldKeys[0]!, ok: true }];
          fillerFinished = true;
          return grant.fieldKeys.map((key) => ({ key, ok: true }));
        },
      },
      now: () => 1_500,
    });

    client.startRun('m_1', 'ms_1', '8');
    await settle();
    pair.severe(); // 模拟 SW 被杀 / 页面关闭
    releaseFill();
    await settle();
    await settle();

    // 检查点看到 shouldStop=true：不再继续填、也没有任何回执能穿过死端口。
    expect(fillerFinished).toBe(false);
    expect(events.some((e) => e.kind === 'run/receipt')).toBe(false);
    expect(extensionSide.isClosed()).toBe(true);
  });

  it('心跳：pong 正常则一直活，超时无 pong 判失联', async () => {
    const pair = createFakePortPair();
    const chatSide = createPortTransport(pair.a);
    const extensionSide = createPortTransport(pair.b);
    // 扩展侧只挂协调器（自动回 pong），不跑任何运行。
    const coordinator = createRunCoordinator({
      transport: extensionSide,
      acquirer: { acquire: async () => ({ ok: false }) },
      scanner: { scan: async () => null },
      claimer: { claim: async () => ({ ok: false, code: 'INTENT_REJECTED' }) },
      filler: { fill: async () => [] },
    });

    let clockMs = 0;
    const ticks: Array<() => void> = [];
    let dead = false;
    startHeartbeat({
      transport: chatSide,
      intervalMs: 10,
      timeoutMs: 25,
      onDead: () => (dead = true),
      setIntervalFn: (fn) => (ticks.push(fn), 0),
      clearIntervalFn: () => {},
      nowMs: () => clockMs,
    });
    const tick = async (advanceMs: number) => {
      clockMs += advanceMs;
      ticks[0]!();
      await settle();
      await settle();
    };

    // 对端活着：每次 ping 都有 pong，永不判死。
    await tick(10);
    await tick(10);
    await tick(10);
    expect(dead).toBe(false);

    // 掐断对端：pong 停了，超时后 onDead 触发。
    coordinator.dispose();
    extensionSide.dispose();
    await tick(10);
    expect(dead).toBe(false); // 刚过一个间隔，未到判死线
    await tick(20); // 距最后一次 pong 已 >= 25ms
    expect(dead).toBe(true);
  });
});
