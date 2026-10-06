import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  prepareNativeSelectSemanticTransaction,
  type NativeSelectSemanticTransaction,
} from '../src/write/nativeSelectSemanticTransaction';
import {
  consumeAuthority,
  releaseAuthority,
  type HostWriteAuthority,
} from '../src/grant';
import { createUndoJournal, type WriteTicket } from '../src/undo';
import { testAuthority } from './helpers/applyTestAuthority';

const ACCEPTED = { ariaInvalid: 'false' } as const;

interface MountedSelect {
  readonly form: HTMLFormElement;
  readonly select: HTMLSelectElement;
  readonly options: readonly HTMLOptionElement[];
}

function mountSelect(input: {
  readonly selectedIndex?: number;
  readonly duplicateValues?: boolean;
} = {}): MountedSelect {
  const form = document.createElement('form');
  const select = document.createElement('select');
  select.name = 'location';
  const values = input.duplicateValues
    ? ['same-host-value', 'same-host-value', 'same-host-value']
    : ['manual', 'seattle', 'portland'];
  const labels = ['Manual', 'Seattle', 'Portland'];
  const options = labels.map((label, index) => {
    const option = document.createElement('option');
    option.value = values[index]!;
    option.text = label;
    select.append(option);
    return option;
  });
  form.append(select);
  document.body.append(form);
  select.selectedIndex = input.selectedIndex ?? 0;
  return { form, select, options };
}

function prepare(mounted: MountedSelect): NativeSelectSemanticTransaction {
  const result = prepareNativeSelectSemanticTransaction({
    select: mounted.select,
    options: mounted.options.map((element, index) => ({
      element,
      optionId: ['manual', 'seattle', 'portland'][index]!,
    })),
  });
  expect(result, result.ok ? '' : result.error).toMatchObject({ ok: true });
  if (!result.ok) throw new Error(result.error);
  return result.value;
}

function fillProof(select: HTMLSelectElement): {
  readonly authority: HostWriteAuthority;
  readonly ticket: WriteTicket;
} {
  const consumed = consumeAuthority(testAuthority('native-select-test', 'fill', ['set-select']));
  expect(consumed).toMatchObject({ ok: true });
  if (!consumed.ok) throw new Error(consumed.code);
  const recorded = createUndoJournal().record(select);
  expect(recorded).toMatchObject({ ok: true });
  if (!recorded.ok) throw new Error(recorded.code);
  return { authority: consumed.value, ticket: recorded.value };
}

function undoAuthority(): HostWriteAuthority {
  const consumed = consumeAuthority(testAuthority(null, 'undo', ['set-select']));
  expect(consumed).toMatchObject({ ok: true });
  if (!consumed.ok) throw new Error(consumed.code);
  return consumed.value;
}

function verificationOnly(
  overrides: Partial<Parameters<NativeSelectSemanticTransaction['write']>[0]> = {},
) {
  return {
    optionId: 'seattle',
    readHostValidation: () => ACCEPTED,
    executionFence: () => null,
    lateRecheckMs: 1,
    settle: () => Promise.resolve(),
    lateRecheckDelay: () => Promise.resolve(),
    ...overrides,
  } as Parameters<NativeSelectSemanticTransaction['write']>[0];
}

function normalWrite(
  select: HTMLSelectElement,
  overrides: Partial<Parameters<NativeSelectSemanticTransaction['write']>[0]> = {},
) {
  return {
    ...fillProof(select),
    ...verificationOnly(overrides),
  } as Parameters<NativeSelectSemanticTransaction['write']>[0];
}

function fillOnlyInput(
  overrides: Partial<Parameters<NativeSelectSemanticTransaction['fillOnly']>[0]> = {},
): Parameters<NativeSelectSemanticTransaction['fillOnly']>[0] {
  return {
    optionId: 'seattle',
    emptyOptionIds: ['manual'],
    authorizeWrite: async () => true,
    readHostValidation: () => ACCEPTED,
    executionFence: () => null,
    lateRecheckMs: 1,
    operationTimeoutMs: 100,
    settle: async () => undefined,
    lateRecheckDelay: async () => undefined,
    ...overrides,
  };
}

