import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  classifyReadback,
  normalizeComparableValue,
  telValuesEquivalent,
  WRITE_VERIFICATION_TIMEOUT_MS,
  valuesEquivalent,
  verifyWrittenValue,
} from '../src/write/verify';

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('write verification', () => {
  it('accepts exact values and punctuation/case-only differences', () => {
    expect(valuesEquivalent('Ke Chen', 'Ke Chen')).toBe(true);
    expect(valuesEquivalent('(555) 555-0123', '555 555 0123')).toBe(true);
    expect(valuesEquivalent('José', 'JOSÉ')).toBe(true);
    expect(normalizeComparableValue(' A.B-C ')).toBe('abc');
  });

  it('does not accept prefix, suffix, or country-code changes', () => {
    expect(valuesEquivalent('555 555 0123', '+1 555 555 0123')).toBe(false);
    expect(valuesEquivalent('United States', 'United States of America')).toBe(false);
  });

  it('classifies a settled original value as reverted and other differences as mismatch', () => {
    expect(classifyReadback('new value', 'old value', 'old value')).toBe('reverted');
    expect(classifyReadback('new value', 'old value', 'something else')).toBe('mismatch');
  });

  it('settles before reading so a controlled host can render its final value', async () => {
    const order: string[] = [];
    let current = 'old';

    const result = await verifyWrittenValue({
      expected: 'new',
      previous: 'old',
      settle: async () => {
        order.push('settle');
        current = 'new';
      },
      readCurrent: () => {
        order.push('read');
        return current;
      },
    });

    expect(result).toBe('ok');
    expect(order).toEqual(['settle', 'read']);
  });

  it('waits for two animation frames and one macrotask before the final readback', async () => {
    const frames: FrameRequestCallback[] = [];
    const timers: Array<() => void> = [];
    const scheduleTimeout = vi.fn((callback: TimerHandler) => {
      if (typeof callback !== 'function') throw new Error('test scheduler only accepts callbacks');
      timers.push(callback as () => void);
      return timers.length;
    });

    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      frames.push(callback);
      return frames.length;
    });
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
    vi.stubGlobal('setTimeout', scheduleTimeout);
    vi.stubGlobal('clearTimeout', vi.fn());

    const readCurrent = vi.fn(() => 'new');
    const verification = verifyWrittenValue({
      expected: 'new',
      previous: 'old',
      readCurrent,
    });

    await Promise.resolve();
    expect(frames).toHaveLength(1);
    expect(readCurrent).not.toHaveBeenCalled();

    frames[0]!(0);
    expect(frames).toHaveLength(2);
    expect(readCurrent).not.toHaveBeenCalled();

    frames[1]!(0);
    expect(scheduleTimeout).toHaveBeenLastCalledWith(expect.any(Function), 0);
    expect(readCurrent).not.toHaveBeenCalled();

    // The first timer is the bounded watchdog; the second is C6's final
    // macrotask. A read before this callback would reintroduce false greens.
    timers[1]!();
    await expect(verification).resolves.toBe('ok');
    expect(readCurrent).toHaveBeenCalledTimes(1);
  });

  it('reports a bounded settle timeout without reading a potentially transient value', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1));
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
    const readCurrent = vi.fn(() => 'new');

    const verification = verifyWrittenValue({
      expected: 'new',
      previous: 'old',
      readCurrent,
    });

    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(WRITE_VERIFICATION_TIMEOUT_MS);
    await expect(verification).resolves.toBe('timeout');
    expect(readCurrent).not.toHaveBeenCalled();
  });

  it('aborts a pending frame immediately and never performs a late readback', async () => {
    vi.useFakeTimers();
    const frames: FrameRequestCallback[] = [];
    const cancelFrame = vi.fn();
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      frames.push(callback);
      return frames.length;
    });
    vi.stubGlobal('cancelAnimationFrame', cancelFrame);
    const cancel = new AbortController();
    const readCurrent = vi.fn(() => 'new');
    const verification = verifyWrittenValue({
      expected: 'new',
      previous: 'old',
      readCurrent,
      signal: cancel.signal,
    });

    await Promise.resolve();
    expect(frames).toHaveLength(1);
    cancel.abort();

    await expect(verification).resolves.toBe('aborted');
    expect(cancelFrame).toHaveBeenCalledWith(1);
    frames[0]?.(0);
    await vi.advanceTimersByTimeAsync(WRITE_VERIFICATION_TIMEOUT_MS);
    expect(readCurrent).not.toHaveBeenCalled();
  });
});

