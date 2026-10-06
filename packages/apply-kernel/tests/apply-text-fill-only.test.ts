// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTextSemanticTargetAuthority, executeTextFillOnlyWrite } from '../src/write/textSemanticSettlement';

function fixture() {
  document.body.innerHTML = '<form><input type="text"></form>';
  const target = document.querySelector('input')!;
  const setter = vi.fn(() => { target.value = 'synthetic answer'; return true; });
  const input = {
    target: createTextSemanticTargetAuthority(target)!, expected: 'synthetic answer',
    authorizeWrite: async () => true, writeForward: setter,
    executionFence: () => null, readHostValidation: () => ({ ariaInvalid: 'false' }),
    lateRecheckMs: 1, settle: async () => {},
  };
  return { target, setter, input };
}

afterEach(() => { vi.restoreAllMocks(); document.body.innerHTML = ''; });

describe('fill-first read-only settlement', () => {
  it.each(['abort', 'value', 'detach', 'false', 'throw'] as const)(
    'validates the terminal state after consumer cleanup: %s', async (scenario) => {
    const { target, setter, input } = fixture();
    const controller = new AbortController();
    const result = await executeTextFillOnlyWrite({ ...input, signal: controller.signal });
    if (!result.ok) throw new Error('EXPECTED_FILLED');
    const retire = vi.fn(() => {
      if (scenario === 'abort') controller.abort();
      if (scenario === 'value') target.value = 'person correction';
      if (scenario === 'detach') target.remove();
      if (scenario === 'throw') throw new Error('SYNTHETIC_CLEANUP_FAILURE');
      return scenario !== 'false';
    });
    expect(result.observation.finalize(retire)).toBe(
      scenario === 'abort' ? 'ABORTED' : scenario === 'value' ? 'LATE_REVERTED' :
        scenario === 'detach' ? 'IDENTITY_CHANGED' : 'HOST_REJECTED',
    );
    expect(retire).toHaveBeenCalledTimes(1);
    expect(target.value).toBe(scenario === 'value' ? 'person correction' : 'synthetic answer');
    expect(setter).toHaveBeenCalledTimes(1);
    result.observation.dispose();
  });

  it('retires consumer listeners even when final verification has already failed', async () => {
    const { target, input } = fixture();
    const result = await executeTextFillOnlyWrite(input);
    if (!result.ok) throw new Error('EXPECTED_FILLED');
    target.value = 'person correction';
    const retire = vi.fn(() => true);
    expect(result.observation.finalize(retire)).toBe('LATE_REVERTED');
    expect(retire).toHaveBeenCalledTimes(1);
    expect(target.value).toBe('person correction');
  });

  it.each(['execution-fence', 'disabled-getter', 'value-getter'] as const)(
    'does not attempt a setter after synchronous abort from the final %s', async (source) => {
    const { target, setter, input } = fixture();
    const controller = new AbortController();
    let authorized = false;
    const abortWhenAuthorized = () => { if (authorized) controller.abort(); };
    if (source !== 'execution-fence') {
      const property = source === 'disabled-getter' ? 'disabled' : 'value';
      const get = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, property)!.get!;
      vi.spyOn(HTMLInputElement.prototype, property, 'get').mockImplementation(() => {
        abortWhenAuthorized();
        return get.call(target);
      });
    }
    const result = await executeTextFillOnlyWrite({ ...input, signal: controller.signal,
      authorizeWrite: async () => { authorized = true; return true; },
      executionFence: () => {
        if (source === 'execution-fence') abortWhenAuthorized();
        return null;
      },
    });
    expect(controller.signal.aborted).toBe(true);
    expect(result).toEqual({ ok: false, code: 'ABORTED' });
    expect(setter).not.toHaveBeenCalled();
    expect(target.value).toBe('');
  });

  it.each(['execution-fence', 'value-getter'] as const)(
    'downgrades final success after synchronous abort from the last retired %s', async (source) => {
    const { target, setter, input } = fixture();
    const controller = new AbortController();
    let finalizing = false;
    let fenceCalls = 0;
    const result = await executeTextFillOnlyWrite({ ...input, signal: controller.signal,
      executionFence: () => {
        if (finalizing && ++fenceCalls === 4 && source === 'execution-fence') controller.abort();
        return null;
      },
    });
    if (!result.ok) throw new Error('EXPECTED_FILLED');
    const getValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.get!;
    vi.spyOn(HTMLInputElement.prototype, 'value', 'get').mockImplementation(() => {
      if (finalizing && fenceCalls === 4 && source === 'value-getter') controller.abort();
      return getValue.call(target);
    });
    finalizing = true;
    expect(result.observation.finalize()).toBe('ABORTED');
    expect(controller.signal.aborted).toBe(true);
    expect(target.value).toBe('synthetic answer');
    expect(setter).toHaveBeenCalledTimes(1);
    result.observation.dispose();
  });

  it('fills once, returns only read-only verification, and never clears on disposal', async () => {
    const { target, setter, input } = fixture();
    const result = await executeTextFillOnlyWrite(input);
    expect(result.ok).toBe(true);
    expect(setter).toHaveBeenCalledTimes(1);
    if (!result.ok) throw new Error('EXPECTED_FILLED');
    expect(result.observation.check()).toBeNull();
    expect('undo' in result).toBe(false);
    expect('restorePreWrite' in result.observation).toBe(false);
    result.observation.dispose();
    expect(target.value).toBe('synthetic answer');
    expect((await executeTextFillOnlyWrite(input)).ok).toBe(false);
    expect(setter).toHaveBeenCalledTimes(1);
  });

  it('rejects a stale grant and a value entered while awaiting authorization without writing', async () => {
    const { target, setter, input } = fixture();
    expect(await executeTextFillOnlyWrite({ ...input, authorizeWrite: async () => {
      target.value = 'person edit'; return true;
    } })).toMatchObject({ ok: false });
    expect(setter).not.toHaveBeenCalled();
    expect(target.value).toBe('person edit');
    const stale = fixture();
    expect(await executeTextFillOnlyWrite({ ...stale.input, authorizeWrite: async () => false }))
      .toMatchObject({ ok: false });
    expect(stale.setter).not.toHaveBeenCalled();
  });

  it('retains a failed host value and reports possible page changes without recovery writes', async () => {
    const { target, setter, input } = fixture();
    const result = await executeTextFillOnlyWrite({ ...input,
      readHostValidation: () => ({ ariaInvalid: 'true' }),
    });
    expect(result).toMatchObject({ ok: false, code: 'HOST_REJECTED', writeEffect: 'MAY_HAVE_CHANGED' });
    expect(target.value).toBe('synthetic answer');
    expect(setter).toHaveBeenCalledTimes(1);
  });

  it('preserves a person/host edit during late verification and reports failure', async () => {
    const { target, setter, input } = fixture();
    const result = await executeTextFillOnlyWrite({ ...input,
      lateRecheckDelay: async () => { target.value = 'person correction'; },
    });
    expect(result).toMatchObject({ ok: false, code: 'LATE_REVERTED', writeEffect: 'MAY_HAVE_CHANGED' });
    expect(target.value).toBe('person correction');
    expect(setter).toHaveBeenCalledTimes(1);
  });

  it('keeps final verification alive until batch completion and detects later drift', async () => {
    const { target, input } = fixture();
    const result = await executeTextFillOnlyWrite(input);
    if (!result.ok) throw new Error('EXPECTED_FILLED');
    target.value = 'later host change';
    expect(result.observation.check()).toBe('LATE_REVERTED');
    result.observation.dispose();
    expect(target.value).toBe('later host change');
  });

  it('reports partial setter failure and stops before a setter after target replacement', async () => {
    const { target, input } = fixture();
    expect(await executeTextFillOnlyWrite({ ...input, writeForward: () => {
      target.value = 'partial'; throw new Error('SYNTHETIC_FAILURE');
    } })).toMatchObject({ ok: false, writeEffect: 'MAY_HAVE_CHANGED' });
    expect(target.value).toBe('partial');
    const replaced = fixture();
    const result = await executeTextFillOnlyWrite({ ...replaced.input, authorizeWrite: async () => {
      replaced.target.replaceWith(replaced.target.cloneNode()); return true;
    } });
    expect(result).toMatchObject({ ok: false, code: 'IDENTITY_CHANGED' });
    expect(replaced.setter).not.toHaveBeenCalled();
  });
});

