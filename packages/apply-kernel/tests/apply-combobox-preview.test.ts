import { afterEach, describe, expect, it } from 'vitest';

import {
  harvestComboboxOptions,
  selectComboboxOption,
  type ComboboxOptionSource,
  type ComboboxSemanticTransactionSource,
} from '../src/click/combobox';
import type { ComboboxSemanticAuthority } from '../src/contracts';
import { consumeAuthority, releaseAuthority, type HostWriteAuthority } from '../src/grant';
import { sealRuleOwnedComboboxSemanticAuthority } from '../src/rules/comboboxSemanticAuthority';
import { createScanRoot } from '../src/scanRoot';
import { createUndoJournal } from '../src/undo';
import { testApplyPolicy, testAuthority } from './helpers/applyTestAuthority';

afterEach(() => {
  document.body.innerHTML = '';
});

function activeAuthority(fingerprint: string): HostWriteAuthority {
  const minted = testAuthority(fingerprint, 'fill', ['set-combobox']);
  const consumed = consumeAuthority(minted);
  if (!consumed.ok) throw new Error(`authority setup failed: ${consumed.code}`);
  return consumed.value;
}

const testOptionSource: ComboboxOptionSource = {
  read: () => [...document.querySelectorAll('[role="option"]')].map((element) => ({
    element,
    text: element.textContent ?? '',
  })),
  isOpen: (trigger) => trigger.getAttribute('aria-expanded') === 'true',
};

const testSemanticTransactions: ComboboxSemanticTransactionSource = {
  snapshot: (trigger, root) => {
    const previous = trigger.value;
    const previousBacking = trigger.dataset.selectedBacking;
    const ownsEventTarget = (target: EventTarget | null) =>
      target === trigger ||
      (target instanceof Element && root.querySelectorAll('[role="option"]').includes(target));
    return {
      canRestorePreWrite: () =>
        trigger.value === previous && trigger.dataset.selectedBacking === previousBacking,
      restorePreWrite: () => {
        trigger.value = previous;
        if (previousBacking === undefined) delete trigger.dataset.selectedBacking;
        else trigger.dataset.selectedBacking = previousBacking;
        return true;
      },
      isAtPreWriteState: () =>
        trigger.value === previous && trigger.dataset.selectedBacking === previousBacking,
      ownsEventTarget,
      captureWrittenState: (expected) => ({
        isAtWrittenState: () => trigger.dataset.selectedBacking === expected,
        restorePreWrite: () => {
          trigger.value = previous;
          if (previousBacking === undefined) delete trigger.dataset.selectedBacking;
          else trigger.dataset.selectedBacking = previousBacking;
          return true;
        },
        isAtPreWriteState: () =>
          trigger.value === previous && trigger.dataset.selectedBacking === previousBacking,
        ownsEventTarget,
        wasUserEdited: () => false,
        dispose: () => undefined,
      }),
    };
  },
};

function controlledSemanticAuthority(
  optionSource: ComboboxOptionSource,
): ComboboxSemanticAuthority {
  return sealRuleOwnedComboboxSemanticAuthority({
    optionSource,
    semanticTransactionSource: testSemanticTransactions,
    readSelection: (trigger, expected) => {
      const selected = trigger.dataset.selectedBacking;
      if (selected === undefined || selected === '') return 'EMPTY';
      return selected === expected ? 'MATCH' : 'MISMATCH';
    },
  });
}

