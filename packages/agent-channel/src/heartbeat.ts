/**
 * 心跳（chat 侧发起，第四刀）：周期 ping，超时未见 pong 判失联。
 *
 * 双重用途（channel.ts 的 ChannelPong 注释）：
 *  ①保活 MV3 service worker——空闲 ~30s 会被浏览器回收，长流程填写期间
 *    持续的端口流量让它保持醒着；
 *  ②探活——超时收不到 pong，chat 把运行状态标为"扩展失联"（onDead），
 *    UI 据此把进度卡片切成"连接丢失"而不是永远转圈。
 *
 * 扩展侧的对应物在协调器里：收 ping 即回 pong（哪怕正在执行中——
 * 回不回得动本身就是活性信号）。计时器全部注入，测试用假时钟。
 */

import { CHANNEL_PROTOCOL_VERSION, parseChannelMessage } from '@edaix/contracts/draft';
import type { ChannelTransport } from './transport';

export interface HeartbeatOptions {
  transport: ChannelTransport;
  /** ping 间隔（默认 10s：小于 MV3 SW 的空闲回收窗口）。 */
  intervalMs?: number;
  /** 判死超时（默认 2 个间隔）。 */
  timeoutMs?: number;
  onDead: () => void;
  /** 注入计时器便于测试；默认真实 setInterval/clearInterval。 */
  setIntervalFn?: (fn: () => void, ms: number) => unknown;
  clearIntervalFn?: (handle: unknown) => void;
  nowMs?: () => number;
}

export interface Heartbeat {
  stop(): void;
}

export function startHeartbeat(options: HeartbeatOptions): Heartbeat {
  const intervalMs = options.intervalMs ?? 10_000;
  const timeoutMs = options.timeoutMs ?? intervalMs * 2;
  const setIntervalFn = options.setIntervalFn ?? ((fn, ms) => setInterval(fn, ms));
  const clearIntervalFn = options.clearIntervalFn ?? ((h) => clearInterval(h as never));
  const nowMs = options.nowMs ?? (() => Date.now());

  let seq = 0;
  let lastPongAt = nowMs();
  let dead = false;
  // 只认自己发过、尚未兑付的 seq：陈旧/伪造 pong 不能续命（评审 non-blocking）。
  const outstanding = new Set<number>();

  const unsubscribe = options.transport.onMessage((raw) => {
    const parsed = parseChannelMessage(raw);
    if (!parsed.ok || parsed.value.kind !== 'channel/pong') return;
    if (!outstanding.delete(parsed.value.seq)) return;
    lastPongAt = nowMs();
  });

  const handle = setIntervalFn(() => {
    if (dead) return;
    if (nowMs() - lastPongAt >= timeoutMs) {
      dead = true;
      stop();
      options.onDead();
      return;
    }
    seq += 1;
    outstanding.add(seq);
    options.transport.send({ v: CHANNEL_PROTOCOL_VERSION, kind: 'channel/ping', seq });
  }, intervalMs);

  function stop(): void {
    unsubscribe();
    clearIntervalFn(handle);
  }

  return { stop };
}
