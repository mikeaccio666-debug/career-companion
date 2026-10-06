import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  prepareChoiceGroup,
  type ChoiceGroup,
  type ChoiceAnswer,
  type ChoiceGroupUndoRestoreInput,
  type ChoiceWriteBoundary,
  type ChoiceGroupWriteInput,
  type PrepareChoiceGroupInput,
} from '../src/write/choiceGroup';

const settleImmediately = () => Promise.resolve();

interface MountedGroup {
  readonly form: HTMLFormElement;
  readonly inputs: readonly HTMLInputElement[];
}

function mountGroup(input: {
  readonly kind: 'radio' | 'checkbox';
  readonly name?: string;
  readonly checked?: readonly number[];
  readonly required?: boolean;
  readonly formId?: string;
}): MountedGroup {
  const form = document.createElement('form');
  form.id = input.formId ?? 'choice-form';
  const checked = new Set(input.checked ?? []);
  const inputs = ['A', 'B', 'C'].map((value, index) => {
    const element = document.createElement('input');
    element.type = input.kind;
    element.name = input.name ?? 'shared-question';
    element.value = value.toLowerCase();
    element.required = input.required === true;
    element.checked = checked.has(index);
    form.append(element);
    return element;
  });
  document.body.append(form);
  return { form, inputs };
}

function prepare(
  mounted: MountedGroup,
  questionId = 'question.shift',
  optionIds: readonly string[] = ['A', 'B', 'C'],
): ChoiceGroup {
  const result = prepareChoiceGroup({
    questionId,
    options: mounted.inputs.map((element, index) => ({
      element,
      optionId: optionIds[index]!,
    })),
  });
  expect(result, result.ok ? '' : result.error).toMatchObject({ ok: true });
  if (!result.ok) throw new Error(result.error);
  return result.value;
}

function checked(mounted: MountedGroup): readonly boolean[] {
  return mounted.inputs.map((input) => input.checked);
}

function indeterminate(mounted: MountedGroup): readonly boolean[] {
  return mounted.inputs.map((input) => input.indeterminate);
}

function wrapInFieldset(mounted: MountedGroup, disabled = false): HTMLFieldSetElement {
  const fieldset = document.createElement('fieldset');
  fieldset.disabled = disabled;
  fieldset.append(...mounted.inputs);
  mounted.form.append(fieldset);
  return fieldset;
}

/**
 * happy-dom does not currently model disabled-fieldset inheritance. Production
 * code must still use native `:disabled`; this seam makes that native query
 * deterministic while retaining the first-legend exception in focused tests.
 */
function mockNativeEffectiveDisabled(): void {
  const nativeMatches = Element.prototype.matches;
  vi.spyOn(Element.prototype, 'matches').mockImplementation(function (
    this: Element,
    selector: string,
  ): boolean {
    if (selector !== ':disabled' || !(this instanceof HTMLInputElement)) {
      return nativeMatches.call(this, selector);
    }
    if (this.disabled) return true;
    const fieldset = this.closest('fieldset');
    if (fieldset?.disabled !== true) return false;
    const firstLegend = [...fieldset.children]
      .find((child): child is HTMLLegendElement => child instanceof HTMLLegendElement);
    return firstLegend?.contains(this) !== true;
  });
}

function useDeterministicDefaultSettle(onFrame?: (frame: number) => void): void {
  let frame = 0;
  vi.useFakeTimers();
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) =>
    setTimeout(() => {
      frame += 1;
      onFrame?.(frame);
      callback(0);
    }, 0) as unknown as number);
  vi.stubGlobal('cancelAnimationFrame', (handle: number) =>
    clearTimeout(handle as unknown as ReturnType<typeof setTimeout>));
}

function watchHostActions(form: HTMLFormElement): {
  readonly events: readonly string[];
  readonly submitEvents: () => number;
  readonly nativeSubmitCalls: () => number;
  readonly requestSubmitCalls: () => number;
  readonly clickCalls: () => number;
} {
  const events: string[] = [];
  let submitEvents = 0;
  form.addEventListener('input', () => events.push('input'));
  form.addEventListener('change', () => events.push('change'));
  form.addEventListener('submit', (event) => {
    submitEvents += 1;
    event.preventDefault();
  });
  const nativeSubmit = vi.spyOn(HTMLFormElement.prototype, 'submit');
  const requestSubmit = vi.spyOn(HTMLFormElement.prototype, 'requestSubmit');
  const click = vi.spyOn(HTMLElement.prototype, 'click');
  return {
    events,
    submitEvents: () => submitEvents,
    nativeSubmitCalls: () => nativeSubmit.mock.calls.length,
    requestSubmitCalls: () => requestSubmit.mock.calls.length,
    clickCalls: () => click.mock.calls.length,
  };
}