it('reads the final value after observation retirement and preserves cleanup-time edits', async () => {
  const { target, input } = fixture();
  const result = await executeTextFillOnlyWrite(input);
  if (!result.ok) throw new Error('EXPECTED_FILLED');
  const disconnect = MutationObserver.prototype.disconnect;
  const spy = vi.spyOn(MutationObserver.prototype, 'disconnect').mockImplementation(function (this: MutationObserver) {
    disconnect.call(this);
    target.value = 'cleanup-time edit';
  });
  try {
    expect(result.observation.finalize()).toBe('LATE_REVERTED');
    expect(target.value).toBe('cleanup-time edit');
  } finally { spy.mockRestore(); }
});

it('does not mix frozen-Undo admission with legacy restore plans or other controls', async () => {
  const { executePilotUa4Leaf } = await import('../src/pilotUa4Writer');
  const question = {
    questionId: 'synthetic-question', controlKind: 'TEXT' as const, compilerControlKind: 'TEXT_SINGLE' as const,
    identityDigests: ['a'.repeat(64)], required: true, rowToken: null,
    answerDigest: 'b'.repeat(64), payloadRef: 'local.answer', classification: null,
  };
  const execute = vi.fn(async () => ({ ok: false as const, code: 'CAPABILITY_DISABLED' as const }));
  for (const [undoPolicy, controlKind, kind] of [
    ['FROZEN', 'TEXT', 'TEXT_TRANSACTION'],
    ['REQUIRED', 'TEXT', 'TEXT_FILL_ONLY'],
    ['FROZEN', 'FILE', 'TEXT_FILL_ONLY'],
  ] as const) {
    const result = await executePilotUa4Leaf({ ...question, undoPolicy, controlKind }, { kind, execute });
    expect(result.disposition).toEqual({ state: 'POLICY_BLOCKED', reason: 'TARGET_NOT_ELIGIBLE' });
  }
  expect(execute).not.toHaveBeenCalled();
});