function hostWitnesses(form: HTMLFormElement) {
  const events: string[] = [];
  form.addEventListener('input', () => events.push('input'));
  form.addEventListener('change', () => events.push('change'));
  let submitEvents = 0;
  form.addEventListener('submit', (event) => {
    submitEvents += 1;
    event.preventDefault();
  });
  const submit = vi.spyOn(HTMLFormElement.prototype, 'submit');
  const requestSubmit = vi.spyOn(HTMLFormElement.prototype, 'requestSubmit');
  const click = vi.spyOn(HTMLElement.prototype, 'click');
  return {
    events,
    submitEvents: () => submitEvents,
    submitCalls: () => submit.mock.calls.length,
    requestSubmitCalls: () => requestSubmit.mock.calls.length,
    clickCalls: () => click.mock.calls.length,
  };
}

afterEach(() => {
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

describe('native select semantic preparation', () => {
  it('requires a single-select and the complete exact option membership', () => {
    const mounted = mountSelect();
    mounted.select.multiple = true;
    expect(prepareNativeSelectSemanticTransaction({
      select: mounted.select,
      options: mounted.options.map((element, index) => ({ element, optionId: `option-${index}` })),
    })).toEqual({ ok: false, error: 'INVALID_SELECT' });

    mounted.select.multiple = false;
    expect(prepareNativeSelectSemanticTransaction({
      select: mounted.select,
      options: mounted.options.slice(0, 2).map((element, index) => ({ element, optionId: `option-${index}` })),
    })).toEqual({ ok: false, error: 'INCOMPLETE_OPTION_MEMBERSHIP' });
    expect(mounted.select.selectedIndex).toBe(0);
  });

  it('rejects duplicate opaque option IDs before any event or mutation', () => {
    const mounted = mountSelect();
    const host = hostWitnesses(mounted.form);
    const result = prepareNativeSelectSemanticTransaction({
      select: mounted.select,
      options: mounted.options.map((element, index) => ({
        element,
        optionId: index === 2 ? 'seattle' : ['manual', 'seattle'][index]!,
      })),
    });

    expect(result).toEqual({ ok: false, error: 'DUPLICATE_OPTION_ID' });
    expect(mounted.select.selectedIndex).toBe(0);
    expect(host.events).toEqual([]);
  });
});

describe('native select semantic write', () => {
  it('selects by exact option identity despite duplicate raw values, then settles and validates late', async () => {
    const mounted = mountSelect({ duplicateValues: true });
    const transaction = prepare(mounted);
    const host = hostWitnesses(mounted.form);
    const semanticAtEvent: number[] = [];
    mounted.select.addEventListener('input', () => semanticAtEvent.push(mounted.select.selectedIndex));
    mounted.select.addEventListener('change', () => semanticAtEvent.push(mounted.select.selectedIndex));
    let settles = 0;
    let validations = 0;
    let lateDelays = 0;

    const result = await transaction.write(normalWrite(mounted.select, {
      settle: () => { settles += 1; },
      readHostValidation: () => { validations += 1; return ACCEPTED; },
      lateRecheckDelay: () => { lateDelays += 1; },
    }));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toMatchObject({
      disposition: 'FILLED',
      selectedOptionId: 'seattle',
    });
    expect(result.value.undo).not.toBeNull();
    expect(mounted.select.value).toBe('same-host-value');
    expect(mounted.select.selectedIndex).toBe(1);
    expect(mounted.select.selectedOptions[0]).toBe(mounted.options[1]);
    expect(host.events).toEqual(['input', 'change']);
    expect(semanticAtEvent).toEqual([1, 1]);
    expect(settles).toBeGreaterThanOrEqual(2);
    expect(validations).toBeGreaterThanOrEqual(2);
    expect(lateDelays).toBe(1);
    expect(host.clickCalls()).toBe(0);
    expect(host.submitEvents()).toBe(0);
    expect(host.submitCalls()).toBe(0);
    expect(host.requestSubmitCalls()).toBe(0);
  });

  it('returns explicit PREFILLED with zero events and zero Undo', async () => {
    const mounted = mountSelect({ selectedIndex: 1 });
    const transaction = prepare(mounted);
    const host = hostWitnesses(mounted.form);

    const result = await transaction.write(verificationOnly());

    expect(result).toEqual({
      ok: true,
      value: {
        disposition: 'PREFILLED',
        selectedOptionId: 'seattle',
        undo: null,
      },
    });
    expect(host.events).toEqual([]);
    expect(host.clickCalls()).toBe(0);
    expect(host.submitCalls()).toBe(0);
    expect(host.requestSubmitCalls()).toBe(0);
  });

  it('requires active set-select authority and a journal ticket before the first mutation or event', async () => {
    const mounted = mountSelect();
    const transaction = prepare(mounted);
    const host = hostWitnesses(mounted.form);

    await expect(transaction.write(verificationOnly())).resolves.toEqual({
      ok: false,
      code: 'CAPABILITY_DISABLED',
    });

    expect(mounted.select.selectedIndex).toBe(0);
    expect(host.events).toEqual([]);
    expect(host.clickCalls()).toBe(0);
    expect(host.submitCalls()).toBe(0);
    expect(host.requestSubmitCalls()).toBe(0);
  });

  it('stops before change when authority is revoked by the input callback', async () => {
    const mounted = mountSelect();
    const transaction = prepare(mounted);
    const host = hostWitnesses(mounted.form);
    const proof = fillProof(mounted.select);
    mounted.select.addEventListener('input', () => releaseAuthority(proof.authority));

    const result = await transaction.write(normalWrite(mounted.select, proof));

    expect(result).toMatchObject({ ok: false, code: 'GESTURE_UNTRUSTED' });
    expect(mounted.select.selectedIndex).toBe(1);
    expect(host.events).toEqual(['input']);
    expect(host.clickCalls()).toBe(0);
    expect(host.submitEvents()).toBe(0);
    expect(host.submitCalls()).toBe(0);
    expect(host.requestSubmitCalls()).toBe(0);
  });

  it('re-checks authority after the execution callback and before the first setter', async () => {
    const mounted = mountSelect();
    const transaction = prepare(mounted);
    const host = hostWitnesses(mounted.form);
    const proof = fillProof(mounted.select);

    const result = await transaction.write(normalWrite(mounted.select, {
      ...proof,
      executionFence: () => {
        releaseAuthority(proof.authority);
        return null;
      },
    }));

    expect(result).toEqual({ ok: false, code: 'GESTURE_UNTRUSTED' });
    expect(mounted.select.selectedIndex).toBe(0);
    expect(host.events).toEqual([]);
    expect(host.clickCalls()).toBe(0);
    expect(host.submitCalls()).toBe(0);
    expect(host.requestSubmitCalls()).toBe(0);
  });

  it('rejects a non-fill ticket before the first setter or event', async () => {
    const mounted = mountSelect();
    const transaction = prepare(mounted);
    const host = hostWitnesses(mounted.form);

    const result = await transaction.write(normalWrite(mounted.select, {
      ticket: { purpose: 'restore' } as WriteTicket,
    }));

    expect(result).toEqual({ ok: false, code: 'CAPABILITY_DISABLED' });
    expect(mounted.select.selectedIndex).toBe(0);
    expect(host.events).toEqual([]);
  });

  it('does not mistake a same-value third option selected by a host callback for success', async () => {
    const mounted = mountSelect({ duplicateValues: true });
    const transaction = prepare(mounted);
    mounted.select.addEventListener('change', () => {
      mounted.select.selectedIndex = 2;
    });

    const result = await transaction.write(normalWrite(mounted.select));

    expect(result).toEqual({ ok: false, code: 'VALUE_COERCED' });
    expect(mounted.select.selectedIndex).toBe(2);
    expect(mounted.select.selectedOptions[0]).toBe(mounted.options[2]);
  });

  it.each([
    ['unknown', () => ({}) as const, 'CAPABILITY_DISABLED'],
    ['rejected', () => ({ ariaInvalid: 'true' }) as const, 'HOST_REJECTED'],
  ])('fails closed on %s host validation and compensates the exact write', async (_name, read, code) => {
    const mounted = mountSelect();
    const transaction = prepare(mounted);

    const result = await transaction.write(normalWrite(mounted.select, { readHostValidation: read }));

    expect(result).toEqual({ ok: false, code });
    expect(mounted.select.selectedIndex).toBe(0);
    expect(mounted.select.selectedOptions[0]).toBe(mounted.options[0]);
  });

  it('demotes a same-value late drift without restoring over the third option', async () => {
    const mounted = mountSelect({ duplicateValues: true });
    const transaction = prepare(mounted);

    const result = await transaction.write(normalWrite(mounted.select, {
      lateRecheckDelay: () => {
        mounted.select.selectedIndex = 2;
      },
    }));

    expect(result).toEqual({ ok: false, code: 'LATE_REVERTED' });
    expect(mounted.select.selectedIndex).toBe(2);
    expect(mounted.select.selectedOptions[0]).toBe(mounted.options[2]);
  });

  it('re-reads semantics after host validation callbacks instead of trusting their verdict', async () => {
    const mounted = mountSelect({ duplicateValues: true });
    const transaction = prepare(mounted);
    let validations = 0;

    const result = await transaction.write(normalWrite(mounted.select, {
      readHostValidation: () => {
        validations += 1;
        if (validations === 1) mounted.select.selectedIndex = 2;
        return ACCEPTED;
      },
    }));

    expect(result).toEqual({ ok: false, code: 'VALUE_COERCED' });
    expect(mounted.select.selectedOptions[0]).toBe(mounted.options[2]);
  });

  it('requires the late settle/final semantic read to catch queued host drift', async () => {
    const mounted = mountSelect({ duplicateValues: true });
    const transaction = prepare(mounted);
    let settles = 0;

    const result = await transaction.write(normalWrite(mounted.select, {
      settle: () => {
        settles += 1;
        if (settles === 2) queueMicrotask(() => { mounted.select.selectedIndex = 2; });
      },
    }));

    expect(result).toEqual({ ok: false, code: 'LATE_REVERTED' });
    expect(settles).toBe(2);
    expect(mounted.select.selectedOptions[0]).toBe(mounted.options[2]);
  });

  it('does not let an immediate delay seam skip the real late window', async () => {
    const mounted = mountSelect({ duplicateValues: true });
    const transaction = prepare(mounted);

    const result = await transaction.write(normalWrite(mounted.select, {
      lateRecheckDelay: () => {
        setTimeout(() => { mounted.select.selectedIndex = 2; }, 0);
      },
    }));

    expect(result).toEqual({ ok: false, code: 'LATE_REVERTED' });
    expect(mounted.select.selectedOptions[0]).toBe(mounted.options[2]);
  });

  it('does not promote PREFILLED when the semantic option drifts during the late window', async () => {
    const mounted = mountSelect({ selectedIndex: 1, duplicateValues: true });
    const transaction = prepare(mounted);
    const host = hostWitnesses(mounted.form);

    await expect(transaction.write(verificationOnly({
      lateRecheckDelay: () => { mounted.select.selectedIndex = 2; },
    }))).resolves.toEqual({
      ok: false,
      code: 'LATE_REVERTED',
    });
    expect(mounted.select.selectedOptions[0]).toBe(mounted.options[2]);
    expect(host.events).toEqual([]);
  });

  it('lets a fresh HOST_SUBMITTED fence dominate a failed PREFILLED settle hook', async () => {
    const mounted = mountSelect({ selectedIndex: 1 });
    const transaction = prepare(mounted);
    const host = hostWitnesses(mounted.form);
    let submitted = false;

    const result = await transaction.write(verificationOnly({
      executionFence: () => submitted ? 'HOST_SUBMITTED' : null,
      settle: () => {
        submitted = true;
        throw new Error('host submitted while checking a prefilled select');
      },
    }));

    expect(result).toEqual({ ok: false, code: 'HOST_SUBMITTED' });
    expect(mounted.select.selectedIndex).toBe(1);
    expect(host.events).toEqual([]);
    expect(host.clickCalls()).toBe(0);
    expect(host.submitCalls()).toBe(0);
    expect(host.requestSubmitCalls()).toBe(0);
  });

  it.each(['replace', 'text'] as const)('fails closed when exact option identity drifts by %s', async (drift) => {
    const mounted = mountSelect();
    const transaction = prepare(mounted);
    let replacement: HTMLOptionElement | null = null;

    const result = await transaction.write(normalWrite(mounted.select, {
      settle: () => {
        if (drift === 'replace') {
          replacement = document.createElement('option');
          replacement.value = 'seattle';
          replacement.text = 'Seattle';
          mounted.options[1]!.replaceWith(replacement);
          replacement.selected = true;
        } else {
          mounted.options[1]!.text = 'Submit Application';
        }
      },
    }));

    expect(result).toEqual({ ok: false, code: 'IDENTITY_CHANGED' });
    if (replacement) expect(mounted.select.selectedOptions[0]).toBe(replacement);
  });

  it.each(['hidden', 'reparent'] as const)('fails closed when the select target drifts by %s', async (drift) => {
    const mounted = mountSelect();
    const transaction = prepare(mounted);

    const result = await transaction.write(normalWrite(mounted.select, {
      readHostValidation: () => {
        if (drift === 'hidden') mounted.select.hidden = true;
        else document.body.append(mounted.select);
        return ACCEPTED;
      },
    }));

    expect(result).toEqual({ ok: false, code: 'IDENTITY_CHANGED' });
  });

  it('stops after a HOST_SUBMITTED fence without change, compensation, click, or submit dispatch', async () => {
    const mounted = mountSelect();
    const transaction = prepare(mounted);
    const host = hostWitnesses(mounted.form);
    let fences = 0;

    const result = await transaction.write(normalWrite(mounted.select, {
      executionFence: () => (++fences >= 2 ? 'HOST_SUBMITTED' : null),
    }));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('HOST_SUBMITTED');
    expect(result.recovery).toBeUndefined();
    expect(mounted.select.selectedIndex).toBe(1);
    expect(host.events).toEqual(['input']);
    expect(host.clickCalls()).toBe(0);
    expect(host.submitEvents()).toBe(0);
    expect(host.submitCalls()).toBe(0);
    expect(host.requestSubmitCalls()).toBe(0);
  });

  it('re-checks submission before compensation when host settle fails', async () => {
    const mounted = mountSelect();
    const transaction = prepare(mounted);
    const host = hostWitnesses(mounted.form);
    let submitted = false;

    const result = await transaction.write(normalWrite(mounted.select, {
      executionFence: () => submitted ? 'HOST_SUBMITTED' : null,
      settle: () => {
        submitted = true;
        throw new Error('host began submission while settling');
      },
    }));

    expect(result).toEqual({ ok: false, code: 'HOST_SUBMITTED' });
    expect(mounted.select.selectedIndex).toBe(1);
    expect(host.events).toEqual(['input', 'change']);
    expect(host.clickCalls()).toBe(0);
    expect(host.submitCalls()).toBe(0);
    expect(host.requestSubmitCalls()).toBe(0);
  });
});

describe('native select fill-only write', () => {
  it('fills one declared placeholder without creating or requiring Undo', async () => {
    const mounted = mountSelect();
    const transaction = prepare(mounted);
    const host = hostWitnesses(mounted.form);

    const result = await transaction.fillOnly(fillOnlyInput());

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(mounted.select.selectedIndex).toBe(1);
    expect(host.events).toEqual(['input', 'change']);
    expect(result.observation.check()).toBeNull();
    expect(result.observation.finalize()).toBeNull();
    result.observation.dispose();
    expect(mounted.select.selectedIndex).toBe(1);
    expect(host.clickCalls()).toBe(0);
    expect(host.submitCalls()).toBe(0);
    expect(host.requestSubmitCalls()).toBe(0);
  });

  it('does not write when fresh authorization is denied', async () => {
    const mounted = mountSelect();
    const transaction = prepare(mounted);
    const host = hostWitnesses(mounted.form);

    const result = await transaction.fillOnly(fillOnlyInput({
      authorizeWrite: async () => false,
    }));

    expect(result).toEqual({ ok: false, code: 'CAPABILITY_DISABLED' });
    expect(mounted.select.selectedIndex).toBe(0);
    expect(host.events).toEqual([]);
  });

  it('reports MAY_HAVE_CHANGED and never restores when host input chooses a third option', async () => {
    const mounted = mountSelect();
    const transaction = prepare(mounted);
    const host = hostWitnesses(mounted.form);
    mounted.select.addEventListener('input', () => { mounted.select.selectedIndex = 2; });

    const result = await transaction.fillOnly(fillOnlyInput());

    expect(result).toMatchObject({
      ok: false,
      code: 'HOST_REJECTED',
      writeEffect: 'MAY_HAVE_CHANGED',
    });
    expect(mounted.select.selectedIndex).toBe(2);
    expect(host.events).toEqual(['input']);
    expect(host.clickCalls()).toBe(0);
  });

  it('stops before change when the input callback closes the execution fence', async () => {
    const mounted = mountSelect();
    const transaction = prepare(mounted);
    const events: string[] = [];
    let submitted = false;
    mounted.select.addEventListener('input', () => {
      events.push('input');
      submitted = true;
    });
    mounted.select.addEventListener('change', () => events.push('change'));

    const result = await transaction.fillOnly(fillOnlyInput({
      executionFence: () => submitted ? 'HOST_SUBMITTED' : null,
    }));

    expect(result).toEqual({
      ok: false,
      code: 'HOST_REJECTED',
      writeEffect: 'MAY_HAVE_CHANGED',
    });
    expect(mounted.select.selectedIndex).toBe(1);
    expect(events).toEqual(['input']);
  });
});

describe('native select targeted Undo', () => {
  it('restores the exact prior option with its own input/change settle envelope', async () => {
    const mounted = mountSelect({ duplicateValues: true });
    const transaction = prepare(mounted);
    const result = await transaction.write(normalWrite(mounted.select));
    expect(result.ok).toBe(true);
    if (!result.ok || result.value.undo === null) return;
    const events: string[] = [];
    mounted.select.addEventListener('input', () => events.push('input'));
    mounted.select.addEventListener('change', () => events.push('change'));
    let settles = 0;

    await expect(result.value.undo.restorePreWrite({
      authority: undoAuthority(),
      settle: () => { settles += 1; },
    })).resolves.toEqual({ ok: true });

    expect(mounted.select.selectedIndex).toBe(0);
    expect(mounted.select.selectedOptions[0]).toBe(mounted.options[0]);
    expect(events).toEqual(['input', 'change']);
    expect(settles).toBeGreaterThanOrEqual(1);
    expect(result.value.undo.isAtPreWriteState()).toBe(true);
  });

  it.each(['event', 'silent'] as const)('does not overwrite a later same-value third state (%s)', async (kind) => {
    const mounted = mountSelect({ duplicateValues: true });
    const transaction = prepare(mounted);
    const result = await transaction.write(normalWrite(mounted.select));
    expect(result.ok).toBe(true);
    if (!result.ok || result.value.undo === null) return;
    mounted.select.selectedIndex = 2;
    if (kind === 'event') mounted.select.dispatchEvent(new Event('change', { bubbles: true }));
    const events: string[] = [];
    mounted.select.addEventListener('input', () => events.push('input'));
    mounted.select.addEventListener('change', () => events.push('change'));

    await expect(result.value.undo.restorePreWrite({
      authority: undoAuthority(),
      settle: () => Promise.resolve(),
    }))
      .resolves.toEqual({ ok: false, error: 'UNDO_NOT_OWNED' });

    expect(mounted.select.selectedIndex).toBe(2);
    expect(mounted.select.selectedOptions[0]).toBe(mounted.options[2]);
    expect(events).toEqual([]);
  });

  it('does not re-arm Undo after an observed silent third state returns to the written option', async () => {
    const mounted = mountSelect({ duplicateValues: true });
    const transaction = prepare(mounted);
    const result = await transaction.write(normalWrite(mounted.select));
    expect(result.ok).toBe(true);
    if (!result.ok || result.value.undo === null) return;
    mounted.select.selectedIndex = 2;
    expect(result.value.undo.isAtWrittenState()).toBe(false);
    mounted.select.selectedIndex = 1;
    const events: string[] = [];
    mounted.select.addEventListener('input', () => events.push('input'));
    mounted.select.addEventListener('change', () => events.push('change'));

    await expect(result.value.undo.restorePreWrite({
      authority: undoAuthority(),
      settle: () => Promise.resolve(),
    })).resolves.toEqual({ ok: false, error: 'UNDO_NOT_OWNED' });

    expect(mounted.select.selectedOptions[0]).toBe(mounted.options[1]);
    expect(events).toEqual([]);
  });

  it('stops Undo before change when the input callback moves to a third semantic state', async () => {
    const mounted = mountSelect({ duplicateValues: true });
    const transaction = prepare(mounted);
    const result = await transaction.write(normalWrite(mounted.select));
    expect(result.ok).toBe(true);
    if (!result.ok || result.value.undo === null) return;
    const events: string[] = [];
    mounted.select.addEventListener('input', () => {
      events.push('input');
      mounted.select.selectedIndex = 2;
    });
    mounted.select.addEventListener('change', () => events.push('change'));

    await expect(result.value.undo.restorePreWrite({
      authority: undoAuthority(),
      settle: () => Promise.resolve(),
    })).resolves.toEqual({ ok: false, error: 'UNDO_VERIFY_FAILED' });

    expect(mounted.select.selectedOptions[0]).toBe(mounted.options[2]);
    expect(events).toEqual(['input']);
  });

  it('does not restore after the session submission fence closes', async () => {
    const mounted = mountSelect({ duplicateValues: true });
    const transaction = prepare(mounted);
    let submitted = false;
    const result = await transaction.write(normalWrite(mounted.select, {
      executionFence: () => submitted ? 'HOST_SUBMITTED' : null,
    }));
    expect(result.ok).toBe(true);
    if (!result.ok || result.value.undo === null) return;
    submitted = true;
    const events: string[] = [];
    mounted.select.addEventListener('input', () => events.push('input'));
    mounted.select.addEventListener('change', () => events.push('change'));

    await expect(result.value.undo.restorePreWrite({
      authority: undoAuthority(),
      settle: () => Promise.resolve(),
    })).resolves.toEqual({ ok: false, error: 'HOST_SUBMITTED' });

    expect(mounted.select.selectedOptions[0]).toBe(mounted.options[1]);
    expect(events).toEqual([]);
  });

  it('re-checks Undo authority after its execution callback and before the restore setter', async () => {
    const mounted = mountSelect({ duplicateValues: true });
    const transaction = prepare(mounted);
    let pendingUndoAuthority: HostWriteAuthority | null = null;
    const result = await transaction.write(normalWrite(mounted.select, {
      executionFence: () => {
        if (pendingUndoAuthority) releaseAuthority(pendingUndoAuthority);
        return null;
      },
    }));
    expect(result.ok).toBe(true);
    if (!result.ok || result.value.undo === null) return;
    pendingUndoAuthority = undoAuthority();
    const events: string[] = [];
    mounted.select.addEventListener('input', () => events.push('input'));
    mounted.select.addEventListener('change', () => events.push('change'));

    await expect(result.value.undo.restorePreWrite({
      authority: pendingUndoAuthority,
      settle: () => Promise.resolve(),
    })).resolves.toEqual({ ok: false, error: 'GESTURE_UNTRUSTED' });

    expect(mounted.select.selectedOptions[0]).toBe(mounted.options[1]);
    expect(events).toEqual([]);
  });

  it('sanitizes caller restore properties before the final fence-to-setter proof window', async () => {
    const mounted = mountSelect({ duplicateValues: true });
    const transaction = prepare(mounted);
    let submitted = false;
    const result = await transaction.write(normalWrite(mounted.select, {
      executionFence: () => submitted ? 'HOST_SUBMITTED' : null,
    }));
    expect(result.ok).toBe(true);
    if (!result.ok || result.value.undo === null) return;
    const authority = undoAuthority();
    const events: string[] = [];
    mounted.select.addEventListener('input', () => events.push('input'));
    mounted.select.addEventListener('change', () => events.push('change'));

    await expect(result.value.undo.restorePreWrite({
      authority,
      get operationTimeoutMs() {
        submitted = true;
        return 1_000;
      },
      settle: () => Promise.resolve(),
    })).resolves.toEqual({ ok: false, error: 'HOST_SUBMITTED' });

    expect(mounted.select.selectedOptions[0]).toBe(mounted.options[1]);
    expect(events).toEqual([]);
  });
});