function fillOnlyInput(
  answer: ChoiceAnswer,
  overrides: Partial<Parameters<ChoiceGroup['fillOnly']>[0]> = {},
): Parameters<ChoiceGroup['fillOnly']>[0] {
  return {
    answer,
    authorizeWrite: async () => true,
    readHostValidation: () => ({ ariaInvalid: 'false' }),
    executionFence: () => null,
    lateRecheckMs: 1,
    operationTimeoutMs: 100,
    settle: async () => undefined,
    lateRecheckDelay: async () => undefined,
    ...overrides,
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

describe('choice-group fill-only write', () => {
  const answer = Object.freeze({ kind: 'SINGLE_CHOICE' as const, optionId: 'B' });

  it('fills one empty radio group without creating or requiring Undo', async () => {
    const mounted = mountGroup({ kind: 'radio' });
    const group = prepare(mounted);
    const host = watchHostActions(mounted.form);

    const result = await group.fillOnly(fillOnlyInput(answer));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(checked(mounted)).toEqual([false, true, false]);
    expect(host.events).toEqual(['input', 'change']);
    expect(result.observation.check()).toBeNull();
    expect(result.observation.finalize()).toBeNull();
    result.observation.dispose();
    expect(checked(mounted)).toEqual([false, true, false]);
    expect(host.clickCalls()).toBe(0);
    expect(host.nativeSubmitCalls()).toBe(0);
    expect(host.requestSubmitCalls()).toBe(0);
  });

  it('does not write when fresh authorization is denied', async () => {
    const mounted = mountGroup({ kind: 'radio' });
    const group = prepare(mounted);
    const host = watchHostActions(mounted.form);

    const result = await group.fillOnly(fillOnlyInput(answer, {
      authorizeWrite: async () => false,
    }));

    expect(result).toEqual({ ok: false, code: 'CAPABILITY_DISABLED' });
    expect(checked(mounted)).toEqual([false, false, false]);
    expect(host.events).toEqual([]);
  });

  it('reports MAY_HAVE_CHANGED and never restores a host-selected third option', async () => {
    const mounted = mountGroup({ kind: 'radio' });
    const group = prepare(mounted);
    const host = watchHostActions(mounted.form);
    mounted.form.addEventListener('input', () => { mounted.inputs[2]!.checked = true; });

    const result = await group.fillOnly(fillOnlyInput(answer));

    expect(result).toMatchObject({
      ok: false,
      code: 'HOST_REJECTED',
      writeEffect: 'MAY_HAVE_CHANGED',
    });
    expect(checked(mounted)).toEqual([false, false, true]);
    expect(host.events).toEqual(['input']);
    expect(host.clickCalls()).toBe(0);
  });

  it('stops before change when the input callback closes the execution fence', async () => {
    const mounted = mountGroup({ kind: 'radio' });
    const group = prepare(mounted);
    const events: string[] = [];
    let submitted = false;
    mounted.inputs[1]!.addEventListener('input', () => {
      events.push('input');
      submitted = true;
    });
    mounted.inputs[1]!.addEventListener('change', () => events.push('change'));

    const result = await group.fillOnly(fillOnlyInput(answer, {
      executionFence: () => submitted ? 'HOST_SUBMITTED' : null,
    }));

    expect(result).toEqual({
      ok: false,
      code: 'HOST_REJECTED',
      writeEffect: 'MAY_HAVE_CHANGED',
    });
    expect(checked(mounted)).toEqual([false, true, false]);
    expect(events).toEqual(['input']);
  });

  it('preserves an existing answer instead of replacing it', async () => {
    const mounted = mountGroup({ kind: 'radio', checked: [0] });
    const group = prepare(mounted);
    const host = watchHostActions(mounted.form);

    const result = await group.fillOnly(fillOnlyInput(answer));

    expect(result).toEqual({ ok: false, code: 'IDENTITY_CHANGED' });
    expect(checked(mounted)).toEqual([true, false, false]);
    expect(host.events).toEqual([]);
  });
});

describe('logical choice-question identity and complete membership', () => {
  it('counts all same-name required radio options as one logical question', () => {
    const mounted = mountGroup({ kind: 'radio', checked: [0], required: true });
    const group = prepare(mounted);

    expect(group.questionId).toBe('question.shift');
    expect(group.kind).toBe('radio');
    expect(group.optionIds).toEqual(['A', 'B', 'C']);
    expect(group.measurement).toEqual({ logicalQuestions: 1, requiredQuestions: 1 });
  });

  it('counts all same-name checkbox options as one logical question', () => {
    const mounted = mountGroup({ kind: 'checkbox', checked: [0, 2], required: true });
    const group = prepare(mounted, 'question.schedule');

    expect(group.kind).toBe('checkbox');
    expect(group.measurement).toEqual({ logicalQuestions: 1, requiredQuestions: 1 });
    expect(group.optionIds).toHaveLength(3);
  });

  it('rejects an omitted same-name sibling instead of treating raw inputs as separate questions', () => {
    const mounted = mountGroup({ kind: 'radio', checked: [0] });
    const result = prepareChoiceGroup({
      questionId: 'question.shift',
      options: mounted.inputs.slice(0, 2).map((element, index) => ({
        element,
        optionId: ['A', 'B'][index]!,
      })),
    });

    expect(result).toEqual({ ok: false, error: 'INCOMPLETE_OPTION_MEMBERSHIP' });
    expect(checked(mounted)).toEqual([true, false, false]);
  });

  it('rejects duplicate option IDs and mixed group identity with zero writes', () => {
    const mounted = mountGroup({ kind: 'checkbox', checked: [0] });
    const duplicate = prepareChoiceGroup({
      questionId: 'question.schedule',
      options: mounted.inputs.map((element, index) => ({
        element,
        optionId: index === 2 ? 'B' : ['A', 'B'][index]!,
      })),
    });
    expect(duplicate).toEqual({ ok: false, error: 'DUPLICATE_OPTION_ID' });

    mounted.inputs[2]!.name = 'another-question';
    const mixed = prepareChoiceGroup({
      questionId: 'question.schedule',
      options: mounted.inputs.map((element, index) => ({
        element,
        optionId: ['A', 'B', 'C'][index]!,
      })),
    });
    expect(mixed).toEqual({ ok: false, error: 'MIXED_GROUP_IDENTITY' });
    expect(checked(mounted)).toEqual([true, false, false]);
  });

  it('returns a stable Result for hostile prepare input and option getters', () => {
    const mounted = mountGroup({ kind: 'checkbox', checked: [0] });
    const hostileQuestion = {
      options: mounted.inputs.map((element, index) => ({
        element,
        optionId: ['A', 'B', 'C'][index]!,
      })),
    } as unknown as PrepareChoiceGroupInput;
    Object.defineProperty(hostileQuestion, 'questionId', {
      get: () => { throw new Error('controlled hostile question getter'); },
    });
    expect(() => prepareChoiceGroup(hostileQuestion)).not.toThrow();
    expect(prepareChoiceGroup(hostileQuestion)).toEqual({
      ok: false,
      error: 'GROUP_STATE_UNAVAILABLE',
    });

    const hostileOption = {
      questionId: 'question.hostile-option',
      options: mounted.inputs.map((element, index) => ({
        element,
        optionId: ['A', 'B', 'C'][index]!,
      })),
    } as PrepareChoiceGroupInput;
    Object.defineProperty(hostileOption.options[1]!, 'optionId', {
      get: () => { throw new Error('controlled hostile option getter'); },
    });
    expect(() => prepareChoiceGroup(hostileOption)).not.toThrow();
    expect(prepareChoiceGroup(hostileOption)).toEqual({
      ok: false,
      error: 'GROUP_STATE_UNAVAILABLE',
    });
    expect(checked(mounted)).toEqual([true, false, false]);
  });

  it('bypasses a pre-prepare target wrapper that selectively hides reset', async () => {
    const mounted = mountGroup({ kind: 'radio', checked: [0] });
    mounted.inputs[0]!.defaultChecked = false;
    mounted.inputs[1]!.defaultChecked = true;
    mounted.inputs[2]!.defaultChecked = false;
    mounted.inputs[0]!.checked = true;
    mounted.inputs[1]!.checked = false;
    const nativeAdd = window.addEventListener.bind(window);
    vi.spyOn(window, 'addEventListener').mockImplementation(function (
      this: Window,
      type: string,
      listener: EventListenerOrEventListenerObject | null,
      options?: boolean | AddEventListenerOptions,
    ) {
      if (type === 'reset') return;
      if (listener !== null) nativeAdd(type, listener, options);
    });

    const group = prepare(mounted, 'question.hidden-reset');
    const result = await group.write({
      boundary: 'ORDINARY_REVERSIBLE',
      answer: { kind: 'SINGLE_CHOICE', optionId: 'B' },
      settle: settleImmediately,
    });
    expect(result.ok).toBe(true);
    if (!result.ok || result.value.undo === null) return;

    mounted.form.reset();

    expect(checked(mounted)).toEqual([false, true, false]);
    expect(result.value.undo.wasExternallyEdited()).toBe(true);
    await expect(result.value.undo.restorePreWrite({ settle: settleImmediately })).resolves.toEqual({
      ok: false,
      error: 'UNDO_NOT_OWNED',
    });
  });
});

describe('atomic semantic write and readback', () => {
  it('writes one radio answer from a full-group snapshot and emits no click or submit', async () => {
    const mounted = mountGroup({ kind: 'radio', checked: [0] });
    const group = prepare(mounted);
    const host = watchHostActions(mounted.form);
    const vectorsAtEvent: boolean[][] = [];
    mounted.form.addEventListener('input', () => vectorsAtEvent.push([...checked(mounted)]));
    mounted.form.addEventListener('change', () => vectorsAtEvent.push([...checked(mounted)]));

    const result = await group.write({
      boundary: 'ORDINARY_REVERSIBLE',
      answer: { kind: 'SINGLE_CHOICE', optionId: 'B' },
      settle: settleImmediately,
    });

    expect(result, result.ok ? '' : result.error).toMatchObject({ ok: true });
    if (!result.ok) return;
    expect(result.value.before.selectedOptionIds).toEqual(['A']);
    expect(result.value.readback.selectedOptionIds).toEqual(['B']);
    expect(checked(mounted)).toEqual([false, true, false]);
    expect(vectorsAtEvent.length).toBeGreaterThan(0);
    expect(vectorsAtEvent.every((vector) => vector.join() === 'false,true,false')).toBe(true);
    expect(new Set(host.events)).toEqual(new Set(['input', 'change']));
    expect(host.clickCalls()).toBe(0);
    expect(host.submitEvents()).toBe(0);
    expect(host.nativeSubmitCalls()).toBe(0);
    expect(host.requestSubmitCalls()).toBe(0);
  });

  it('writes a checkbox set as one semantic result and retains the whole pre-write snapshot', async () => {
    const mounted = mountGroup({ kind: 'checkbox', checked: [0, 2] });
    const group = prepare(mounted, 'question.schedule');

    const result = await group.write({
      boundary: 'ORDINARY_REVERSIBLE',
      answer: { kind: 'MULTI_CHOICE', optionIds: ['B', 'C'] },
      settle: settleImmediately,
    });

    expect(result, result.ok ? '' : result.error).toMatchObject({ ok: true });
    if (!result.ok) return;
    expect(result.value.before.selectedOptionIds).toEqual(['A', 'C']);
    expect(result.value.readback.selectedOptionIds).toEqual(['B', 'C']);
    expect(checked(mounted)).toEqual([false, true, true]);
    expect(result.value.undo).not.toBeNull();
  });

  it('treats checkbox indeterminate as semantic state and restores it with owned Undo', async () => {
    const mounted = mountGroup({ kind: 'checkbox', checked: [0] });
    mounted.inputs[0]!.indeterminate = true;
    const group = prepare(mounted, 'question.schedule');
    const host = watchHostActions(mounted.form);

    const result = await group.write({
      boundary: 'ORDINARY_REVERSIBLE',
      answer: { kind: 'MULTI_CHOICE', optionIds: ['A'] },
      settle: settleImmediately,
    });

    expect(result, result.ok ? '' : result.error).toMatchObject({ ok: true });
    if (!result.ok) return;
    expect(result.value.undo).not.toBeNull();
    if (result.value.undo === null) return;
    expect(result.value.before).toEqual({
      selectedOptionIds: ['A'],
      indeterminateOptionIds: ['A'],
    });
    expect(result.value.readback).toEqual({
      selectedOptionIds: ['A'],
      indeterminateOptionIds: [],
    });
    expect(checked(mounted)).toEqual([true, false, false]);
    expect(indeterminate(mounted)).toEqual([false, false, false]);
    expect(new Set(host.events)).toEqual(new Set(['input', 'change']));

    await expect(result.value.undo.restorePreWrite({ settle: settleImmediately })).resolves.toEqual({
      ok: true,
    });
    expect(checked(mounted)).toEqual([true, false, false]);
    expect(indeterminate(mounted)).toEqual([true, false, false]);
  });

  it('selects by opaque caller IDs rather than misleading or duplicate DOM values', async () => {
    const mounted = mountGroup({ kind: 'radio', checked: [0] });
    for (const element of mounted.inputs) element.value = 'duplicate-host-value';
    const group = prepare(mounted, 'question.shift', ['night', 'morning', 'swing']);

    const result = await group.write({
      boundary: 'ORDINARY_REVERSIBLE',
      answer: { kind: 'SINGLE_CHOICE', optionId: 'morning' },
      settle: settleImmediately,
    });

    expect(result, result.ok ? '' : result.error).toMatchObject({ ok: true });
    expect(checked(mounted)).toEqual([false, true, false]);
    if (result.ok) expect(result.value.readback.selectedOptionIds).toEqual(['morning']);
  });

  it('fails closed when membership changes after preparation and emits no host event', async () => {
    const mounted = mountGroup({ kind: 'radio', checked: [0] });
    const group = prepare(mounted);
    const host = watchHostActions(mounted.form);
    const added = document.createElement('input');
    added.type = 'radio';
    added.name = 'shared-question';
    added.value = 'd';
    mounted.form.append(added);

    const result = await group.write({
      boundary: 'ORDINARY_REVERSIBLE',
      answer: { kind: 'SINGLE_CHOICE', optionId: 'B' },
      settle: settleImmediately,
    });

    expect(result).toEqual({ ok: false, error: 'GROUP_IDENTITY_CHANGED' });
    expect(checked(mounted)).toEqual([true, false, false]);
    expect(host.events).toEqual([]);
  });

  it('returns a stable failure when hostile membership access throws after publication', async () => {
    const mounted = mountGroup({ kind: 'radio', checked: [0] });
    const group = prepare(mounted);
    mounted.inputs[0]!.addEventListener('input', () => {
      const poison = document.createElement('input');
      poison.type = 'radio';
      poison.name = 'shared-question';
      Object.defineProperty(poison, 'form', {
        configurable: true,
        get: () => { throw new Error('controlled hostile form getter'); },
      });
      mounted.form.append(poison);
    });

    await expect(group.write({
      boundary: 'ORDINARY_REVERSIBLE',
      answer: { kind: 'SINGLE_CHOICE', optionId: 'B' },
      settle: settleImmediately,
    })).resolves.toEqual({ ok: false, error: 'WRITE_AUTHORITY_LOST' });
    expect(checked(mounted)).toEqual([false, true, false]);
  });

  it('rejects a group disabled by an ancestor before preparation with zero mutation', async () => {
    mockNativeEffectiveDisabled();
    const mounted = mountGroup({ kind: 'checkbox', checked: [0] });
    wrapInFieldset(mounted, true);
    const group = prepare(mounted, 'question.schedule');
    const host = watchHostActions(mounted.form);

    const result = await group.write({
      boundary: 'ORDINARY_REVERSIBLE',
      answer: { kind: 'MULTI_CHOICE', optionIds: ['B'] },
      settle: settleImmediately,
    });

    expect(result).toEqual({ ok: false, error: 'TARGET_NOT_WRITABLE' });
    expect(checked(mounted)).toEqual([true, false, false]);
    expect(host.events).toEqual([]);
  });

  it('fails closed with zero mutation when an ancestor becomes disabled after preparation', async () => {
    mockNativeEffectiveDisabled();
    const mounted = mountGroup({ kind: 'checkbox', checked: [0] });
    const fieldset = wrapInFieldset(mounted);
    const group = prepare(mounted, 'question.schedule');
    const host = watchHostActions(mounted.form);
    fieldset.disabled = true;

    const result = await group.write({
      boundary: 'ORDINARY_REVERSIBLE',
      answer: { kind: 'MULTI_CHOICE', optionIds: ['B'] },
      settle: settleImmediately,
    });

    expect(result).toEqual({ ok: false, error: 'GROUP_IDENTITY_CHANGED' });
    expect(checked(mounted)).toEqual([true, false, false]);
    expect(host.events).toEqual([]);
  });

  it('preserves the native disabled-fieldset first-legend exception', async () => {
    mockNativeEffectiveDisabled();
    const mounted = mountGroup({ kind: 'radio', checked: [0] });
    const fieldset = wrapInFieldset(mounted, true);
    const legend = document.createElement('legend');
    legend.append(...mounted.inputs);
    fieldset.prepend(legend);
    const group = prepare(mounted);

    const result = await group.write({
      boundary: 'ORDINARY_REVERSIBLE',
      answer: { kind: 'SINGLE_CHOICE', optionId: 'B' },
      settle: settleImmediately,
    });

    expect(result, result.ok ? '' : result.error).toMatchObject({ ok: true });
    expect(checked(mounted)).toEqual([false, true, false]);
  });

  it('loses authority without compensation when an ancestor disables after publication starts', async () => {
    mockNativeEffectiveDisabled();
    const mounted = mountGroup({ kind: 'radio', checked: [0] });
    const fieldset = wrapInFieldset(mounted);
    const group = prepare(mounted);
    mounted.inputs[0]!.addEventListener('input', () => {
      fieldset.disabled = true;
    });

    const result = await group.write({
      boundary: 'ORDINARY_REVERSIBLE',
      answer: { kind: 'SINGLE_CHOICE', optionId: 'B' },
      settle: settleImmediately,
    });

    expect(result).toEqual({ ok: false, error: 'WRITE_AUTHORITY_LOST' });
    expect(checked(mounted)).toEqual([false, true, false]);
  });

  it('restores the full snapshot when the host synchronously reverts an owned checkbox write', async () => {
    const mounted = mountGroup({ kind: 'checkbox', checked: [0] });
    const group = prepare(mounted, 'question.schedule');
    mounted.inputs[1]!.addEventListener('input', () => {
      mounted.inputs[0]!.checked = true;
      mounted.inputs[1]!.checked = false;
      mounted.inputs[2]!.checked = false;
    });

    const result = await group.write({
      boundary: 'ORDINARY_REVERSIBLE',
      answer: { kind: 'MULTI_CHOICE', optionIds: ['B', 'C'] },
      settle: settleImmediately,
    });

    expect(result).toEqual({ ok: false, error: 'WRITE_REVERTED' });
    expect(checked(mounted)).toEqual([true, false, false]);
  });

  it('revalidates a reverted write after hostile observer cleanup mutates state', async () => {
    const mounted = mountGroup({ kind: 'radio', checked: [0] });
    const nativeRemove = EventTarget.prototype.removeEventListener;
    let armed = false;
    let mutated = false;
    vi.spyOn(EventTarget.prototype, 'removeEventListener').mockImplementation(function (
      this: EventTarget,
      type: string,
      listener: EventListenerOrEventListenerObject | null,
      options?: boolean | EventListenerOptions,
    ) {
      nativeRemove.call(this, type, listener, options);
      if (armed && !mutated && this === document) {
        mutated = true;
        mounted.inputs[2]!.checked = true;
      }
    });
    const group = prepare(mounted);
    mounted.inputs[0]!.addEventListener('input', () => {
      mounted.inputs[0]!.checked = true;
    });
    armed = true;

    const result = await group.write({
      boundary: 'ORDINARY_REVERSIBLE',
      answer: { kind: 'SINGLE_CHOICE', optionId: 'B' },
      settle: settleImmediately,
    });

    expect(result).toEqual({ ok: false, error: 'WRITE_AUTHORITY_LOST' });
    expect(checked(mounted)).toEqual([false, false, true]);
  });

  it('fails semantic readback when the host makes a checkbox indeterminate', async () => {
    const mounted = mountGroup({ kind: 'checkbox', checked: [0] });
    const group = prepare(mounted, 'question.schedule');
    mounted.inputs[1]!.addEventListener('change', () => {
      mounted.inputs[1]!.indeterminate = true;
    });

    const result = await group.write({
      boundary: 'ORDINARY_REVERSIBLE',
      answer: { kind: 'MULTI_CHOICE', optionIds: ['B'] },
      settle: settleImmediately,
    });

    expect(result).toEqual({ ok: false, error: 'WRITE_AUTHORITY_LOST' });
    expect(checked(mounted)).toEqual([false, true, false]);
    expect(indeterminate(mounted)).toEqual([false, true, false]);
  });

  it('does not overwrite a third state introduced by the host during readback', async () => {
    const mounted = mountGroup({ kind: 'radio', checked: [0] });
    const group = prepare(mounted);
    mounted.inputs[1]!.addEventListener('change', () => {
      mounted.inputs[2]!.checked = true;
    });

    const result = await group.write({
      boundary: 'ORDINARY_REVERSIBLE',
      answer: { kind: 'SINGLE_CHOICE', optionId: 'B' },
      settle: settleImmediately,
    });

    expect(result).toEqual({ ok: false, error: 'WRITE_AUTHORITY_LOST' });
    expect(checked(mounted)).toEqual([false, false, true]);
  });

  it('does not grant success when a later host event occurs during settle even if the vector matches', async () => {
    const mounted = mountGroup({ kind: 'radio', checked: [0] });
    const group = prepare(mounted);

    const result = await group.write({
      boundary: 'ORDINARY_REVERSIBLE',
      answer: { kind: 'SINGLE_CHOICE', optionId: 'B' },
      settle: () => {
        // A controlled host may re-emit an event after its render while ending
        // on the same boolean vector. Equality alone must not grant ownership.
        mounted.inputs[1]!.dispatchEvent(new Event('change', { bubbles: true }));
      },
    });

    expect(result).toEqual({ ok: false, error: 'WRITE_AUTHORITY_LOST' });
    expect(checked(mounted)).toEqual([false, true, false]);
  });

  it('keeps the transaction observable when an ancestor stops the expected event before target', async () => {
    const mounted = mountGroup({ kind: 'radio', checked: [0] });
    const group = prepare(mounted);
    mounted.form.addEventListener('input', (event) => event.stopPropagation(), true);
    mounted.form.addEventListener('change', (event) => event.stopPropagation(), true);

    const result = await group.write({
      boundary: 'ORDINARY_REVERSIBLE',
      answer: { kind: 'SINGLE_CHOICE', optionId: 'B' },
      settle: settleImmediately,
    });

    expect(result, result.ok ? '' : result.error).toMatchObject({ ok: true });
    expect(checked(mounted)).toEqual([false, true, false]);
    if (result.ok) expect(result.value.undo).not.toBeNull();
  });

  it('rejects a nested same-target/type event that arrives before the exact dispatched event', async () => {
    const mounted = mountGroup({ kind: 'radio', checked: [0] });
    const group = prepare(mounted);
    let nested = false;
    const intercept = (event: Event) => {
      if (nested) return;
      nested = true;
      event.target?.dispatchEvent(new Event('input', { bubbles: true }));
      nested = false;
      event.stopImmediatePropagation();
    };
    document.addEventListener('input', intercept, true);

    const result = await group.write({
      boundary: 'ORDINARY_REVERSIBLE',
      answer: { kind: 'SINGLE_CHOICE', optionId: 'B' },
      settle: settleImmediately,
    }).finally(() => document.removeEventListener('input', intercept, true));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe('WRITE_AUTHORITY_LOST');
    expect(result.undo).toBeUndefined();
  });

  it('detects a nested clone hidden from the document observer before the exact event continues', async () => {
    const mounted = mountGroup({ kind: 'radio', checked: [0] });
    const group = prepare(mounted);
    let nested = false;
    const intercept = (event: Event) => {
      if (nested) {
        event.stopImmediatePropagation();
        return;
      }
      nested = true;
      event.target?.dispatchEvent(new Event('input', { bubbles: true }));
      nested = false;
    };
    document.addEventListener('input', intercept, true);

    const result = await group.write({
      boundary: 'ORDINARY_REVERSIBLE',
      answer: { kind: 'SINGLE_CHOICE', optionId: 'B' },
      settle: settleImmediately,
    }).finally(() => document.removeEventListener('input', intercept, true));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe('WRITE_AUTHORITY_LOST');
    expect(result.undo).toBeUndefined();
  });

  it('rejects a second full dispatch of the exact same Event object', async () => {
    const mounted = mountGroup({ kind: 'radio', checked: [0] });
    const group = prepare(mounted);
    const nativeDispatch = mounted.inputs[0]!.dispatchEvent.bind(mounted.inputs[0]!);
    vi.spyOn(mounted.inputs[0]!, 'dispatchEvent').mockImplementation((event) => {
      const accepted = nativeDispatch(event);
      nativeDispatch(event);
      return accepted;
    });

    const result = await group.write({
      boundary: 'ORDINARY_REVERSIBLE',
      answer: { kind: 'SINGLE_CHOICE', optionId: 'B' },
      settle: settleImmediately,
    });

    expect(result).toEqual({ ok: false, error: 'WRITE_AUTHORITY_LOST' });
    expect(checked(mounted)).toEqual([false, true, false]);
  });

  it('rejects exact-object replay when host code poisons currentTarget identity', async () => {
    const mounted = mountGroup({ kind: 'radio', checked: [0] });
    const poisonLayerIdentity = (event: Event) => {
      Object.defineProperty(event, 'currentTarget', {
        configurable: true,
        get: () => new EventTarget(),
      });
    };
    document.addEventListener('input', poisonLayerIdentity, true);
    try {
      const group = prepare(mounted);
      const nativeDispatch = mounted.inputs[0]!.dispatchEvent.bind(mounted.inputs[0]!);
      vi.spyOn(mounted.inputs[0]!, 'dispatchEvent').mockImplementation((event) => {
        const accepted = nativeDispatch(event);
        nativeDispatch(event);
        return accepted;
      });

      const result = await group.write({
        boundary: 'ORDINARY_REVERSIBLE',
        answer: { kind: 'SINGLE_CHOICE', optionId: 'B' },
        settle: settleImmediately,
      });

      expect(result).toEqual({ ok: false, error: 'WRITE_AUTHORITY_LOST' });
      expect(checked(mounted)).toEqual([false, true, false]);
    } finally {
      document.removeEventListener('input', poisonLayerIdentity, true);
    }
  });

  it('latches a nested Event getter failure as external authority loss', async () => {
    class HostileInputEvent extends Event {
      override get target(): EventTarget | null {
        throw new Error('controlled hostile Event target getter');
      }
    }
    const mounted = mountGroup({ kind: 'radio', checked: [0] });
    const group = prepare(mounted);
    let nested = false;
    mounted.inputs[0]!.addEventListener('input', () => {
      if (nested) return;
      nested = true;
      try {
        mounted.inputs[0]!.dispatchEvent(new HostileInputEvent('input', { bubbles: true }));
      } finally {
        nested = false;
      }
    });

    const result = await group.write({
      boundary: 'ORDINARY_REVERSIBLE',
      answer: { kind: 'SINGLE_CHOICE', optionId: 'B' },
      settle: settleImmediately,
    });

    expect(result).toEqual({ ok: false, error: 'WRITE_AUTHORITY_LOST' });
    expect(checked(mounted)).toEqual([false, true, false]);
  });

  it('retains an owned Undo when bounded settle fails after the exact write', async () => {
    const mounted = mountGroup({ kind: 'checkbox', checked: [0] });
    const group = prepare(mounted, 'question.schedule');

    const result = await group.write({
      boundary: 'ORDINARY_REVERSIBLE',
      answer: { kind: 'MULTI_CHOICE', optionIds: ['B', 'C'] },
      settle: () => Promise.reject(new Error('controlled settle failure')),
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe('VERIFY_FAILED');
    expect(result.undo).not.toBeNull();
    expect(checked(mounted)).toEqual([false, true, true]);
    await expect(result.undo?.restorePreWrite({ settle: settleImmediately })).resolves.toEqual({
      ok: true,
    });
    expect(checked(mounted)).toEqual([true, false, false]);
  });

  it('retains exact-owned recovery when dispatch publishes the exact event and then throws', async () => {
    const mounted = mountGroup({ kind: 'radio', checked: [0] });
    const group = prepare(mounted);
    const dispatch = mounted.inputs[0]!.dispatchEvent.bind(mounted.inputs[0]!);
    vi.spyOn(mounted.inputs[0]!, 'dispatchEvent')
      .mockImplementationOnce((event) => {
        dispatch(event);
        throw new Error('controlled dispatch failure');
      });

    const result = await group.write({
      boundary: 'ORDINARY_REVERSIBLE',
      answer: { kind: 'SINGLE_CHOICE', optionId: 'B' },
      settle: settleImmediately,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe('WRITE_REVERTED');
    expect(result.undo).toBeDefined();
    expect(checked(mounted)).toEqual([false, true, false]);
    if (result.undo === undefined) return;
    await expect(result.undo.restorePreWrite({ settle: settleImmediately })).resolves.toEqual({
      ok: true,
    });
    expect(checked(mounted)).toEqual([true, false, false]);
  });

  it('reports verified reversion when an unpublished dispatch throw is recovered and observed', async () => {
    const mounted = mountGroup({ kind: 'checkbox', checked: [0] });
    const group = prepare(mounted, 'question.schedule');
    vi.spyOn(mounted.inputs[0]!, 'dispatchEvent').mockImplementationOnce(() => {
      throw new Error('controlled pre-publication dispatch failure');
    });

    const result = await group.write({
      boundary: 'ORDINARY_REVERSIBLE',
      answer: { kind: 'MULTI_CHOICE', optionIds: ['B'] },
      settle: settleImmediately,
    });

    expect(result).toEqual({ ok: false, error: 'WRITE_REVERTED' });
    expect(checked(mounted)).toEqual([true, false, false]);
  });

  it('does not accept a recovery-event third-state ABA as verified reversion', async () => {
    const mounted = mountGroup({ kind: 'checkbox', checked: [0] });
    const group = prepare(mounted, 'question.schedule');
    vi.spyOn(mounted.inputs[0]!, 'dispatchEvent').mockImplementationOnce(() => {
      throw new Error('controlled pre-publication dispatch failure');
    });
    mounted.form.addEventListener('input', () => {
      mounted.inputs[2]!.checked = true;
    });

    const result = await group.write({
      boundary: 'ORDINARY_REVERSIBLE',
      answer: { kind: 'MULTI_CHOICE', optionIds: ['B'] },
      settle: () => {
        mounted.inputs[0]!.checked = true;
        mounted.inputs[1]!.checked = false;
        mounted.inputs[2]!.checked = false;
      },
    });

    expect(result).toEqual({ ok: false, error: 'WRITE_AUTHORITY_LOST' });
    expect(checked(mounted)).toEqual([true, false, false]);
  });

  it('does not report reversion when publication-unknown recovery settle rejects', async () => {
    const mounted = mountGroup({ kind: 'checkbox', checked: [0] });
    const group = prepare(mounted, 'question.schedule');
    vi.spyOn(mounted.inputs[0]!, 'dispatchEvent').mockImplementationOnce(() => {
      throw new Error('controlled pre-publication dispatch failure');
    });

    const result = await group.write({
      boundary: 'ORDINARY_REVERSIBLE',
      answer: { kind: 'MULTI_CHOICE', optionIds: ['B'] },
      settle: () => Promise.reject(new Error('controlled recovery settle failure')),
    });

    expect(result).toEqual({ ok: false, error: 'WRITE_AUTHORITY_LOST' });
    expect(checked(mounted)).toEqual([true, false, false]);
  });

  it('severs retired observer behavior when a target-own Window wrapper retains it', async () => {
    const mounted = mountGroup({ kind: 'checkbox', checked: [0] });
    const nativeAdd = window.addEventListener.bind(window);
    let retainedInvocations = 0;
    const targetOwnAdd = vi.spyOn(window, 'addEventListener').mockImplementation(function (
      this: Window,
      type: string,
      listener: EventListenerOrEventListenerObject | null,
      options?: boolean | AddEventListenerOptions,
    ) {
      if (listener === null) return;
      nativeAdd(type, (event: Event) => {
        retainedInvocations += 1;
        if (typeof listener === 'function') listener.call(this, event);
        else listener.handleEvent(event);
      }, options);
    });
    const targetOwnRemove = vi.spyOn(window, 'removeEventListener')
      .mockImplementation(() => undefined);
    const group = prepare(mounted, 'question.schedule');

    const result = await group.write({
      boundary: 'ORDINARY_REVERSIBLE',
      answer: { kind: 'MULTI_CHOICE', optionIds: ['B'] },
      settle: settleImmediately,
    });

    expect(result.ok).toBe(true);
    if (!result.ok || result.value.undo === null) return;
    const invocationsBeforeDispose = retainedInvocations;
    result.value.undo.dispose();
    mounted.inputs[0]!.dispatchEvent(new Event('input', { bubbles: true }));

    // 一次注册一种事件类型：OBSERVED_EVENTS 从 5 种变 6 种（2026-09-15 加入
    // `submit`，原生激活期间要按住表单提交），这两个计数跟着变。
    expect(targetOwnAdd).toHaveBeenCalledTimes(6);
    expect(targetOwnRemove).toHaveBeenCalledTimes(6);
    expect(retainedInvocations).toBe(invocationsBeforeDispose + 1);
    expect(result.value.undo.wasExternallyEdited()).toBe(false);
    expect(checked(mounted)).toEqual([false, true, false]);
  });

  it('does not claim reversion when publication-unknown notifications remain unproven', async () => {
    const mounted = mountGroup({ kind: 'checkbox', checked: [0] });
    const descriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'checked');
    if (typeof descriptor?.set !== 'function') throw new Error('checked setter unavailable');
    let setterCalls = 0;
    vi.spyOn(HTMLInputElement.prototype, 'checked', 'set').mockImplementation(function (
      this: HTMLInputElement,
      value: boolean,
    ) {
      setterCalls += 1;
      if (setterCalls === 4) throw new Error('controlled compensation setter failure');
      descriptor.set!.call(this, value);
    });
    const group = prepare(mounted, 'question.schedule');
    const hideInput = (event: Event) => event.stopImmediatePropagation();
    window.addEventListener('input', hideInput, true);

    const result = await group.write({
      boundary: 'ORDINARY_REVERSIBLE',
      answer: { kind: 'MULTI_CHOICE', optionIds: ['B'] },
      settle: settleImmediately,
    }).finally(() => window.removeEventListener('input', hideInput, true));

    expect(result).toEqual({ ok: false, error: 'WRITE_AUTHORITY_LOST' });
    expect(checked(mounted)).toEqual([true, false, false]);
    expect(indeterminate(mounted)).toEqual([false, false, false]);
  });

  it('does not grant recovery after publication-unknown rollback drifts late', async () => {
    useDeterministicDefaultSettle();
    const mounted = mountGroup({ kind: 'checkbox', checked: [0] });
    const group = prepare(mounted, 'question.schedule');
    setTimeout(() => {
      mounted.inputs[0]!.checked = false;
      mounted.inputs[1]!.checked = true;
    }, 0);
    const hideInput = (event: Event) => event.stopImmediatePropagation();
    window.addEventListener('input', hideInput, true);

    const pending = group.write({
      boundary: 'ORDINARY_REVERSIBLE',
      answer: { kind: 'MULTI_CHOICE', optionIds: ['B'] },
    }).finally(() => window.removeEventListener('input', hideInput, true));
    await vi.runAllTimersAsync();
    const result = await pending;

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe('WRITE_AUTHORITY_LOST');
    expect(result.undo).toBeUndefined();
    expect(checked(mounted)).toEqual([false, true, false]);
  });

  it('restores a system-owned unpublished intermediate after a one-shot setter failure', async () => {
    const mounted = mountGroup({ kind: 'checkbox', checked: [0] });
    const host = watchHostActions(mounted.form);
    const descriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'checked');
    if (typeof descriptor?.set !== 'function') throw new Error('checked setter unavailable');
    let setterCalls = 0;
    vi.spyOn(HTMLInputElement.prototype, 'checked', 'set').mockImplementation(function (
      this: HTMLInputElement,
      value: boolean,
    ) {
      setterCalls += 1;
      if (setterCalls === 2) throw new Error('controlled one-shot setter failure');
      descriptor.set!.call(this, value);
    });
    const group = prepare(mounted, 'question.schedule');

    const result = await group.write({
      boundary: 'ORDINARY_REVERSIBLE',
      answer: { kind: 'MULTI_CHOICE', optionIds: ['B', 'C'] },
      settle: settleImmediately,
    });

    expect(result).toEqual({ ok: false, error: 'WRITE_REVERTED' });
    expect(checked(mounted)).toEqual([true, false, false]);
    expect(indeterminate(mounted)).toEqual([false, false, false]);
    expect(host.events).toEqual([]);
  });

  it('reports authority loss when an unpublished owned intermediate cannot be restored', async () => {
    const mounted = mountGroup({ kind: 'checkbox', checked: [0] });
    const host = watchHostActions(mounted.form);
    const descriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'checked');
    if (typeof descriptor?.set !== 'function') throw new Error('checked setter unavailable');
    let setterCalls = 0;
    vi.spyOn(HTMLInputElement.prototype, 'checked', 'set').mockImplementation(function (
      this: HTMLInputElement,
      value: boolean,
    ) {
      setterCalls += 1;
      if (setterCalls >= 2) throw new Error('controlled persistent setter failure');
      descriptor.set!.call(this, value);
    });
    const group = prepare(mounted, 'question.schedule');

    const result = await group.write({
      boundary: 'ORDINARY_REVERSIBLE',
      answer: { kind: 'MULTI_CHOICE', optionIds: ['B', 'C'] },
      settle: settleImmediately,
    });

    expect(result).toEqual({ ok: false, error: 'WRITE_AUTHORITY_LOST' });
    expect(checked(mounted)).toEqual([false, false, false]);
    expect(host.events).toEqual([]);
  });

  it('reports authority loss when publication-unknown compensation stays unavailable', async () => {
    const mounted = mountGroup({ kind: 'checkbox', checked: [0] });
    const descriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'checked');
    if (typeof descriptor?.set !== 'function') throw new Error('checked setter unavailable');
    let setterCalls = 0;
    vi.spyOn(HTMLInputElement.prototype, 'checked', 'set').mockImplementation(function (
      this: HTMLInputElement,
      value: boolean,
    ) {
      setterCalls += 1;
      if (setterCalls >= 3) throw new Error('controlled persistent recovery failure');
      descriptor.set!.call(this, value);
    });
    const group = prepare(mounted, 'question.schedule');
    const hideInput = (event: Event) => event.stopImmediatePropagation();
    window.addEventListener('input', hideInput, true);

    const result = await group.write({
      boundary: 'ORDINARY_REVERSIBLE',
      answer: { kind: 'MULTI_CHOICE', optionIds: ['B'] },
      settle: settleImmediately,
    }).finally(() => window.removeEventListener('input', hideInput, true));

    expect(result).toEqual({ ok: false, error: 'WRITE_AUTHORITY_LOST' });
    expect(checked(mounted)).toEqual([false, true, false]);
  });

  it('tracks and restores a checked setter that mutates before throwing', async () => {
    const mounted = mountGroup({ kind: 'checkbox', checked: [0] });
    const descriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'checked');
    if (typeof descriptor?.set !== 'function') throw new Error('checked setter unavailable');
    let setterCalls = 0;
    vi.spyOn(HTMLInputElement.prototype, 'checked', 'set').mockImplementation(function (
      this: HTMLInputElement,
      value: boolean,
    ) {
      setterCalls += 1;
      descriptor.set!.call(this, value);
      if (setterCalls === 2) throw new Error('controlled post-mutation checked failure');
    });
    const group = prepare(mounted, 'question.schedule');

    const result = await group.write({
      boundary: 'ORDINARY_REVERSIBLE',
      answer: { kind: 'MULTI_CHOICE', optionIds: ['B'] },
      settle: settleImmediately,
    });

    expect(result).toEqual({ ok: false, error: 'WRITE_REVERTED' });
    expect(checked(mounted)).toEqual([true, false, false]);
  });

  it('tracks and restores an indeterminate setter that mutates before throwing', async () => {
    const mounted = mountGroup({ kind: 'checkbox', checked: [0] });
    mounted.inputs[0]!.indeterminate = true;
    const descriptor = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      'indeterminate',
    );
    if (typeof descriptor?.set !== 'function') throw new Error('indeterminate setter unavailable');
    let setterCalls = 0;
    vi.spyOn(HTMLInputElement.prototype, 'indeterminate', 'set').mockImplementation(function (
      this: HTMLInputElement,
      value: boolean,
    ) {
      setterCalls += 1;
      descriptor.set!.call(this, value);
      if (setterCalls === 1) throw new Error('controlled post-mutation indeterminate failure');
    });
    const group = prepare(mounted, 'question.schedule');

    const result = await group.write({
      boundary: 'ORDINARY_REVERSIBLE',
      answer: { kind: 'MULTI_CHOICE', optionIds: ['A'] },
      settle: settleImmediately,
    });

    expect(result).toEqual({ ok: false, error: 'WRITE_REVERTED' });
    expect(checked(mounted)).toEqual([true, false, false]);
    expect(indeterminate(mounted)).toEqual([true, false, false]);
  });

  it('retries unpublished compensation instead of granting an unproven recovery', async () => {
    const mounted = mountGroup({ kind: 'checkbox', checked: [0] });
    const host = watchHostActions(mounted.form);
    const descriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'checked');
    if (typeof descriptor?.set !== 'function') throw new Error('checked setter unavailable');
    let setterCalls = 0;
    vi.spyOn(HTMLInputElement.prototype, 'checked', 'set').mockImplementation(function (
      this: HTMLInputElement,
      value: boolean,
    ) {
      setterCalls += 1;
      if (setterCalls === 2 || setterCalls === 3) {
        throw new Error('controlled forward and compensation failure');
      }
      descriptor.set!.call(this, value);
    });
    const group = prepare(mounted, 'question.schedule');

    const result = await group.write({
      boundary: 'ORDINARY_REVERSIBLE',
      answer: { kind: 'MULTI_CHOICE', optionIds: ['B', 'C'] },
      settle: settleImmediately,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe('WRITE_REVERTED');
    expect(result.undo).toBeUndefined();
    expect(checked(mounted)).toEqual([true, false, false]);
    expect(host.events).toEqual([]);
  });

  it('returns a typed failure and restores the unpublished snapshot when event observation cannot attach', async () => {
    const mounted = mountGroup({ kind: 'checkbox', checked: [0] });
    const group = prepare(mounted, 'question.schedule');
    vi.spyOn(window, 'addEventListener').mockImplementationOnce(() => {
      throw new Error('controlled listener failure');
    });

    const result = await group.write({
      boundary: 'ORDINARY_REVERSIBLE',
      answer: { kind: 'MULTI_CHOICE', optionIds: ['B'] },
      settle: settleImmediately,
    });

    expect(result).toEqual({ ok: false, error: 'WRITE_AUTHORITY_LOST' });
    expect(checked(mounted)).toEqual([true, false, false]);
  });

  it('removes a listener when native registration mutates and then throws', async () => {
    const mounted = mountGroup({ kind: 'checkbox', checked: [0] });
    const nativeAdd = EventTarget.prototype.addEventListener;
    const nativeRemove = EventTarget.prototype.removeEventListener;
    let armed = false;
    const registered = new Map<string, EventListenerOrEventListenerObject>();
    const removed = new Set<string>();
    vi.spyOn(EventTarget.prototype, 'addEventListener').mockImplementation(function (
      this: EventTarget,
      type: string,
      listener: EventListenerOrEventListenerObject | null,
      options?: boolean | AddEventListenerOptions,
    ) {
      nativeAdd.call(this, type, listener, options);
      if (
        armed &&
        this === document &&
        listener !== null &&
        (type === 'beforeinput' || type === 'input')
      ) {
        registered.set(type, listener);
      }
      if (armed && this === document && type === 'input') {
        throw new Error('controlled post-registration failure');
      }
    });
    vi.spyOn(EventTarget.prototype, 'removeEventListener').mockImplementation(function (
      this: EventTarget,
      type: string,
      listener: EventListenerOrEventListenerObject | null,
      options?: boolean | EventListenerOptions,
    ) {
      if (this === document && listener === registered.get(type)) {
        removed.add(type);
      }
      nativeRemove.call(this, type, listener, options);
    });
    const group = prepare(mounted, 'question.schedule');
    armed = true;

    const result = await group.write({
      boundary: 'ORDINARY_REVERSIBLE',
      answer: { kind: 'MULTI_CHOICE', optionIds: ['B'] },
      settle: settleImmediately,
    });

    expect(result).toEqual({ ok: false, error: 'WRITE_AUTHORITY_LOST' });
    expect([...registered.keys()]).toEqual(['beforeinput', 'input']);
    expect(removed).toEqual(new Set(['beforeinput', 'input']));
    expect(checked(mounted)).toEqual([true, false, false]);
  });

  it('does not compensate a host mutation during observer attachment as transaction-owned', async () => {
    const mounted = mountGroup({ kind: 'checkbox', checked: [0] });
    const nativeAdd = EventTarget.prototype.addEventListener;
    let armed = false;
    vi.spyOn(EventTarget.prototype, 'addEventListener').mockImplementation(function (
      this: EventTarget,
      type: string,
      listener: EventListenerOrEventListenerObject | null,
      options?: boolean | AddEventListenerOptions,
    ) {
      nativeAdd.call(this, type, listener, options);
      if (armed && this === document && type === 'beforeinput') {
        mounted.inputs[0]!.checked = false;
        mounted.inputs[1]!.checked = false;
        mounted.inputs[2]!.checked = false;
        throw new Error('controlled attach-time host mutation');
      }
    });
    const group = prepare(mounted, 'question.schedule');
    armed = true;

    const result = await group.write({
      boundary: 'ORDINARY_REVERSIBLE',
      answer: { kind: 'MULTI_CHOICE', optionIds: ['B', 'C'] },
      settle: settleImmediately,
    });

    expect(result).toEqual({ ok: false, error: 'WRITE_AUTHORITY_LOST' });
    expect(checked(mounted)).toEqual([false, false, false]);
  });

  it('fails authority closed when a property setter publishes a partial vector', async () => {
    const mounted = mountGroup({ kind: 'checkbox', checked: [0] });
    const descriptor = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      'checked',
    )!;
    let armed = false;
    let published = false;
    vi.spyOn(HTMLInputElement.prototype, 'checked', 'set').mockImplementation(function (
      this: HTMLInputElement,
      value: boolean,
    ) {
      descriptor.set!.call(this, value);
      if (armed && !published && mounted.inputs.includes(this)) {
        published = true;
        this.dispatchEvent(new Event('input', { bubbles: true }));
      }
    });
    const group = prepare(mounted, 'question.schedule');
    armed = true;

    const result = await group.write({
      boundary: 'ORDINARY_REVERSIBLE',
      answer: { kind: 'MULTI_CHOICE', optionIds: ['B', 'C'] },
      settle: settleImmediately,
    });

    expect(result).toEqual({ ok: false, error: 'WRITE_AUTHORITY_LOST' });
    expect(checked(mounted)).toEqual([false, false, false]);
  });

  it('fences a write-time semantic getter that publishes an unchanged group event', async () => {
    const mounted = mountGroup({ kind: 'checkbox', checked: [0] });
    const descriptor = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      'checked',
    )!;
    let armed = false;
    let published = false;
    vi.spyOn(HTMLInputElement.prototype, 'checked', 'get').mockImplementation(function (
      this: HTMLInputElement,
    ) {
      const value = descriptor.get!.call(this) as boolean;
      if (armed && !published && mounted.inputs.includes(this)) {
        published = true;
        this.dispatchEvent(new Event('input', { bubbles: true }));
      }
      return value;
    });
    const group = prepare(mounted, 'question.schedule');
    const host = watchHostActions(mounted.form);
    armed = true;

    const result = await group.write({
      boundary: 'ORDINARY_REVERSIBLE',
      answer: { kind: 'MULTI_CHOICE', optionIds: ['B', 'C'] },
      settle: settleImmediately,
    });

    expect(result).toEqual({ ok: false, error: 'WRITE_AUTHORITY_LOST' });
    expect(host.events).toEqual(['input']);
    expect(checked(mounted)).toEqual([true, false, false]);
  });

  it('reads a hostile write settle accessor before mutation and returns a stable failure', async () => {
    const mounted = mountGroup({ kind: 'radio', checked: [0] });
    const group = prepare(mounted);
    const host = watchHostActions(mounted.form);
    const hostile = {
      boundary: 'ORDINARY_REVERSIBLE',
      answer: { kind: 'SINGLE_CHOICE', optionId: 'B' },
    } as ChoiceGroupWriteInput;
    Object.defineProperty(hostile, 'settle', {
      get: () => { throw new Error('controlled hostile settle getter'); },
    });

    await expect(group.write(hostile)).resolves.toEqual({
      ok: false,
      error: 'VERIFY_FAILED',
    });
    expect(checked(mounted)).toEqual([true, false, false]);
    expect(host.events).toEqual([]);
  });

  it('normalizes hostile nested answer getters before mutation', async () => {
    const mounted = mountGroup({ kind: 'radio', checked: [0] });
    const group = prepare(mounted);
    const host = watchHostActions(mounted.form);
    const hostile = { kind: 'SINGLE_CHOICE' } as ChoiceAnswer;
    Object.defineProperty(hostile, 'optionId', {
      get: () => { throw new Error('controlled hostile optionId getter'); },
    });

    await expect(group.write({
      boundary: 'ORDINARY_REVERSIBLE',
      answer: hostile,
      settle: settleImmediately,
    })).resolves.toEqual({ ok: false, error: 'INVALID_ANSWER' });
    expect(checked(mounted)).toEqual([true, false, false]);
    expect(host.events).toEqual([]);
  });

  it('rejects unknown and kind-incompatible answers before mutation', async () => {
    const mounted = mountGroup({ kind: 'radio', checked: [0] });
    const group = prepare(mounted);

    await expect(group.write({
      boundary: 'ORDINARY_REVERSIBLE',
      answer: { kind: 'SINGLE_CHOICE', optionId: 'UNKNOWN' },
      settle: settleImmediately,
    })).resolves.toEqual({ ok: false, error: 'UNKNOWN_OPTION' });
    await expect(group.write({
      boundary: 'ORDINARY_REVERSIBLE',
      answer: { kind: 'MULTI_CHOICE', optionIds: ['A'] },
      settle: settleImmediately,
    })).resolves.toEqual({ ok: false, error: 'ANSWER_KIND_MISMATCH' });
    expect(checked(mounted)).toEqual([true, false, false]);
  });
});

