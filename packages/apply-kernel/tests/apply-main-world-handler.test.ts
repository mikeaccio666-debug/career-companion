import { afterEach, describe, expect, it, vi } from 'vitest';

import { consumeAuthority, type HostWriteAuthority } from '../src/grant';
import { beginMainWorldReactChange } from '../src/write/mainWorldBridge';
import { installMainWorldBridge } from '../src/write/mainWorldHandler';
import {
  APPLY_MAIN_WORLD_REQUEST_EVENT,
  APPLY_MAIN_WORLD_RESPONSE_EVENT,
} from '../src/write/mainWorldProtocol';
import { createUndoJournal, type WriteTicket } from '../src/undo';
import { testAuthority } from './helpers/applyTestAuthority';

afterEach(() => {
  document.body.innerHTML = '';
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function activeAuthority(): HostWriteAuthority {
  const authority = testAuthority('main-world-handler');
  const consumed = consumeAuthority(authority);
  if (!consumed.ok) throw new Error(`test authority unexpectedly rejected: ${consumed.code}`);
  return authority;
}

function ticketFor(element: HTMLInputElement): WriteTicket {
  const journal = createUndoJournal();
  const recorded = journal.record(element);
  if (!recorded.ok) throw new Error(`test ticket unexpectedly rejected: ${recorded.code}`);
  return recorded.value;
}

function attachReactProps(
  input: HTMLInputElement,
  props: Record<string, unknown>,
): void {
  Object.defineProperty(input, '__reactProps$phaseB', {
    configurable: true,
    value: props,
  });
}

describe('MAIN-world React handler', () => {
  it('只直调当前 target 的 onChange；伪 SyntheticEvent 的 target 不可改写', async () => {
    const remove = installMainWorldBridge(document, { retryDelayMs: 1, hydrateTimeoutMs: 50 });
    const input = document.createElement('input');
    input.value = 'S0-MAIN-HANDLER-CURRENT-VALUE';
    document.body.appendChild(input);
    const onClick = vi.fn();
    let observed: Event | null = null;
    const onChange = vi.fn((event: Event) => {
      observed = event;
      expect(event.target).toBe(input);
      expect(event.currentTarget).toBe(input);
      event.preventDefault();
      expect(event.defaultPrevented).toBe(true);
      expect('persist' in event).toBe(true);
    });
    attachReactProps(input, { onChange, onClick });

    try {
      const bridge = beginMainWorldReactChange(input, activeAuthority(), ticketFor(input));
      await expect(bridge.settled).resolves.toBe('handled');
      expect(onChange).toHaveBeenCalledTimes(1);
      expect(onClick).not.toHaveBeenCalled();
      expect(Object.getOwnPropertyDescriptor(observed!, 'target')?.writable).toBe(false);
      expect(Object.getOwnPropertyDescriptor(observed!, 'currentTarget')?.writable).toBe(false);
    } finally {
      remove();
    }
  });

  it('hydration 后才出现的 React props 仍可在时限内处理', async () => {
    vi.useFakeTimers();
    const remove = installMainWorldBridge(document, { retryDelayMs: 10, hydrateTimeoutMs: 100 });
    const input = document.createElement('input');
    input.value = 'late@example.test';
    document.body.appendChild(input);
    const onChange = vi.fn();

    try {
      const bridge = beginMainWorldReactChange(input, activeAuthority(), ticketFor(input), { timeoutMs: 200 });
      attachReactProps(input, { onChange });
      await vi.advanceTimersByTimeAsync(10);
      await expect(bridge.settled).resolves.toBe('handled');
      expect(onChange).toHaveBeenCalledTimes(1);
    } finally {
      remove();
    }
  });

  it('超时或 abort 后即使稍后 hydration 也绝不再调用 handler', async () => {
    vi.useFakeTimers();
    const remove = installMainWorldBridge(document, { retryDelayMs: 10, hydrateTimeoutMs: 100 });
    const input = document.createElement('input');
    input.value = 'late@example.test';
    document.body.appendChild(input);
    const onChange = vi.fn();

    try {
      const bridge = beginMainWorldReactChange(input, activeAuthority(), ticketFor(input), { timeoutMs: 20 });
      await vi.advanceTimersByTimeAsync(20);
      await expect(bridge.settled).resolves.toBe('timeout');
      attachReactProps(input, { onChange });
      await vi.advanceTimersByTimeAsync(200);
      expect(onChange).not.toHaveBeenCalled();
    } finally {
      remove();
    }
  });

  it('即使页面伪造已处理 ACK，C6 完成后的 abort 仍会取消迟到 hydration', async () => {
    vi.useFakeTimers();
    const input = document.createElement('input');
    input.value = 'late@example.test';
    document.body.appendChild(input);
    const pageCapture = (event: Event) => {
      const detail = (event as CustomEvent<{ requestId: string; action: string }>).detail;
      if (detail.action !== 'react-change') return;
      input.dispatchEvent(new CustomEvent(APPLY_MAIN_WORLD_RESPONSE_EVENT, {
        detail: { requestId: detail.requestId, status: 'accepted' },
      }));
      input.dispatchEvent(new CustomEvent(APPLY_MAIN_WORLD_RESPONSE_EVENT, {
        detail: { requestId: detail.requestId, status: 'handled' },
      }));
    };
    document.addEventListener(APPLY_MAIN_WORLD_REQUEST_EVENT, pageCapture, true);
    const remove = installMainWorldBridge(document, { retryDelayMs: 10, hydrateTimeoutMs: 100 });
    const onChange = vi.fn();

    try {
      const bridge = beginMainWorldReactChange(input, activeAuthority(), ticketFor(input), { timeoutMs: 200 });
      await expect(bridge.settled).resolves.toBe('handled');
      bridge.abort();
      attachReactProps(input, { onChange });
      await vi.advanceTimersByTimeAsync(200);
      expect(onChange).not.toHaveBeenCalled();
    } finally {
      remove();
      document.removeEventListener(APPLY_MAIN_WORLD_REQUEST_EVENT, pageCapture, true);
    }
  });

  it('当前值在 hydration 等待期间变化时 fail-closed，不用陈旧值触发 onChange', async () => {
    vi.useFakeTimers();
    const remove = installMainWorldBridge(document, { retryDelayMs: 10, hydrateTimeoutMs: 100 });
    const input = document.createElement('input');
    input.value = 'before@example.test';
    document.body.appendChild(input);
    const onChange = vi.fn();

    try {
      const bridge = beginMainWorldReactChange(input, activeAuthority(), ticketFor(input), { timeoutMs: 200 });
      input.value = 'after@example.test';
      attachReactProps(input, { onChange });
      await vi.advanceTimersByTimeAsync(10);
      await expect(bridge.settled).resolves.toBe('stale');
      expect(onChange).not.toHaveBeenCalled();
    } finally {
      remove();
    }
  });

  it('handler 抛错时 fail-closed，不把异常伪装为已处理', async () => {
    const remove = installMainWorldBridge(document, { retryDelayMs: 1, hydrateTimeoutMs: 50 });
    const input = document.createElement('input');
    document.body.appendChild(input);
    attachReactProps(input, {
      onChange: () => {
        throw new Error('host handler failed');
      },
    });

    try {
      const bridge = beginMainWorldReactChange(input, activeAuthority(), ticketFor(input));
      await expect(bridge.settled).resolves.toBe('no-handler');
    } finally {
      remove();
    }
  });
});
