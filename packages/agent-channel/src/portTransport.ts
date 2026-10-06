/**
 * 真实传输：chrome.runtime Port → ChannelTransport 适配器（第四刀）。
 *
 * chat 页与扩展之间的正式管道是 `externally_connectable` 的
 * runtime.connect 端口——只有 manifest 里点名的 origin 能连进来
 * （信任边界见 apps/extension/wxt.config.ts externally_connectable 与
 *  lib/buildConfig.ts 注释）。
 *
 * 这里刻意只依赖一个**最小 Port 形状**（RuntimePortLike），不 import
 * chrome 类型：①测试可注入假 Port；②适配器与外壳（WXT/manifest）解耦，
 * 外壳落地时把真实 port 塞进来即可。
 *
 * fail-closed 关键位：`onDisconnect`。MV3 service worker 会被浏览器随时
 * 回收，端口断开 = 对端世界已不可信——绑定的回调必须让运行停在下一个
 * 检查点（绝不半途提交，20 §3 已知坑）。
 */

import type { ChannelMessage } from '@edaix/contracts/draft';
import type { ChannelTransport } from './transport';

/** chrome.runtime.Port 的最小子集（结构化类型，测试可伪造）。 */
export interface RuntimePortLike {
  postMessage(message: unknown): void;
  onMessage: {
    addListener(callback: (message: unknown) => void): void;
    removeListener(callback: (message: unknown) => void): void;
  };
  onDisconnect: {
    addListener(callback: () => void): void;
    removeListener(callback: () => void): void;
  };
  disconnect(): void;
}

export interface PortTransport extends ChannelTransport {
  /** 端口断开（对端断、浏览器杀 SW、或本端 dispose）后为 true；此后 send 静默丢弃。 */
  readonly isClosed: () => boolean;
  dispose(): void;
}

export function createPortTransport(
  port: RuntimePortLike,
  hooks?: { onDisconnect?: () => void },
): PortTransport {
  const handlers = new Set<(raw: unknown) => void>();
  let closed = false;

  const onMessage = (message: unknown): void => {
    if (closed) return;
    for (const handler of handlers) handler(message);
  };

  const onDisconnect = (): void => {
    if (closed) return;
    closed = true;
    port.onMessage.removeListener(onMessage);
    port.onDisconnect.removeListener(onDisconnect);
    // 先标记关闭再通知：回调里的任何 send 都不会打到死端口上。
    hooks?.onDisconnect?.();
  };

  port.onMessage.addListener(onMessage);
  port.onDisconnect.addListener(onDisconnect);

  return {
    send(message: ChannelMessage) {
      if (closed) return; // 死端口静默丢弃；运行的停止由 onDisconnect 回调负责
      port.postMessage(message);
    },
    onMessage(handler) {
      handlers.add(handler);
      return () => handlers.delete(handler);
    },
    isClosed: () => closed,
    dispose() {
      if (closed) return;
      closed = true;
      port.onMessage.removeListener(onMessage);
      port.onDisconnect.removeListener(onDisconnect);
      port.disconnect();
    },
  };
}