describe('production-default bounded settle', () => {
  it.each(['radio', 'checkbox'] as const)(
    'completes a %s transaction through the default double-frame and final-macro schedule',
    async (kind) => {
      useDeterministicDefaultSettle();
      const mounted = mountGroup({ kind, checked: [0] });
      const group = prepare(mounted, `question.default.${kind}`);

      const pending = group.write({
        boundary: 'ORDINARY_REVERSIBLE',
        answer: kind === 'radio'
          ? { kind: 'SINGLE_CHOICE', optionId: 'B' }
          : { kind: 'MULTI_CHOICE', optionIds: ['B', 'C'] },
      });
      let completed = false;
      void pending.then(() => { completed = true; });
      await Promise.resolve();
      expect(completed).toBe(false);

      await vi.runAllTimersAsync();
      const result = await pending;

      expect(result, result.ok ? '' : result.error).toMatchObject({ ok: true });
      expect(checked(mounted)).toEqual(
        kind === 'radio' ? [false, true, false] : [false, true, true],
      );
    },
  );

  it('performs a final semantic readback after a late silent host drift', async () => {
    useDeterministicDefaultSettle();
    const mounted = mountGroup({ kind: 'radio', checked: [0] });
    const group = prepare(mounted, 'question.default.readback');
    mounted.inputs[1]!.addEventListener('change', () => {
      setTimeout(() => {
        mounted.inputs[2]!.checked = true;
      }, 0);
    });

    const pending = group.write({
      boundary: 'ORDINARY_REVERSIBLE',
      answer: { kind: 'SINGLE_CHOICE', optionId: 'B' },
    });
    await vi.runAllTimersAsync();
    const result = await pending;

    expect(result).toEqual({ ok: false, error: 'WRITE_AUTHORITY_LOST' });
    expect(checked(mounted)).toEqual([false, false, true]);
  });

  it('performs the final readback after the second animation frame', async () => {
    const mounted = mountGroup({ kind: 'radio', checked: [0] });
    useDeterministicDefaultSettle((frame) => {
      if (frame === 2) mounted.inputs[2]!.checked = true;
    });
    const group = prepare(mounted, 'question.default.second-frame');

    const pending = group.write({
      boundary: 'ORDINARY_REVERSIBLE',
      answer: { kind: 'SINGLE_CHOICE', optionId: 'B' },
    });
    await vi.runAllTimersAsync();
    const result = await pending;

    expect(result).toEqual({ ok: false, error: 'WRITE_AUTHORITY_LOST' });
    expect(checked(mounted)).toEqual([false, false, true]);
  });
});

