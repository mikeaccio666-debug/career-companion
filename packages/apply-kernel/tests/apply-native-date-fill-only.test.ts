// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  prepareNativeDateFillOnly,
  type NativeDateFillOnlyTransaction,
} from '../src/write/nativeDateFillOnly.ts';

function install(kind: 'date' | 'month', value = ''): HTMLInputElement {
  document.body.innerHTML = `<form><label for="start">Start</label>
    <input id="start" type="${kind}"></form>`;
  const target = document.querySelector<HTMLInputElement>('#start')!;
  target.value = value;
  return target;
}

function prepare(
  kind: 'date' | 'month' = 'date',
  expected = kind === 'date' ? '2028-02-29' : '2028-02',
  exactTargetCurrent = () => true,
): NativeDateFillOnlyTransaction {
  const transaction = prepareNativeDateFillOnly({
    target: install(kind),
    expected,
    exactTargetCurrent,
  });
  if (transaction === null) throw new Error('TEST_TRANSACTION_UNAVAILABLE');
  return transaction;
}

function execute(
  transaction: NativeDateFillOnlyTransaction,
  patch: Partial<Parameters<NativeDateFillOnlyTransaction['fillOnly']>[0]> = {},
) {
  return transaction.fillOnly({
    authorizeWrite: async () => true,
    executionFence: () => null,
    readHostValidation: () => ({ ariaInvalid: 'false' }),
    lateRecheckMs: 1,
    operationTimeoutMs: 50,
    settle: async () => undefined,
    lateRecheckDelay: async () => undefined,
    ...patch,
  });
}

beforeEach(() => {
  document.body.innerHTML = '';
});

afterEach(() => {
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});