function mountControlledCombobox() {
  document.body.innerHTML = `
    <form id="application-form">
      <label for="location">Location</label>
      <input id="location" type="text" role="combobox" aria-expanded="false" />
      <div id="location-listbox" role="listbox"></div>
      <button id="submit" type="submit">Submit application</button>
    </form>
    <div id="decoy-listbox" role="listbox"><div role="option">Seattle</div></div>`;
  const form = document.querySelector<HTMLFormElement>('#application-form')!;
  const trigger = document.querySelector<HTMLInputElement>('#location')!;
  const popup = document.querySelector<HTMLElement>('#location-listbox')!;
  const decoy = document.querySelector<HTMLElement>('#decoy-listbox [role="option"]')!;
  let triggerClicks = 0;
  let optionClicks = 0;
  let decoyClicks = 0;
  let submits = 0;

  decoy.addEventListener('click', () => { decoyClicks += 1; });
  form.addEventListener('submit', (event) => {
    submits += 1;
    event.preventDefault();
  });
  trigger.addEventListener('click', () => {
    triggerClicks += 1;
    if (trigger.getAttribute('aria-expanded') === 'true') {
      trigger.setAttribute('aria-expanded', 'false');
      popup.replaceChildren();
      return;
    }
    trigger.setAttribute('aria-expanded', 'true');
    setTimeout(() => {
      popup.replaceChildren(...['Portland', 'Seattle'].map((label) => {
        const option = document.createElement('div');
        option.setAttribute('role', 'option');
        option.textContent = label;
        option.addEventListener('click', () => {
          optionClicks += 1;
          trigger.value = label;
          trigger.dataset.selectedBacking = label;
          trigger.setAttribute('aria-expanded', 'false');
          popup.replaceChildren();
        });
        return option;
      }));
    }, 0);
  });

  return {
    form,
    trigger,
    counts: () => ({ triggerClicks, optionClicks, decoyClicks, submits }),
  };
}