describe('owned Undo and manual-only boundaries', () => {
  it('restores only the exact state written by this transaction', async () => {
    const mounted = mountGroup({ kind: 'radio', checked: [0] });
    const group = prepare(mounted);
    const result = await group.write({
      boundary: 'ORDINARY_REVERSIBLE',
      answer: { kind: 'SINGLE_CHOICE', optionId: 'B' },
      settle: settleImmediately,
    });
    expect(result.ok).toBe(true);
    if (!result.ok || result.value.undo === null) return;

    expect(result.value.undo.wasExternallyEdited()).toBe(false);
    expect(result.value.undo.isAtWrittenState()).toBe(true);
    await expect(result.value.undo.restorePreWrite({ settle: settleImmediately })).resolves.toEqual({
      ok: true,
    });
    expect(checked(mounted)).toEqual([true, false, false]);
    expect(result.value.undo.isAtPreWriteState()).toBe(false);
    await expect(result.value.undo.restorePreWrite({ settle: settleImmediately })).resolves.toEqual({
      ok: false,
      error: 'UNDO_RETIRED',
    });
  });

  it('detects a later user/host event even when the checked vector still matches', async () => {
    const mounted = mountGroup({ kind: 'checkbox', checked: [0] });
    const group = prepare(mounted, 'question.schedule');
    const result = await group.write({
      boundary: 'ORDINARY_REVERSIBLE',
      answer: { kind: 'MULTI_CHOICE', optionIds: ['B'] },
      settle: settleImmediately,
    });
    expect(result.ok).toBe(true);
    if (!result.ok || result.value.undo === null) return;

    mounted.inputs[1]!.dispatchEvent(new Event('change', { bubbles: true }));
    expect(result.value.undo.wasExternallyEdited()).toBe(true);
    await expect(result.value.undo.restorePreWrite({ settle: settleImmediately })).resolves.toEqual({
      ok: false,
      error: 'UNDO_NOT_OWNED',
    });
    await expect(result.value.undo.restorePreWrite({ settle: settleImmediately })).resolves.toEqual({
      ok: false,
      error: 'UNDO_RETIRED',
    });
    expect(checked(mounted)).toEqual([false, true, false]);
  });

  it('detects a later event even when an ancestor stops it before the option target', async () => {
    const mounted = mountGroup({ kind: 'checkbox', checked: [0] });
    const group = prepare(mounted, 'question.schedule');
    const result = await group.write({
      boundary: 'ORDINARY_REVERSIBLE',
      answer: { kind: 'MULTI_CHOICE', optionIds: ['B'] },
      settle: settleImmediately,
    });
    expect(result.ok).toBe(true);
    if (!result.ok || result.value.undo === null) return;

    mounted.form.addEventListener('change', (event) => event.stopPropagation(), true);
    mounted.inputs[1]!.dispatchEvent(new Event('change', { bubbles: true }));

    expect(result.value.undo.wasExternallyEdited()).toBe(true);
    await expect(result.value.undo.restorePreWrite({ settle: settleImmediately })).resolves.toEqual({
      ok: false,
      error: 'UNDO_NOT_OWNED',
    });
    expect(checked(mounted)).toEqual([false, true, false]);
  });

  it('does not claim a clean Undo when the host emits another group event during restore settle', async () => {
    const mounted = mountGroup({ kind: 'checkbox', checked: [0] });
    const group = prepare(mounted, 'question.schedule');
    const result = await group.write({
      boundary: 'ORDINARY_REVERSIBLE',
      answer: { kind: 'MULTI_CHOICE', optionIds: ['B'] },
      settle: settleImmediately,
    });
    expect(result.ok).toBe(true);
    if (!result.ok || result.value.undo === null) return;

    await expect(result.value.undo.restorePreWrite({
      settle: () => {
        mounted.inputs[0]!.dispatchEvent(new Event('change', { bubbles: true }));
      },
    })).resolves.toEqual({ ok: false, error: 'UNDO_NOT_OWNED' });
    expect(checked(mounted)).toEqual([true, false, false]);
  });

  it('retires ownership if the host disables a member after the write', async () => {
    const mounted = mountGroup({ kind: 'radio', checked: [0] });
    const group = prepare(mounted);
    const result = await group.write({
      boundary: 'ORDINARY_REVERSIBLE',
      answer: { kind: 'SINGLE_CHOICE', optionId: 'B' },
      settle: settleImmediately,
    });
    expect(result.ok).toBe(true);
    if (!result.ok || result.value.undo === null) return;

    mounted.inputs[1]!.disabled = true;
    expect(result.value.undo.wasExternallyEdited()).toBe(true);
    await expect(result.value.undo.restorePreWrite({ settle: settleImmediately })).resolves.toEqual({
      ok: false,
      error: 'UNDO_NOT_OWNED',
    });
    expect(checked(mounted)).toEqual([false, true, false]);
  });

  it('retires ownership when a disabled fieldset changes effective writability after the write', async () => {
    mockNativeEffectiveDisabled();
    const mounted = mountGroup({ kind: 'radio', checked: [0] });
    const fieldset = wrapInFieldset(mounted);
    const group = prepare(mounted);
    const result = await group.write({
      boundary: 'ORDINARY_REVERSIBLE',
      answer: { kind: 'SINGLE_CHOICE', optionId: 'B' },
      settle: settleImmediately,
    });
    expect(result.ok).toBe(true);
    if (!result.ok || result.value.undo === null) return;

    fieldset.disabled = true;
    expect(result.value.undo.wasExternallyEdited()).toBe(true);
    await expect(result.value.undo.restorePreWrite({ settle: settleImmediately })).resolves.toEqual({
      ok: false,
      error: 'UNDO_NOT_OWNED',
    });
    expect(checked(mounted)).toEqual([false, true, false]);
  });

  it('retires ownership after a silent checkbox indeterminate edit', async () => {
    const mounted = mountGroup({ kind: 'checkbox', checked: [0] });
    const group = prepare(mounted, 'question.schedule');
    const result = await group.write({
      boundary: 'ORDINARY_REVERSIBLE',
      answer: { kind: 'MULTI_CHOICE', optionIds: ['B'] },
      settle: settleImmediately,
    });
    expect(result.ok).toBe(true);
    if (!result.ok || result.value.undo === null) return;

    mounted.inputs[1]!.indeterminate = true;
    expect(result.value.undo.wasExternallyEdited()).toBe(true);
    await expect(result.value.undo.restorePreWrite({ settle: settleImmediately })).resolves.toEqual({
      ok: false,
      error: 'UNDO_NOT_OWNED',
    });
    expect(checked(mounted)).toEqual([false, true, false]);
    expect(indeterminate(mounted)).toEqual([false, true, false]);
  });

  it('returns a typed Undo failure if an expected restore event cannot dispatch', async () => {
    const mounted = mountGroup({ kind: 'radio', checked: [0] });
    const group = prepare(mounted);
    const result = await group.write({
      boundary: 'ORDINARY_REVERSIBLE',
      answer: { kind: 'SINGLE_CHOICE', optionId: 'B' },
      settle: settleImmediately,
    });
    expect(result.ok).toBe(true);
    if (!result.ok || result.value.undo === null) return;
    vi.spyOn(mounted.inputs[1]!, 'dispatchEvent').mockImplementationOnce(() => {
      throw new Error('controlled undo dispatch failure');
    });

    await expect(result.value.undo.restorePreWrite({ settle: settleImmediately })).resolves.toEqual({
      ok: false,
      error: 'UNDO_RESTORE_FAILED',
    });
    expect(checked(mounted)).toEqual([true, false, false]);
  });

  it('reads a hostile Undo settle accessor before mutation and retires at written state', async () => {
    const mounted = mountGroup({ kind: 'radio', checked: [0] });
    const group = prepare(mounted);
    const result = await group.write({
      boundary: 'ORDINARY_REVERSIBLE',
      answer: { kind: 'SINGLE_CHOICE', optionId: 'B' },
      settle: settleImmediately,
    });
    expect(result.ok).toBe(true);
    if (!result.ok || result.value.undo === null) return;
    const hostile = {} as ChoiceGroupUndoRestoreInput;
    Object.defineProperty(hostile, 'settle', {
      get: () => { throw new Error('controlled hostile Undo settle getter'); },
    });

    await expect(result.value.undo.restorePreWrite(hostile)).resolves.toEqual({
      ok: false,
      error: 'UNDO_RESTORE_FAILED',
    });
    expect(checked(mounted)).toEqual([false, true, false]);
    await expect(result.value.undo.restorePreWrite({ settle: settleImmediately })).resolves.toEqual({
      ok: false,
      error: 'UNDO_RETIRED',
    });
  });

  it.each([
    { label: 'pre-write', selectedIndex: 0, expected: [true, false, false] },
    { label: 'third', selectedIndex: 2, expected: [false, false, true] },
  ] as const)(
    'retires Undo as not-owned when a hostile settle getter moves to $label state',
    async ({ selectedIndex, expected }) => {
      const mounted = mountGroup({ kind: 'radio', checked: [0] });
      const group = prepare(mounted);
      const result = await group.write({
        boundary: 'ORDINARY_REVERSIBLE',
        answer: { kind: 'SINGLE_CHOICE', optionId: 'B' },
        settle: settleImmediately,
      });
      expect(result.ok).toBe(true);
      if (!result.ok || result.value.undo === null) return;
      const hostile = {} as ChoiceGroupUndoRestoreInput;
      Object.defineProperty(hostile, 'settle', {
        get: () => {
          mounted.inputs[selectedIndex]!.checked = true;
          throw new Error('controlled mutate-then-throw Undo getter');
        },
      });

      await expect(result.value.undo.restorePreWrite(hostile)).resolves.toEqual({
        ok: false,
        error: 'UNDO_NOT_OWNED',
      });
      expect(checked(mounted)).toEqual(expected);
      await expect(result.value.undo.restorePreWrite({ settle: settleImmediately })).resolves.toEqual({
        ok: false,
        error: 'UNDO_RETIRED',
      });
    },
  );

  it('fails closed when a hostile Undo settle getter disposes re-entrantly', async () => {
    const mounted = mountGroup({ kind: 'radio', checked: [0] });
    const group = prepare(mounted);
    const result = await group.write({
      boundary: 'ORDINARY_REVERSIBLE',
      answer: { kind: 'SINGLE_CHOICE', optionId: 'B' },
      settle: settleImmediately,
    });
    expect(result.ok).toBe(true);
    if (!result.ok || result.value.undo === null) return;
    const hostile = {} as ChoiceGroupUndoRestoreInput;
    Object.defineProperty(hostile, 'settle', {
      get: () => {
        result.value.undo?.dispose();
        return settleImmediately;
      },
    });

    await expect(result.value.undo.restorePreWrite(hostile)).resolves.toEqual({
      ok: false,
      error: 'UNDO_NOT_OWNED',
    });
    expect(checked(mounted)).toEqual([false, true, false]);
    await expect(result.value.undo.restorePreWrite({ settle: settleImmediately })).resolves.toEqual({
      ok: false,
      error: 'UNDO_RETIRED',
    });
  });

  it('revalidates successful Undo after hostile observer cleanup mutates state', async () => {
    const mounted = mountGroup({ kind: 'radio', checked: [0] });
    const nativeRemove = EventTarget.prototype.removeEventListener;
    let armed = false;
    let mutated = false;
    vi.spyOn(EventTarget.prototype, 'removeEventListener').mockImplementation(function (
      this: EventTarget,
      type: string,
      listener: EventListenerOrEventListenerObject | null,
      options?: boolean | EventListenerOptions,
    ) {
      nativeRemove.call(this, type, listener, options);
      if (armed && !mutated && this === document) {
        mutated = true;
        mounted.inputs[2]!.checked = true;
      }
    });
    const group = prepare(mounted);
    const result = await group.write({
      boundary: 'ORDINARY_REVERSIBLE',
      answer: { kind: 'SINGLE_CHOICE', optionId: 'B' },
      settle: settleImmediately,
    });
    expect(result.ok).toBe(true);
    if (!result.ok || result.value.undo === null) return;
    armed = true;

    await expect(result.value.undo.restorePreWrite({ settle: settleImmediately })).resolves.toEqual({
      ok: false,
      error: 'UNDO_NOT_OWNED',
    });
    expect(checked(mounted)).toEqual([false, false, true]);
    await expect(result.value.undo.restorePreWrite({ settle: settleImmediately })).resolves.toEqual({
      ok: false,
      error: 'UNDO_RETIRED',
    });
  });

  it('compensates an unpublished Undo setter failure back to verified written state', async () => {
    const mounted = mountGroup({ kind: 'radio', checked: [0] });
    const descriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'checked');
    if (typeof descriptor?.set !== 'function') throw new Error('checked setter unavailable');
    let setterCalls = 0;
    vi.spyOn(HTMLInputElement.prototype, 'checked', 'set').mockImplementation(function (
      this: HTMLInputElement,
      value: boolean,
    ) {
      setterCalls += 1;
      if (setterCalls === 4 || setterCalls === 5) {
        throw new Error('controlled undo and first compensation setter failure');
      }
      descriptor.set!.call(this, value);
    });
    const group = prepare(mounted);
    const host = watchHostActions(mounted.form);
    const result = await group.write({
      boundary: 'ORDINARY_REVERSIBLE',
      answer: { kind: 'SINGLE_CHOICE', optionId: 'B' },
      settle: settleImmediately,
    });
    expect(result.ok).toBe(true);
    if (!result.ok || result.value.undo === null) return;
    const eventsBeforeUndo = host.events.length;

    await expect(result.value.undo.restorePreWrite({ settle: settleImmediately })).resolves.toEqual({
      ok: false,
      error: 'UNDO_RESTORE_FAILED',
    });
    expect(checked(mounted)).toEqual([false, true, false]);
    expect(host.events).toHaveLength(eventsBeforeUndo);
  });

  it('retires Undo when persistent setter failure leaves no verified terminal vector', async () => {
    const mounted = mountGroup({ kind: 'checkbox', checked: [0] });
    const descriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'checked');
    if (typeof descriptor?.set !== 'function') throw new Error('checked setter unavailable');
    let setterCalls = 0;
    vi.spyOn(HTMLInputElement.prototype, 'checked', 'set').mockImplementation(function (
      this: HTMLInputElement,
      value: boolean,
    ) {
      setterCalls += 1;
      if (setterCalls >= 4) throw new Error('controlled persistent Undo setter failure');
      descriptor.set!.call(this, value);
    });
    const group = prepare(mounted, 'question.schedule');
    const host = watchHostActions(mounted.form);
    const result = await group.write({
      boundary: 'ORDINARY_REVERSIBLE',
      answer: { kind: 'MULTI_CHOICE', optionIds: ['B'] },
      settle: settleImmediately,
    });
    expect(result.ok).toBe(true);
    if (!result.ok || result.value.undo === null) return;
    const eventsBeforeUndo = host.events.length;

    await expect(result.value.undo.restorePreWrite({ settle: settleImmediately })).resolves.toEqual({
      ok: false,
      error: 'UNDO_NOT_OWNED',
    });
    expect(checked(mounted)).toEqual([false, false, false]);
    expect(host.events).toHaveLength(eventsBeforeUndo);
    await expect(result.value.undo.restorePreWrite({ settle: settleImmediately })).resolves.toEqual({
      ok: false,
      error: 'UNDO_RETIRED',
    });
  });

  it('detects a silent third state and never restores over it', async () => {
    const mounted = mountGroup({ kind: 'radio', checked: [0] });
    const group = prepare(mounted);
    const result = await group.write({
      boundary: 'ORDINARY_REVERSIBLE',
      answer: { kind: 'SINGLE_CHOICE', optionId: 'B' },
      settle: settleImmediately,
    });
    expect(result.ok).toBe(true);
    if (!result.ok || result.value.undo === null) return;

    mounted.inputs[2]!.checked = true;
    expect(result.value.undo.wasExternallyEdited()).toBe(true);
    await expect(result.value.undo.restorePreWrite({ settle: settleImmediately })).resolves.toEqual({
      ok: false,
      error: 'UNDO_NOT_OWNED',
    });
    expect(checked(mounted)).toEqual([false, false, true]);
  });

  it('fails default-settle Undo only after verifying a late drift back to the written state', async () => {
    const mounted = mountGroup({ kind: 'radio', checked: [0] });
    const group = prepare(mounted);
    const result = await group.write({
      boundary: 'ORDINARY_REVERSIBLE',
      answer: { kind: 'SINGLE_CHOICE', optionId: 'B' },
      settle: settleImmediately,
    });
    expect(result.ok).toBe(true);
    if (!result.ok || result.value.undo === null) return;
    useDeterministicDefaultSettle();
    mounted.inputs[0]!.addEventListener('change', () => {
      setTimeout(() => {
        mounted.inputs[1]!.checked = true;
      }, 0);
    });

    const pending = result.value.undo.restorePreWrite();
    await vi.runAllTimersAsync();

    await expect(pending).resolves.toEqual({
      ok: false,
      error: 'UNDO_RESTORE_FAILED',
    });
    expect(checked(mounted)).toEqual([false, true, false]);
  });

  it('retires ownership on form reset even when the reset vector equals the written vector', async () => {
    const mounted = mountGroup({ kind: 'radio', checked: [0] });
    mounted.inputs[0]!.defaultChecked = false;
    mounted.inputs[1]!.defaultChecked = true;
    mounted.inputs[2]!.defaultChecked = false;
    mounted.inputs[0]!.checked = true;
    mounted.inputs[1]!.checked = false;
    const group = prepare(mounted);
    const result = await group.write({
      boundary: 'ORDINARY_REVERSIBLE',
      answer: { kind: 'SINGLE_CHOICE', optionId: 'B' },
      settle: settleImmediately,
    });
    expect(result.ok).toBe(true);
    if (!result.ok || result.value.undo === null) return;

    mounted.form.reset();

    expect(checked(mounted)).toEqual([false, true, false]);
    expect(result.value.undo.wasExternallyEdited()).toBe(true);
    await expect(result.value.undo.restorePreWrite({ settle: settleImmediately })).resolves.toEqual({
      ok: false,
      error: 'UNDO_NOT_OWNED',
    });
  });

  it('detects reset above an earlier document listener that hides it from the root', async () => {
    const mounted = mountGroup({ kind: 'radio', checked: [0] });
    mounted.inputs[0]!.defaultChecked = false;
    mounted.inputs[1]!.defaultChecked = true;
    mounted.inputs[2]!.defaultChecked = false;
    mounted.inputs[0]!.checked = true;
    mounted.inputs[1]!.checked = false;
    const hideAtDocument = (event: Event) => event.stopImmediatePropagation();
    document.addEventListener('reset', hideAtDocument, true);
    try {
      const group = prepare(mounted);
      const result = await group.write({
        boundary: 'ORDINARY_REVERSIBLE',
        answer: { kind: 'SINGLE_CHOICE', optionId: 'B' },
        settle: settleImmediately,
      });
      expect(result.ok).toBe(true);
      if (!result.ok || result.value.undo === null) return;

      mounted.form.reset();

      expect(checked(mounted)).toEqual([false, true, false]);
      expect(result.value.undo.wasExternallyEdited()).toBe(true);
      await expect(result.value.undo.restorePreWrite({
        settle: settleImmediately,
      })).resolves.toEqual({
        ok: false,
        error: 'UNDO_NOT_OWNED',
      });
    } finally {
      document.removeEventListener('reset', hideAtDocument, true);
    }
  });

  it.each<ChoiceWriteBoundary>([
    'SENSITIVE_OR_ATTESTATION',
    'LEGAL_OR_SUBSTANTIVE_AUTHORIZATION',
    'MARKETING_SUBSCRIPTION',
    'CONTACT_CURRENT_EMPLOYER',
    'PASSWORD',
    'OTP_OR_2FA',
    'CAPTCHA_OR_HUMAN_CHALLENGE',
    'UNKNOWN_OR_MIXED_AUTHORIZATION',
    'FINAL_SUBMIT',
  ])('keeps %s manual-only with zero DOM writes', async (boundary) => {
    const mounted = mountGroup({ kind: 'checkbox', checked: [] });
    const group = prepare(mounted, 'question.manual');
    const host = watchHostActions(mounted.form);

    const result = await group.write({
      boundary,
      answer: { kind: 'MULTI_CHOICE', optionIds: ['A'] },
      settle: settleImmediately,
    });

    expect(result).toEqual({ ok: false, error: 'MANUAL_ONLY' });
    expect(checked(mounted)).toEqual([false, false, false]);
    expect(host.events).toEqual([]);
    expect(host.clickCalls()).toBe(0);
    expect(host.submitEvents()).toBe(0);
    expect(host.nativeSubmitCalls()).toBe(0);
    expect(host.requestSubmitCalls()).toBe(0);
  });

  it('fails unknown future boundary values closed', async () => {
    const mounted = mountGroup({ kind: 'checkbox', checked: [] });
    const group = prepare(mounted, 'question.unknown');

    const result = await group.write({
      boundary: 'FUTURE_UNREVIEWED_BOUNDARY' as ChoiceWriteBoundary,
      answer: { kind: 'MULTI_CHOICE', optionIds: ['A'] },
      settle: settleImmediately,
    });

    expect(result).toEqual({ ok: false, error: 'MANUAL_ONLY' });
    expect(checked(mounted)).toEqual([false, false, false]);
  });
});
