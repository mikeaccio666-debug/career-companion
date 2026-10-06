// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createScanRoot } from '../src/scanRoot.ts';
import {
  prepareComboboxFillOnly,
  type ComboboxFillOnlyTransaction,
} from '../src/write/comboboxFillOnly.ts';
import { executeFillOnlySemanticWrite } from '../src/write/fillOnlySemantic.ts';
import { clickReviewedFillOnlyOption } from '../src/click/primitives.ts';

const REMOTE_ID = '11'.repeat(32);
const ONSITE_ID = '22'.repeat(32);

function installOptions(first = 'false', second = 'false') {
  document.body.innerHTML = `<form><label for="location">Work location</label>
    <input id="location" role="combobox" aria-expanded="true" aria-controls="locations">
    <ul id="locations" role="listbox">
      <li id="remote" role="option" aria-selected="${first}">Remote</li>
      <li id="onsite" role="option" aria-selected="${second}">On site</li>
    </ul></form>`;
  return {
    trigger: document.querySelector<HTMLInputElement>('#location')!,
    container: document.querySelector<HTMLElement>('#locations')!,
    remote: document.querySelector<HTMLElement>('#remote')!,
    onsite: document.querySelector<HTMLElement>('#onsite')!,
  };
}

function prepare(exactMembershipCurrent = () => true): ComboboxFillOnlyTransaction {
  const { trigger, container, remote, onsite } = installOptions();
  const transaction = prepareComboboxFillOnly({
    trigger,
    optionContainer: container,
    options: [
      { optionId: REMOTE_ID, element: remote },
      { optionId: ONSITE_ID, element: onsite },
    ],
    root: createScanRoot(document.documentElement, []),
    exactMembershipCurrent,
  });
  if (transaction === null) throw new Error('TEST_TRANSACTION_UNAVAILABLE');
  return transaction;
}

