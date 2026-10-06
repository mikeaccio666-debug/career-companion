import { vi } from 'vitest';

/**
 * 后台标签页的三样实测（2026-09-23，真实 Chrome；窗口被挡住、最小化，或按下「自动填写」之后
 * 切到了别的标签页／应用）：
 *
 *  · `document.visibilityState === 'hidden'`；
 *  · `requestAnimationFrame` 一帧都不来（等了 1.5 秒以上）；
 *  · 每个 `setTimeout` 都被压到约一秒一次（10 毫秒的计时器 1018 毫秒才到）。
 *
 * MessageChannel 的任务不受这些影响，这里也不动它。全部是合成的页面状态，不带任何真实资料。
 */

// 模块加载那一刻的真计时器：测试自己量时间、给 Promise 设上限都用它，不受下面的节流影响。
const realSetTimeout = globalThis.setTimeout;

/** 页面的可见性。`dispatch: false` 模拟 `visibilitychange` 被页面拦下、根本没送到的情形。 */
export function setVisibility(state: DocumentVisibilityState, { dispatch = true } = {}): void {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state });
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => state === 'hidden' });
  if (dispatch) document.dispatchEvent(new Event('visibilitychange'));
}

/** 拿掉上面那两个自有属性，回到环境原本的（可见）状态。 */
export function restoreVisibility(): void {
  const writable = document as unknown as Record<string, unknown>;
  delete writable.visibilityState;
  delete writable.hidden;
}

/** 后台里的动画帧：请求照收，回调永远不来。 */
export function suspendFrames(): { request: ReturnType<typeof vi.fn>; cancel: ReturnType<typeof vi.fn> } {
  const request = vi.fn((_callback: FrameRequestCallback) => 1);
  const cancel = vi.fn();
  vi.stubGlobal('requestAnimationFrame', request);
  vi.stubGlobal('cancelAnimationFrame', cancel);
  return { request, cancel };
}

/** 后台里的计时器：照样会到，只是每一个都至少拖到 `minimumMs`（真时间）。 */
export function throttleTimers(minimumMs = 1_000): void {
  const throttled = (handler: TimerHandler, timeout?: number, ...args: unknown[]) =>
    realSetTimeout(handler as (...values: unknown[]) => void, Math.max(minimumMs, timeout ?? 0), ...args);
  vi.stubGlobal('setTimeout', throttled);
}

export const PENDING = Symbol('pending');

/** 在真实时间里给它 `ms` 毫秒；到点还没落定就交回 `PENDING`。 */
export function within<T>(promise: Promise<T>, ms: number): Promise<T | typeof PENDING> {
  return Promise.race([
    promise,
    new Promise<typeof PENDING>((resolve) => { realSetTimeout(() => resolve(PENDING), ms); }),
  ]);
}

/**
 * 一个投递由测试掌控的 MessageChannel：`postMessage` 只把消息排进队，`deliver()` 才送出一条。
 * 用来模拟「宿主任务被一段长任务或冻结的标签页拖住」，以及「宿主任务根本送不到」。
 */
export function controllableMessageChannel(): { deliver: () => boolean; queued: () => number } {
  const queue: Array<() => void> = [];
  class HeldPort {
    onmessage: ((event: MessageEvent) => void) | null = null;
    peer: HeldPort | null = null;
    closed = false;
    postMessage(data: unknown): void {
      const target = this.peer;
      queue.push(() => {
        if (target === null || target.closed) return;
        target.onmessage?.({ data } as MessageEvent);
      });
    }
    close(): void { this.closed = true; }
    start(): void {}
  }
  class HeldChannel {
    readonly port1 = new HeldPort();
    readonly port2 = new HeldPort();
    constructor() {
      this.port1.peer = this.port2;
      this.port2.peer = this.port1;
    }
  }
  vi.stubGlobal('MessageChannel', HeldChannel);
  return {
    deliver: () => {
      const next = queue.shift();
      if (next === undefined) return false;
      next();
      return true;
    },
    queued: () => queue.length,
  };
}