describe('CAP-AF-004/044 combobox preview transaction', () => {
  it('rejects an arbitrary option source before every trigger event without complete rule-owned semantic authority', async () => {
    const harness = mountControlledCombobox();
    const root = createScanRoot(harness.form, []);
    const journal = createUndoJournal();
    const recorded = journal.record(harness.trigger);
    const authority = activeAuthority('unproven-preview-source');
    const triggerEvents = new Map<string, number>();
    const observedEvents = [
      'pointerdown',
      'pointerup',
      'mousedown',
      'mouseup',
      'click',
      'input',
      'change',
    ] as const;
    for (const eventName of observedEvents) {
      triggerEvents.set(eventName, 0);
      harness.trigger.addEventListener(eventName, () => {
        triggerEvents.set(eventName, (triggerEvents.get(eventName) ?? 0) + 1);
      });
    }

    // A caller-created option source does not prove rule ownership, selected
    // state, or an exact semantic snapshot/restore transaction. Preview must
    // therefore stop before even opening the host widget.
    const arbitraryOptionSource: ComboboxOptionSource = {
      read: testOptionSource.read,
      isOpen: testOptionSource.isOpen,
    };
    const unbrandedAuthority: ComboboxSemanticAuthority = {
      optionSource: arbitraryOptionSource,
      semanticTransactionSource: testSemanticTransactions,
      readSelection: () => 'UNVERIFIABLE',
    };
    const result = await harvestComboboxOptions({
      trigger: harness.trigger,
      candidates: ['Seattle'],
      root,
      optionSource: arbitraryOptionSource,
      semanticAuthority: unbrandedAuthority,
      authority,
      ticket: recorded,
      policy: testApplyPolicy(),
      maxOptions: 16,
      timeoutMs: 300,
    });
    releaseAuthority(authority);
    if (recorded.ok) journal.abandon(recorded.value);

    expect.soft(result).toEqual({ ok: false, code: 'CAPABILITY_DISABLED' });
    expect.soft(Object.fromEntries(triggerEvents)).toEqual({
      pointerdown: 0,
      pointerup: 0,
      mousedown: 0,
      mouseup: 0,
      click: 0,
      input: 0,
      change: 0,
    });
    expect(harness.counts()).toEqual({
      triggerClicks: 0,
      optionClicks: 0,
      decoyClicks: 0,
      submits: 0,
    });
  });

  it('harvests only the reviewed root, closes it, and never chooses a decoy or Submit', async () => {
    const harness = mountControlledCombobox();
    const root = createScanRoot(harness.form, []);
    const journal = createUndoJournal();
    const recorded = journal.record(harness.trigger);
    const authority = activeAuthority('preview');

    const result = await harvestComboboxOptions({
      trigger: harness.trigger,
      candidates: ['Seattle'],
      root,
      optionSource: testOptionSource,
      semanticAuthority: controlledSemanticAuthority(testOptionSource),
      authority,
      ticket: recorded,
      policy: testApplyPolicy(),
      maxOptions: 16,
      timeoutMs: 300,
    });
    releaseAuthority(authority);
    if (recorded.ok) journal.abandon(recorded.value);

    expect(result).toMatchObject({
      ok: true,
      value: {
        candidates: ['Seattle'],
        optionTexts: ['Portland', 'Seattle'],
        resolvedOptionText: 'Seattle',
      },
    });
    expect(harness.trigger.getAttribute('aria-expanded')).toBe('false');
    expect(harness.counts()).toEqual({
      triggerClicks: 2,
      optionClicks: 0,
      decoyClicks: 0,
      submits: 0,
    });
  });

  it('retries at most once when the first open yields no options', async () => {
    document.body.innerHTML = `
      <form id="application-form">
        <label for="location">Location</label>
        <input id="location" role="combobox" aria-expanded="false" />
        <div id="location-listbox" role="listbox"></div>
      </form>`;
    const form = document.querySelector<HTMLFormElement>('form')!;
    const trigger = document.querySelector<HTMLInputElement>('#location')!;
    const popup = document.querySelector<HTMLElement>('#location-listbox')!;
    let opens = 0;
    trigger.addEventListener('click', () => {
      if (trigger.getAttribute('aria-expanded') === 'true') {
        trigger.setAttribute('aria-expanded', 'false');
        popup.replaceChildren();
        return;
      }
      trigger.setAttribute('aria-expanded', 'true');
      opens += 1;
      if (opens === 2) {
        setTimeout(() => {
          const option = document.createElement('div');
          option.setAttribute('role', 'option');
          option.textContent = 'Seattle';
          popup.replaceChildren(option);
        }, 0);
      }
    });
    const root = createScanRoot(form, []);
    const journal = createUndoJournal();
    const recorded = journal.record(trigger);
    const authority = activeAuthority('retry-preview');

    const result = await harvestComboboxOptions({
      trigger,
      candidates: ['Seattle'],
      root,
      optionSource: testOptionSource,
      semanticAuthority: controlledSemanticAuthority(testOptionSource),
      authority,
      ticket: recorded,
      policy: testApplyPolicy(),
      maxOptions: 16,
      timeoutMs: 320,
      maxOpenAttempts: 2,
    });
    releaseAuthority(authority);
    if (recorded.ok) journal.abandon(recorded.value);

    expect(result.ok).toBe(true);
    expect(opens).toBe(2);
  });

  it('never retries ambiguity, no-match, or an over-bound option set', async () => {
    const harness = mountControlledCombobox();
    const root = createScanRoot(harness.form, []);
    const journal = createUndoJournal();
    const recorded = journal.record(harness.trigger);
    const authority = activeAuthority('non-retryable-preview');

    const result = await harvestComboboxOptions({
      trigger: harness.trigger,
      candidates: ['Austin'],
      root,
      optionSource: testOptionSource,
      semanticAuthority: controlledSemanticAuthority(testOptionSource),
      authority,
      ticket: recorded,
      policy: testApplyPolicy(),
      maxOptions: 1,
      maxOpenAttempts: 2,
      timeoutMs: 300,
    });
    releaseAuthority(authority);
    if (recorded.ok) journal.abandon(recorded.value);

    expect(result).toEqual({ ok: false, code: 'WIDGET_TIMEOUT' });
    expect(harness.counts().triggerClicks).toBe(2);
    expect(harness.counts().optionClicks).toBe(0);
    expect(harness.counts().submits).toBe(0);
  });

  it('rejects a runtime retry budget wider than two before the first click', async () => {
    const harness = mountControlledCombobox();
    const root = createScanRoot(harness.form, []);
    const journal = createUndoJournal();
    const recorded = journal.record(harness.trigger);
    const authority = activeAuthority('invalid-retry-budget');

    const result = await harvestComboboxOptions({
      trigger: harness.trigger,
      candidates: ['Seattle'],
      root,
      optionSource: testOptionSource,
      semanticAuthority: controlledSemanticAuthority(testOptionSource),
      authority,
      ticket: recorded,
      policy: testApplyPolicy(),
      maxOptions: 16,
      maxOpenAttempts: 3 as 1,
      timeoutMs: 300,
    });
    releaseAuthority(authority);
    if (recorded.ok) journal.abandon(recorded.value);

    expect(result).toEqual({ ok: false, code: 'CAPABILITY_DISABLED' });
    expect(harness.counts()).toEqual({
      triggerClicks: 0,
      optionClicks: 0,
      decoyClicks: 0,
      submits: 0,
    });
  });

  it('rejects an overlong wall-clock budget before the first click', async () => {
    const harness = mountControlledCombobox();
    const root = createScanRoot(harness.form, []);
    const journal = createUndoJournal();
    const recorded = journal.record(harness.trigger);
    const authority = activeAuthority('invalid-time-budget');

    const result = await harvestComboboxOptions({
      trigger: harness.trigger,
      candidates: ['Seattle'],
      root,
      optionSource: testOptionSource,
      semanticAuthority: controlledSemanticAuthority(testOptionSource),
      authority,
      ticket: recorded,
      policy: testApplyPolicy(),
      maxOptions: 16,
      timeoutMs: 1_501,
    });
    releaseAuthority(authority);
    if (recorded.ok) journal.abandon(recorded.value);

    expect(result).toEqual({ ok: false, code: 'CAPABILITY_DISABLED' });
    expect(harness.counts()).toEqual({
      triggerClicks: 0,
      optionClicks: 0,
      decoyClicks: 0,
      submits: 0,
    });
  });

  it('rejects a malformed runtime candidate before the first click', async () => {
    const harness = mountControlledCombobox();
    const root = createScanRoot(harness.form, []);
    const journal = createUndoJournal();
    const recorded = journal.record(harness.trigger);
    const authority = activeAuthority('invalid-candidate');

    const result = await harvestComboboxOptions({
      trigger: harness.trigger,
      candidates: [42] as unknown as string[],
      root,
      optionSource: testOptionSource,
      semanticAuthority: controlledSemanticAuthority(testOptionSource),
      authority,
      ticket: recorded,
      policy: testApplyPolicy(),
      maxOptions: 16,
      timeoutMs: 300,
    });
    releaseAuthority(authority);
    if (recorded.ok) journal.abandon(recorded.value);

    expect(result).toEqual({ ok: false, code: 'CAPABILITY_DISABLED' });
    expect(harness.counts().triggerClicks).toBe(0);
  });

  it('rejects an overlong rule-owned option label before the first click', async () => {
    const harness = mountControlledCombobox();
    const root = createScanRoot(harness.form, []);
    const journal = createUndoJournal();
    const recorded = journal.record(harness.trigger);
    const authority = activeAuthority('invalid-text-budget');
    const hostileSource: ComboboxOptionSource = {
      read: () => [{ element: harness.trigger, text: 'x'.repeat(513) }],
      isOpen: testOptionSource.isOpen,
    };

    const result = await harvestComboboxOptions({
      trigger: harness.trigger,
      candidates: ['Seattle'],
      root,
      optionSource: hostileSource,
      semanticAuthority: controlledSemanticAuthority(hostileSource),
      authority,
      ticket: recorded,
      policy: testApplyPolicy(),
      maxOptions: 16,
      timeoutMs: 300,
    });
    releaseAuthority(authority);
    if (recorded.ok) journal.abandon(recorded.value);

    expect(result).toEqual({ ok: false, code: 'CAPABILITY_DISABLED' });
    expect(harness.counts().triggerClicks).toBe(0);
  });

  it('bounds inspected rule-owned views even when every view is duplicate or excluded', async () => {
    const harness = mountControlledCombobox();
    const root = createScanRoot(harness.form, []);
    const journal = createUndoJournal();
    const recorded = journal.record(harness.trigger);
    const authority = activeAuthority('invalid-view-count');
    const hostileSource: ComboboxOptionSource = {
      read: () => Array.from({ length: 1_025 }, () => ({
        element: harness.trigger,
        text: 'Seattle',
      })),
      isOpen: testOptionSource.isOpen,
    };

    const result = await harvestComboboxOptions({
      trigger: harness.trigger,
      candidates: ['Seattle'],
      root,
      optionSource: hostileSource,
      semanticAuthority: controlledSemanticAuthority(hostileSource),
      authority,
      ticket: recorded,
      policy: testApplyPolicy(),
      maxOptions: 16,
      timeoutMs: 300,
    });
    releaseAuthority(authority);
    if (recorded.ok) journal.abandon(recorded.value);

    expect(result).toEqual({ ok: false, code: 'CAPABILITY_DISABLED' });
    expect(harness.counts().triggerClicks).toBe(0);
  });

  it('rechecks the execution fence before spending a retry open click', async () => {
    document.body.innerHTML = `
      <form id="application-form">
        <label for="location">Location</label>
        <input id="location" role="combobox" aria-expanded="false" />
      </form>`;
    const form = document.querySelector<HTMLFormElement>('form')!;
    const trigger = document.querySelector<HTMLInputElement>('#location')!;
    const root = createScanRoot(form, []);
    let triggerClicks = 0;
    let revoked = false;
    trigger.addEventListener('click', () => {
      triggerClicks += 1;
      const wasOpen = trigger.getAttribute('aria-expanded') === 'true';
      trigger.setAttribute('aria-expanded', wasOpen ? 'false' : 'true');
      if (wasOpen) revoked = true;
    });
    const journal = createUndoJournal();
    const recorded = journal.record(trigger);
    const authority = activeAuthority('retry-revoke');

    const result = await harvestComboboxOptions({
      trigger,
      candidates: ['Seattle'],
      root,
      optionSource: testOptionSource,
      semanticAuthority: controlledSemanticAuthority(testOptionSource),
      authority,
      ticket: recorded,
      policy: testApplyPolicy(),
      maxOptions: 16,
      maxOpenAttempts: 2,
      timeoutMs: 140,
      executionFence: () => (revoked ? 'POLICY_DISABLED' : null),
    });
    releaseAuthority(authority);
    if (recorded.ok) journal.abandon(recorded.value);

    expect(result).toEqual({ ok: false, code: 'POLICY_DISABLED' });
    expect(triggerClicks).toBe(2);
  });

  it('does not seal a preview when the rule-owned source cannot prove close', async () => {
    const harness = mountControlledCombobox();
    const root = createScanRoot(harness.form, []);
    const journal = createUndoJournal();
    const recorded = journal.record(harness.trigger);
    const authority = activeAuthority('unconfirmed-close');
    const hostileSource: ComboboxOptionSource = {
      read: testOptionSource.read,
      isOpen: () => true,
    };

    const result = await harvestComboboxOptions({
      trigger: harness.trigger,
      candidates: ['Seattle'],
      root,
      optionSource: hostileSource,
      semanticAuthority: controlledSemanticAuthority(hostileSource),
      authority,
      ticket: recorded,
      policy: testApplyPolicy(),
      maxOptions: 16,
      timeoutMs: 300,
    });
    releaseAuthority(authority);
    if (recorded.ok) journal.abandon(recorded.value);

    expect(result).toEqual({ ok: false, code: 'WIDGET_TIMEOUT' });
    expect(harness.counts().optionClicks).toBe(0);
    expect(harness.counts().submits).toBe(0);
  });

  it('write-time signature drift closes without clicking an option', async () => {
    const harness = mountControlledCombobox();
    const root = createScanRoot(harness.form, []);
    const journal = createUndoJournal();
    const previewTicket = journal.record(harness.trigger);
    const previewAuthority = activeAuthority('preview-drift');
    const harvested = await harvestComboboxOptions({
      trigger: harness.trigger,
      candidates: ['Seattle'],
      root,
      optionSource: testOptionSource,
      semanticAuthority: controlledSemanticAuthority(testOptionSource),
      authority: previewAuthority,
      ticket: previewTicket,
      policy: testApplyPolicy(),
      maxOptions: 16,
      timeoutMs: 300,
    });
    releaseAuthority(previewAuthority);
    if (previewTicket.ok) journal.abandon(previewTicket.value);
    expect(harvested.ok).toBe(true);
    if (!harvested.ok) return;

    const writeTicket = journal.record(harness.trigger);
    const writeAuthority = activeAuthority('write-drift');
    const drifted = {
      ...harvested.value,
      optionSetSignature: 'hostile-signature',
    };
    const selected = await selectComboboxOption({
      trigger: harness.trigger,
      previousRawValue: harness.trigger.value,
      desired: 'Seattle',
      harvest: drifted,
      root,
      optionSource: testOptionSource,
      semanticTransactionSource: testSemanticTransactions,
      authority: writeAuthority,
      ticket: writeTicket,
      policy: testApplyPolicy(),
      timeoutMs: 300,
      readSelection: () => null,
    });
    releaseAuthority(writeAuthority);
    if (writeTicket.ok) journal.abandon(writeTicket.value);

    expect(selected).toEqual({ ok: false, code: 'IDENTITY_CHANGED' });
    expect(harness.counts().optionClicks).toBe(0);
    expect(harness.counts().submits).toBe(0);
    expect(harness.trigger.getAttribute('aria-expanded')).toBe('false');
  });
});
