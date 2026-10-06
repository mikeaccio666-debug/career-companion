import { afterEach, describe, expect, it, vi } from 'vitest';

import { consumeAuthority, type HostWriteAuthority } from '../src/grant';
import {
  beginMainWorldReactChange,
  MAIN_WORLD_BRIDGE_TIMEOUT_MS,
} from '../src/write/mainWorldBridge';
import {
  APPLY_MAIN_WORLD_REQUEST_EVENT,
  APPLY_MAIN_WORLD_RESPONSE_EVENT,
} from '../src/write/mainWorldProtocol';
import { createUndoJournal, type WriteTicket } from '../src/undo';
import { testAuthority } from './helpers/applyTestAuthority';

const PROFILE_SENTINEL = 'S0-MAIN-BRIDGE-L1-SENTINEL';

afterEach(() => {
  document.body.innerHTML = '';
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function activeAuthority(): HostWriteAuthority {
  const authority = testAuthority('main-world-bridge');
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

function response(target: EventTarget, detail: unknown): void {
  target.dispatchEvent(new CustomEvent(APPLY_MAIN_WORLD_RESPONSE_EVENT, { detail }));
}

describe('MAIN-world bridge transport', () => {
  it('只向原目标发送 opaque request id 与动作，绝不把当前资料值放进 detail', async () => {
    const input = document.createElement('input');
    input.value = PROFILE_SENTINEL;
    document.body.appendChild(input);
    let requestDetail: unknown;

    input.addEventListener(APPLY_MAIN_WORLD_REQUEST_EVENT, (event) => {
      requestDetail = (event as CustomEvent).detail;
      const { requestId } = requestDetail as { requestId: string };
      response(input, { requestId, status: 'accepted' });
      response(input, { requestId, status: 'handled' });
    });

    const bridge = beginMainWorldReactChange(input, activeAuthority(), ticketFor(input));
    await expect(bridge.settled).resolves.toBe('handled');
    expect(requestDetail).toEqual({ requestId: expect.any(String), action: 'react-change' });
    expect(Object.keys(requestDetail as object).sort()).toEqual(['action', 'requestId']);
    expect(JSON.stringify(requestDetail)).not.toContain(PROFILE_SENTINEL);
  });

  it('没有 active authority 时不派发桥接请求', async () => {
    const input = document.createElement('input');
    document.body.appendChild(input);
    const received = vi.fn();
    input.addEventListener(APPLY_MAIN_WORLD_REQUEST_EVENT, received);

    const bridge = beginMainWorldReactChange(input, testAuthority('inactive-bridge'), ticketFor(input));
    await expect(bridge.settled).resolves.toBe('unavailable');
    expect(received).not.toHaveBeenCalled();
  });

  it('拒绝带额外字段的 ACK，避免页面把值或新语义塞回协议', async () => {
    const input = document.createElement('input');
    document.body.appendChild(input);
    input.addEventListener(APPLY_MAIN_WORLD_REQUEST_EVENT, (event) => {
      const { requestId } = (event as CustomEvent).detail as { requestId: string };
      response(input, { requestId, status: 'accepted' });
      response(input, { requestId, status: 'handled', value: PROFILE_SENTINEL });
    });

    const bridge = beginMainWorldReactChange(input, activeAuthority(), ticketFor(input));
    await expect(bridge.settled).resolves.toBe('invalid');
  });

  it('错误或重复 ACK 不能完成请求；超时会向同一目标发取消信号', async () => {
    vi.useFakeTimers();
    const input = document.createElement('input');
    document.body.appendChild(input);
    const actions: string[] = [];
    input.addEventListener(APPLY_MAIN_WORLD_REQUEST_EVENT, (event) => {
      const { requestId, action } = (event as CustomEvent).detail as {
        requestId: string;
        action: string;
      };
      actions.push(action);
      if (action !== 'react-change') return;
      response(input, { requestId, status: 'accepted' });
      response(input, { requestId: 'wrong-request', status: 'handled' });
      response(input, { requestId, status: 'accepted' });
    });

    const bridge = beginMainWorldReactChange(input, activeAuthority(), ticketFor(input));
    await vi.advanceTimersByTimeAsync(MAIN_WORLD_BRIDGE_TIMEOUT_MS);
    await expect(bridge.settled).resolves.toBe('timeout');
    expect(actions).toEqual(['react-change', 'cancel']);
  });

  it('调用 abort 会取消 MAIN 侧的同一 request，之后的 ACK 不会复活结果', async () => {
    const input = document.createElement('input');
    document.body.appendChild(input);
    const actions: string[] = [];
    let requestId = '';
    input.addEventListener(APPLY_MAIN_WORLD_REQUEST_EVENT, (event) => {
      const detail = (event as CustomEvent).detail as { requestId: string; action: string };
      actions.push(detail.action);
      if (detail.action !== 'react-change') return;
      requestId = detail.requestId;
      response(input, { requestId, status: 'accepted' });
    });

    const bridge = beginMainWorldReactChange(input, activeAuthority(), ticketFor(input));
    bridge.abort();
    response(input, { requestId, status: 'handled' });

    await expect(bridge.settled).resolves.toBe('aborted');
    expect(actions).toEqual(['react-change', 'cancel']);
  });
});
