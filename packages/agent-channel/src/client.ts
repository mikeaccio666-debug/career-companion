/**
 * chat 侧通道客户端（薄）：发起运行、请求停止、订阅事件与连接状态。
 *
 * 第三刀（§4.1）：客户端**只发任务引用**（missionId/missionStepId/
 * missionRevision + clientRequestId），凭证由扩展自领——chat 网页从头到尾
 * 摸不到 JWS/lease。刻意不做状态聚合——运行状态的真相在扩展侧协调器与
 * 后端回执，chat 只是显示器。
 *
 * 连接状态（评审 Important 2）：心跳的生命周期归本客户端管——
 * startHeartbeat 后 onConnectionState 给闭集 CHANNEL_CONNECTION_STATES；
 * 判死后收到新 pong 自动回 CONNECTED（SW 冷启动醒来）。恢复策略明确为：
 * LOST 期间的 run 状态未知，chat 应从后端回执 API 对账，不自行猜测。
 */

import {
  parseChannelMessage,
  type ChannelConnectionState,
  type ChannelErrorCode,
  type ChannelEvent,
  CHANNEL_PROTOCOL_VERSION,
} from '@edaix/contracts/draft';
import type { ChannelTransport } from './transport';
import { startHeartbeat, type Heartbeat, type HeartbeatOptions } from './heartbeat';

export interface ChannelClient {
  /** 返回本次的 clientRequestId（未传则自动生成）——等 run/accepted 对账。 */
  startRun(
    missionId: string,
    missionStepId: string,
    missionRevision: string,
    clientRequestId?: string,
  ): string;
  /** Request a zero-write discovery projection for one canonical Mission target. */
  startDiscovery(
    missionId: string,
    missionRevision: string,
    expectedOwnerId: string,
    clientRequestId?: string,
  ): string;
  requestStop(runId: string): void;
  /** 订阅扩展侧事件（已过 fail-closed 解析）。返回退订函数。 */
  onEvent(handler: (event: ChannelEvent) => void): () => void;
  /** 启动探活（幂等：重复调用先停旧的）。 */
  startHeartbeat(options?: Omit<HeartbeatOptions, 'transport' | 'onDead'>): void;
  /** 连接状态（闭集 CHANNEL_CONNECTION_STATES）。订阅即回放当前状态。 */
  onConnectionState(handler: (state: ChannelConnectionState) => void): () => void;
  dispose(): void;
}

export interface ChannelClientOptions {
  /** Test seam only; production defaults to a CSPRNG UUID. */
  readonly newDiscoveryRequestId?: () => string;
}

export function createChannelClient(
  transport: ChannelTransport,
  onProtocolError?: (code: ChannelErrorCode) => void,
  options: ChannelClientOptions = {},
): ChannelClient {
  const handlers = new Set<(event: ChannelEvent) => void>();
  const stateHandlers = new Set<(state: ChannelConnectionState) => void>();
  let connectionState: ChannelConnectionState = 'CONNECTED';
  let heartbeat: Heartbeat | null = null;
  let requestSeq = 0;
  const pendingDiscoveries = new Map<string, {
    readonly missionId: string;
    readonly missionRevision: string;
  }>();
  // Never reuse a correlation inside one physical port generation. Keeping a
  // strict bound and failing closed avoids eviction turning an old ACK valid.
  const usedDiscoveryRequestIds = new Set<string>();
  const newDiscoveryRequestId = options.newDiscoveryRequestId ?? (() => crypto.randomUUID());
  const maxDiscoveryCorrelations = 256;

  function setConnectionState(state: ChannelConnectionState): void {
    if (connectionState === state) return;
    connectionState = state;
    for (const handler of stateHandlers) handler(state);
  }

  const unsubscribe = transport.onMessage((raw) => {
    const parsed = parseChannelMessage(raw);
    if (!parsed.ok) {
      onProtocolError?.(parsed.code);
      return;
    }
    const message = parsed.value;
    // 任何合法入站流量都证明对端活着（判死后 SW 醒来自动回 CONNECTED）。
    setConnectionState('CONNECTED');
    // Discovery 必须先收到同 request 的 authenticated capability ACK。
    // 任意非 READY、缺能力或重复 ACK 都只透传状态，绝不下发扫描命令。
    if (message.kind === 'channel/ready') {
      const pending = pendingDiscoveries.get(message.clientRequestId);
      if (pending !== undefined) {
        pendingDiscoveries.delete(message.clientRequestId);
        if (
          message.state === 'READY' &&
          message.capabilities.includes('DISCOVERY_V1')
        ) {
          transport.send({
            v: CHANNEL_PROTOCOL_VERSION,
            kind: 'discovery/start',
            clientRequestId: message.clientRequestId,
            missionId: pending.missionId,
            missionRevision: pending.missionRevision,
          });
        }
      }
    }
    // 客户端只消费运行事件；命令是它发的不收，心跳帧由 heartbeat 模块自理。
    if (
      message.kind === 'channel/hello' ||
      message.kind === 'run/start' ||
      message.kind === 'run/stop' ||
      message.kind === 'discovery/start'
    ) return;
    if (message.kind === 'channel/ping' || message.kind === 'channel/pong') return;
    for (const handler of handlers) handler(message);
  });

  return {
    startRun(missionId, missionStepId, missionRevision, clientRequestId) {
      const requestId = clientRequestId ?? `req_${++requestSeq}`;
      transport.send({
        v: CHANNEL_PROTOCOL_VERSION,
        kind: 'run/start',
        clientRequestId: requestId,
        missionId,
        missionStepId,
        missionRevision,
      });
      return requestId;
    },
    startDiscovery(missionId, missionRevision, expectedOwnerId, clientRequestId) {
      let requestId: string;
      try {
        requestId = clientRequestId ?? newDiscoveryRequestId();
      } catch {
        return '';
      }
      if (
        usedDiscoveryRequestIds.has(requestId) ||
        usedDiscoveryRequestIds.size >= maxDiscoveryCorrelations
      ) return '';
      const hello = {
        v: CHANNEL_PROTOCOL_VERSION,
        kind: 'channel/hello',
        clientRequestId: requestId,
        expectedOwnerId,
        // 只点名这一步要的能力（2026-09-24，与门户同一口径）：词汇表里还有别的词，
        // 点名一个对端不会做的能力只会让握手白走一趟。
        requiredCapabilities: ['DISCOVERY_V1'],
      } as const;
      if (!parseChannelMessage(hello).ok) return '';
      usedDiscoveryRequestIds.add(requestId);
      pendingDiscoveries.set(requestId, { missionId, missionRevision });
      try {
        transport.send(hello);
      } catch {
        pendingDiscoveries.delete(requestId);
        return '';
      }
      return requestId;
    },
    requestStop(runId) {
      transport.send({ v: CHANNEL_PROTOCOL_VERSION, kind: 'run/stop', runId });
    },
    onEvent(handler) {
      handlers.add(handler);
      return () => handlers.delete(handler);
    },
    startHeartbeat(options = {}) {
      heartbeat?.stop();
      heartbeat = startHeartbeat({
        ...options,
        transport,
        onDead: () => setConnectionState('LOST'),
      });
    },
    onConnectionState(handler) {
      stateHandlers.add(handler);
      handler(connectionState);
      return () => stateHandlers.delete(handler);
    },
    dispose() {
      heartbeat?.stop();
      heartbeat = null;
      pendingDiscoveries.clear();
      usedDiscoveryRequestIds.clear();
      handlers.clear();
      stateHandlers.clear();
      unsubscribe();
    },
  };
}