function execute(
  transaction: ComboboxFillOnlyTransaction,
  patch: Partial<Parameters<ComboboxFillOnlyTransaction['execute']>[0]> = {},
) {
  return transaction.execute({
    optionId: REMOTE_ID,
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

describe('expanded reviewed combobox fill-only transaction', () => {
  it('dispatches one guarded pointer sequence and proves semantic selection', async () => {
    const transaction = prepare();
    const remote = document.querySelector<HTMLElement>('#remote')!;
    const events: string[] = [];
    for (const type of ['mousedown', 'mouseup', 'click']) {
      remote.addEventListener(type, (event) => {
        events.push(type);
        if (type === 'click') {
          expect(event.defaultPrevented).toBe(true);
          remote.setAttribute('aria-selected', 'true');
        }
      });
    }

    const result = await execute(transaction);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('EXPECTED_SUCCESS');
    expect(events).toEqual(['mousedown', 'mouseup', 'click']);
    expect(result.observation.check()).toBeNull();
    expect(result.observation.finalize()).toBeNull();
    expect(await execute(transaction)).toEqual({ ok: false, code: 'CAPABILITY_DISABLED' });
  });

  it('denies before pointer dispatch when fresh authorization fails', async () => {
    const transaction = prepare();
    const dispatch = vi.spyOn(document.querySelector('#remote')!, 'dispatchEvent');

    const result = await execute(transaction, { authorizeWrite: async () => false });

    expect(result).toEqual({ ok: false, code: 'CAPABILITY_DISABLED' });
    expect(dispatch).not.toHaveBeenCalled();
    expect(document.querySelector('#remote')!.getAttribute('aria-selected')).toBe('false');
  });

  it('rechecks exact membership after authorization and reports no attempted write', async () => {
    let exact = true;
    const transaction = prepare(() => exact);
    const dispatch = vi.spyOn(document.querySelector('#remote')!, 'dispatchEvent');

    const result = await execute(transaction, {
      authorizeWrite: async () => { exact = false; return true; },
    });

    expect(result).toEqual({ ok: false, code: 'IDENTITY_CHANGED' });
    expect(dispatch).not.toHaveBeenCalled();
    expect(result).not.toHaveProperty('writeEffect');
  });

  it('keeps a late third state and never restores the pre-write state', async () => {
    const transaction = prepare();
    const remote = document.querySelector<HTMLElement>('#remote')!;
    const onsite = document.querySelector<HTMLElement>('#onsite')!;
    remote.addEventListener('click', () => remote.setAttribute('aria-selected', 'true'));

    const result = await execute(transaction, {
      lateRecheckDelay: async () => {
        remote.setAttribute('aria-selected', 'false');
        onsite.setAttribute('aria-selected', 'true');
      },
    });

    expect(result).toEqual({
      ok: false,
      code: 'LATE_REVERTED',
      writeEffect: 'MAY_HAVE_CHANGED',
    });
    expect([remote, onsite].map((option) => option.getAttribute('aria-selected')))
      .toEqual(['false', 'true']);
  });

  it('requires explicit complete aria-selected state and an unchanged ordered set', () => {
    const { trigger, container, remote, onsite } = installOptions('', 'false');
    expect(prepareComboboxFillOnly({
      trigger,
      optionContainer: container,
      options: [
        { optionId: REMOTE_ID, element: remote },
        { optionId: ONSITE_ID, element: onsite },
      ],
      root: createScanRoot(document.documentElement, []),
      exactMembershipCurrent: () => true,
    })).toBeNull();

    const transaction = prepare();
    document.querySelector('#locations')!.prepend(document.createElement('div'));
    const extra = document.querySelector('#locations')!.firstElementChild!;
    extra.setAttribute('role', 'option');
    extra.setAttribute('aria-selected', 'false');
    expect(transaction.isEmpty()).toBe(false);
  });

  it('never treats typed trigger text as an empty fill-first state', async () => {
    const transaction = prepare();
    const trigger = document.querySelector<HTMLInputElement>('#location')!;
    const remote = document.querySelector<HTMLElement>('#remote')!;
    const dispatch = vi.spyOn(remote, 'dispatchEvent');
    const authorizeWrite = vi.fn(async () => true);
    trigger.value = 'User-entered location';

    expect(transaction.isEmpty()).toBe(false);
    expect(await execute(transaction, { authorizeWrite })).toEqual({
      ok: false,
      code: 'IDENTITY_CHANGED',
    });
    expect(authorizeWrite).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
    expect(trigger.value).toBe('User-entered location');
  });

  it.each([
    { scenario: 'collapsed trigger', trigger: 'aria-expanded="false"', container: '' },
    { scenario: 'busy listbox', trigger: 'aria-expanded="true"', container: 'aria-busy="true"' },
    {
      scenario: 'multi-select listbox',
      trigger: 'aria-expanded="true"',
      container: 'aria-multiselectable="true"',
    },
  ])('does not prepare an unsupported $scenario', ({ trigger: triggerAttributes, container: containerAttributes }) => {
    document.body.innerHTML = `<form><input id="location" role="combobox" ${triggerAttributes}
      aria-controls="locations"><ul id="locations" role="listbox" ${containerAttributes}>
      <li id="remote" role="option" aria-selected="false">Remote</li></ul></form>`;
    expect(prepareComboboxFillOnly({
      trigger: document.querySelector<HTMLInputElement>('#location')!,
      optionContainer: document.querySelector('#locations')!,
      options: [{ optionId: REMOTE_ID, element: document.querySelector('#remote')! }],
      root: createScanRoot(document.documentElement, []),
      exactMembershipCurrent: () => true,
    })).toBeNull();
  });

  it('rejects a detectably partial aria-setsize window', () => {
    const { trigger, container, remote, onsite } = installOptions();
    remote.setAttribute('aria-posinset', '3');
    remote.setAttribute('aria-setsize', '20');
    onsite.setAttribute('aria-posinset', '4');
    onsite.setAttribute('aria-setsize', '20');

    expect(prepareComboboxFillOnly({
      trigger,
      optionContainer: container,
      options: [
        { optionId: REMOTE_ID, element: remote },
        { optionId: ONSITE_ID, element: onsite },
      ],
      root: createScanRoot(document.documentElement, []),
      exactMembershipCurrent: () => true,
    })).toBeNull();
  });

  it('makes the fill-only host-click authority synchronous and one-shot', async () => {
    const { remote, onsite } = installOptions();
    const root = createScanRoot(document.documentElement, []);
    const remoteEvents: string[] = [];
    const onsiteEvents: string[] = [];
    remote.addEventListener('mousedown', () => remoteEvents.push('mousedown'));
    onsite.addEventListener('mousedown', () => onsiteEvents.push('mousedown'));
    let secondCode: string | null = null;
    let captured: Parameters<typeof clickReviewedFillOnlyOption>[0]['authority'] | null = null;

    const result = await executeFillOnlySemanticWrite({
      authorizeWrite: async () => true,
      executionFence: () => null,
      targetFence: () => null,
      isAtPreWriteState: () => true,
      isAtWrittenState: () => true,
      writeForward: (authority) => {
        captured = authority;
        const first = clickReviewedFillOnlyOption({ element: remote, root, authority });
        const second = clickReviewedFillOnlyOption({ element: onsite, root, authority });
        secondCode = second.ok ? null : second.code;
        return first.ok;
      },
      readHostValidation: () => ({ ariaInvalid: 'false' }),
      lateRecheckMs: 1,
      operationTimeoutMs: 50,
      settle: async () => undefined,
      lateRecheckDelay: async () => undefined,
    });

    expect(result.ok).toBe(true);
    expect(remoteEvents).toEqual(['mousedown']);
    expect(onsiteEvents).toEqual([]);
    expect(secondCode).toBe('CAPABILITY_DISABLED');
    expect(captured).not.toBeNull();
    expect(clickReviewedFillOnlyOption({ element: onsite, root, authority: captured! }))
      .toEqual({ ok: false, code: 'CAPABILITY_DISABLED' });
    if (result.ok) result.observation.dispose();
  });
});