describe('native date/month fill-only transaction', () => {
  it.each([
    ['date', '2028-02-29'],
    ['month', '2028-02'],
  ] as const)('writes one exact empty native %s and emits only input/change', async (kind, expected) => {
    const transaction = prepare(kind, expected);
    const target = document.querySelector<HTMLInputElement>('#start')!;
    const events: string[] = [];
    for (const type of ['beforeinput', 'input', 'change', 'click', 'submit']) {
      target.form!.addEventListener(type, () => events.push(type));
    }
    const click = vi.spyOn(HTMLElement.prototype, 'click');

    const result = await execute(transaction);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('EXPECTED_SUCCESS');
    expect(target.value).toBe(expected);
    expect(events).toEqual(['input', 'change']);
    expect(click).not.toHaveBeenCalled();
    expect(result.observation.check()).toBeNull();
    expect(result.observation.finalize()).toBeNull();
    expect(await execute(transaction)).toEqual({ ok: false, code: 'CAPABILITY_DISABLED' });
  });

  it.each([
    ['date', ''],
    ['date', '0000-01-01'],
    ['date', '2027-02-29'],
    ['date', '2028-13-01'],
    ['date', '2028-01-32'],
    ['month', '0000-01'],
    ['month', '2028-00'],
    ['month', '2028-13'],
    ['month', 'February 2028'],
  ] as const)('rejects invalid %s payload %s before preparing a writer', (kind, expected) => {
    const target = install(kind);
    const setter = vi.spyOn(HTMLInputElement.prototype, 'value', 'set');

    expect(prepareNativeDateFillOnly({
      target,
      expected,
      exactTargetCurrent: () => true,
    })).toBeNull();
    expect(setter).not.toHaveBeenCalled();
    expect(target.value).toBe('');
  });

  it('distinguishes exact PREFILLED state and preserves a different nonempty value', async () => {
    const expected = '2028-02-29';
    const exact = prepareNativeDateFillOnly({
      target: install('date', expected), expected, exactTargetCurrent: () => true,
    })!;
    expect(exact.isAtAnswer()).toBe(true);
    expect(exact.isEmpty()).toBe(false);

    const target = install('date', '2028-03-01');
    const different = prepareNativeDateFillOnly({
      target, expected, exactTargetCurrent: () => true,
    })!;
    const setter = vi.spyOn(HTMLInputElement.prototype, 'value', 'set');

    expect(different.isAtAnswer()).toBe(false);
    expect(different.isEmpty()).toBe(false);
    expect(await execute(different)).toEqual({ ok: false, code: 'IDENTITY_CHANGED' });
    expect(setter).not.toHaveBeenCalled();
    expect(target.value).toBe('2028-03-01');
  });

  it('rechecks exact identity after fresh authorization and makes no write attempt', async () => {
    let exact = true;
    const transaction = prepare('date', '2028-02-29', () => exact);
    const target = document.querySelector<HTMLInputElement>('#start')!;
    const setter = vi.spyOn(HTMLInputElement.prototype, 'value', 'set');

    const result = await execute(transaction, {
      authorizeWrite: async () => { exact = false; return true; },
    });

    expect(result).toEqual({ ok: false, code: 'IDENTITY_CHANGED' });
    expect(result).not.toHaveProperty('writeEffect');
    expect(setter).not.toHaveBeenCalled();
    expect(target.value).toBe('');
  });

  it('rechecks abort after the final target proof and before the native setter', async () => {
    const abort = new AbortController();
    let authorized = false;
    const transaction = prepare('date', '2028-02-29', () => {
      if (authorized) abort.abort();
      return true;
    });
    const target = document.querySelector<HTMLInputElement>('#start')!;
    const setter = vi.spyOn(HTMLInputElement.prototype, 'value', 'set');

    const result = await execute(transaction, {
      authorizeWrite: async () => { authorized = true; return true; },
      signal: abort.signal,
    });

    expect(abort.signal.aborted).toBe(true);
    expect(result).toEqual({ ok: false, code: 'ABORTED' });
    expect(result).not.toHaveProperty('writeEffect');
    expect(setter).not.toHaveBeenCalled();
    expect(target.value).toBe('');
  });

  it('treats a nested host edit event as external and never restores the written value', async () => {
    const transaction = prepare();
    const target = document.querySelector<HTMLInputElement>('#start')!;
    target.addEventListener('input', () => {
      target.dispatchEvent(new Event('change', { bubbles: true }));
    });

    const result = await execute(transaction);

    expect(result).toEqual({
      ok: false,
      code: 'HOST_REJECTED',
      writeEffect: 'MAY_HAVE_CHANGED',
    });
    expect(target.value).toBe('2028-02-29');
  });

  it('preserves the written value when host validation rejects it', async () => {
    const transaction = prepare();
    const target = document.querySelector<HTMLInputElement>('#start')!;

    const result = await execute(transaction, {
      readHostValidation: () => ({ ariaInvalid: 'true' }),
    });

    expect(result).toEqual({
      ok: false,
      code: 'HOST_REJECTED',
      writeEffect: 'MAY_HAVE_CHANGED',
    });
    expect(target.value).toBe('2028-02-29');
  });

  it('keeps late third-party drift and never restores the empty state', async () => {
    const transaction = prepare();
    const target = document.querySelector<HTMLInputElement>('#start')!;

    const result = await execute(transaction, {
      lateRecheckDelay: async () => { target.value = '2029-01-01'; },
    });

    expect(result).toEqual({
      ok: false,
      code: 'LATE_REVERTED',
      writeEffect: 'MAY_HAVE_CHANGED',
    });
    expect(target.value).toBe('2029-01-01');
  });

  it('does not mint a write when authorization is denied', async () => {
    const transaction = prepare();
    const target = document.querySelector<HTMLInputElement>('#start')!;
    const setter = vi.spyOn(HTMLInputElement.prototype, 'value', 'set');

    const result = await execute(transaction, { authorizeWrite: async () => false });

    expect(result).toEqual({ ok: false, code: 'CAPABILITY_DISABLED' });
    expect(setter).not.toHaveBeenCalled();
    expect(target.value).toBe('');
  });

  it.each(['aria-disabled', 'aria-readonly', 'aria-hidden'] as const)(
    'does not prepare a date target carrying %s=true', (attribute) => {
      const target = install('date');
      target.setAttribute(attribute, 'true');
      const setter = vi.spyOn(HTMLInputElement.prototype, 'value', 'set');

      expect(prepareNativeDateFillOnly({
        target,
        expected: '2028-02-29',
        exactTargetCurrent: () => true,
      })).toBeNull();
      expect(setter).not.toHaveBeenCalled();
      expect(target.value).toBe('');
    },
  );

  it('fails closed instead of throwing for a hostile runtime target', () => {
    const target = install('date');
    const hostile = new Proxy(target, {
      get: () => { throw new Error('HOSTILE_TARGET'); },
    });

    expect(() => prepareNativeDateFillOnly({
      target: hostile,
      expected: '2028-02-29',
      exactTargetCurrent: () => true,
    })).not.toThrow();
    expect(prepareNativeDateFillOnly({
      target: hostile,
      expected: '2028-02-29',
      exactTargetCurrent: () => true,
    })).toBeNull();
  });

  it('treats a form reset event during host dispatch as external', async () => {
    const transaction = prepare();
    const target = document.querySelector<HTMLInputElement>('#start')!;
    target.addEventListener('input', () => {
      target.form!.dispatchEvent(new Event('reset', { bubbles: true }));
    });

    const result = await execute(transaction);

    expect(result).toEqual({
      ok: false,
      code: 'HOST_REJECTED',
      writeEffect: 'MAY_HAVE_CHANGED',
    });
    expect(target.value).toBe('2028-02-29');
  });
});
