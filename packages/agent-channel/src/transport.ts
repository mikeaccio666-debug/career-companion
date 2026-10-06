/**
 * 通道传输抽象。
 *
 * 真实现（T10 后段，随 apps/extension 外壳）：chat 页 ↔ 扩展走
 * `externally_connectable` 的 runtime.connect 端口——那是一条只有指定
 * origin 能递话进扩展的通道（信任边界见 apps/extension/wxt.config.ts 的
 * externally_connectable 与 lib/buildConfig.ts 注释；生产 origin 由外壳
 * tests/api-base-gate.test.ts 锁死）。原型阶段用内存对：语义等价（异步、单向
 * 各自一条流），先把协议与状态机的行为锁死，传输层到时候只换实现。
 */

import type { ChannelMessage } from '@edaix/contracts/draft';

export interface ChannelTransport {
  /** 发给对端。原型不保证送达确认——与真实 postMessage/port 语义一致。 */
  send(message: ChannelMessage): void;
  /** 订阅对端来话。返回退订函数。入参是 unknown：解析由消费方 fail-closed 做。 */
  onMessage(handler: (raw: unknown) => void): () => void;
}

/** 内存传输对：chatSide.send → extensionSide.onMessage，反之亦然。 */
export function createMockTransportPair(): {
  chatSide: ChannelTransport;
  extensionSide: ChannelTransport;
} {
  const chatHandlers = new Set<(raw: unknown) => void>();
  const extensionHandlers = new Set<(raw: unknown) => void>();

  function deliver(handlers: Set<(raw: unknown) => void>, message: ChannelMessage): void {
    // queueMicrotask 模拟真实通道的异步性：发送方绝不能同步观察到接收方反应。
    queueMicrotask(() => {
      for (const handler of handlers) handler(message);
    });
  }

  return {
    chatSide: {
      send: (message) => deliver(extensionHandlers, message),
      onMessage: (handler) => {
        chatHandlers.add(handler);
        return () => chatHandlers.delete(handler);
      },
    },
    extensionSide: {
      send: (message) => deliver(chatHandlers, message),
      onMessage: (handler) => {
        extensionHandlers.add(handler);
        return () => extensionHandlers.delete(handler);
      },
    },
  };
}