/**
 * 电话回读（2026-09-15 实测）：Workable 的 intl-tel-input 把写入的 `+1 415 555 0142`
 * 拆成国家选择器里的 +1 与输入框里的 `(415) 555-0142`；Rippling 留下 `415-555-0142`。
 * 同一个号码换个记法不是 VALUE_COERCED——但**只有**电话控件走这条宽松比对，
 * 而且永远不接受一个不同的号码。
 */
describe('tel-aware readback equivalence', () => {
  it('accepts the same number with its declared country code dropped or moved by the host', () => {
    expect(telValuesEquivalent('+1 415 555 0142', '(415) 555-0142')).toBe(true);
    expect(telValuesEquivalent('+1 415 555 0142', '415-555-0142')).toBe(true);
    expect(telValuesEquivalent('+1 415 555 0142', '+1 (415) 555-0142')).toBe(true);
    expect(telValuesEquivalent('+1 415 555 0142', '1 415 555 0142')).toBe(true);
    expect(telValuesEquivalent('0044 20 7946 0958', '+44 20 7946 0958')).toBe(true);
  });

  it('accepts the national notation with a trunk 0, but never for calling code 1', () => {
    expect(telValuesEquivalent('+44 20 7946 0958', '020 7946 0958')).toBe(true);
    expect(telValuesEquivalent('+353 1 234 5678', '01 234 5678')).toBe(true);
    expect(telValuesEquivalent('+353 1 234 5678', '1 234 5678')).toBe(true);
    expect(telValuesEquivalent('+1 415 555 0142', '0415 555 0142')).toBe(false);
  });

  it('never accepts a different, truncated, or extended number', () => {
    expect(telValuesEquivalent('+1 415 555 0142', '(415) 555-0143')).toBe(false);
    expect(telValuesEquivalent('+1 415 555 0142', '555-0142')).toBe(false);
    expect(telValuesEquivalent('+1 415 555 0142', '415 555 0142 x5')).toBe(false);
    expect(telValuesEquivalent('+1 415 555 0142', '')).toBe(false);
    // Dropping a 2-digit prefix that is not the number's calling code is not tolerated.
    expect(telValuesEquivalent('+1 415 555 0142', '155550142')).toBe(false);
  });

  it('does not accept a country code the written value never declared', () => {
    expect(telValuesEquivalent('415 555 0142', '+1 415 555 0142')).toBe(false);
    expect(telValuesEquivalent('415 555 0142', '(415) 555-0142')).toBe(true);
  });

  it('only relaxes classifyReadback when the caller marks the control as tel', () => {
    expect(classifyReadback('+1 415 555 0142', '', '(415) 555-0142')).toBe('mismatch');
    expect(classifyReadback('+1 415 555 0142', '', '(415) 555-0142', { tel: true })).toBe('ok');
    expect(classifyReadback('+1 415 555 0142', '', '(415) 555-0143', { tel: true })).toBe('mismatch');
    expect(classifyReadback('+1 415 555 0142', '415 555 0000', '415 555 0000', { tel: true })).toBe('reverted');
  });

  it('threads the tel flag through verifyWrittenValue', async () => {
    await expect(
      verifyWrittenValue({ expected: '+1 415 555 0142', previous: '', readCurrent: () => '(415) 555-0142', settle: () => undefined }),
    ).resolves.toBe('mismatch');
    await expect(
      verifyWrittenValue({ expected: '+1 415 555 0142', previous: '', readCurrent: () => '(415) 555-0142', tel: true, settle: () => undefined }),
    ).resolves.toBe('ok');
  });
});
