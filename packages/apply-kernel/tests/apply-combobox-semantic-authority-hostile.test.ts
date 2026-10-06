import { afterEach, describe, expect, it } from 'vitest';

import greenhouseCanary from '../../apply-rules/rules/greenhouse-controlled-combobox-canary.json';

import type {
  ApplyPlan,
  ComboboxSemanticAuthority,
  ComboboxSemanticTransaction,
  ComboboxSemanticUndoTransaction,
  ScanRoot,
} from '../src/contracts';
import { buildApplyPlan } from '../src/engine';
import { compileBundledAdapter } from '../src/rules/interpreter';
import { sealRuleOwnedComboboxSemanticAuthority } from '../src/rules/comboboxSemanticAuthority';
import { runApplyPlan, type ApplyRunSummary } from '../src/runner';
import { createUndoJournal, type UndoJournal } from '../src/undo';
import { testApplyPolicy, testAuthority } from './helpers/applyTestAuthority';

interface MountedCanary {
  readonly form: HTMLFormElement;
  readonly trigger: HTMLInputElement;
  readonly optionRoot: HTMLDivElement;
  readonly triggerPointers: () => number;
  readonly optionPointers: () => number;
  readonly prior: () => HTMLElement;
  readonly next: () => HTMLElement;
  readonly third: () => HTMLElement | null;
}

interface PreparedCanary {
  readonly mounted: MountedCanary;
  readonly root: ScanRoot;
  readonly plan: ApplyPlan;
  readonly entry: Extract<ApplyPlan['entries'][number], { kind: 'combobox' }>;
}

interface ExecutedCanary extends PreparedCanary {
  readonly journal: UndoJournal;
  readonly summary: ApplyRunSummary;
}

function makeOption(
  tag: 'div' | 'button',
  identity: 'prior' | 'next' | 'third',
  text: string,
  selected: boolean,
): HTMLElement {
  const option = document.createElement(tag);
  if (option instanceof HTMLButtonElement) option.type = 'button';
  option.setAttribute('role', 'option');
  option.setAttribute('data-option-id', identity);
  option.setAttribute('aria-selected', selected ? 'true' : 'false');
  option.textContent = text;
  return option;
}

function mountCanary(
  optionTag: 'div' | 'button' = 'div',
  includeThird = false,
): MountedCanary {
  const form = document.createElement('form');
  const label = document.createElement('label');
  label.htmlFor = 'location';
  label.textContent = 'Location';
  const trigger = document.createElement('input');
  trigger.id = 'location';
  trigger.type = 'text';
  trigger.setAttribute('role', 'combobox');
  trigger.setAttribute('aria-expanded', 'false');
  const optionRoot = document.createElement('div');
  optionRoot.setAttribute('role', 'listbox');
  form.append(label, trigger, optionRoot);
  document.body.append(form);

  let currentPrior: HTMLElement;
  let currentNext: HTMLElement;
  let currentThird: HTMLElement | null = null;
  let optionPointerCount = 0;
  const installOptions = (
    priorSelected: boolean,
    nextSelected: boolean,
    thirdSelected = false,
  ) => {
    const prior = makeOption(optionTag, 'prior', 'Manual', priorSelected);
    const next = makeOption(optionTag, 'next', 'Seattle', nextSelected);
    const third = includeThird
      ? makeOption(optionTag, 'third', 'Portland', thirdSelected)
      : null;
    const options = third === null ? [prior, next] : [prior, next, third];
    for (const option of options) {
      for (const type of ['mousedown', 'mouseup', 'click'] as const) {
        option.addEventListener(type, () => { optionPointerCount += 1; });
      }
    }
    const select = (selected: Element) => {
      prior.setAttribute('aria-selected', selected === prior ? 'true' : 'false');
      next.setAttribute('aria-selected', selected === next ? 'true' : 'false');
      third?.setAttribute('aria-selected', selected === third ? 'true' : 'false');
      if (includeThird) trigger.value = selected.textContent ?? '';
      trigger.setAttribute('aria-expanded', 'false');
    };
    prior.addEventListener('click', () => select(prior));
    next.addEventListener('click', () => select(next));
    third?.addEventListener('click', () => select(third));
    currentPrior = prior;
    currentNext = next;
    currentThird = third;
    optionRoot.replaceChildren(...options);
    if (includeThird) {
      const selected = options.find((option) => option.getAttribute('aria-selected') === 'true');
      trigger.value = selected?.textContent ?? '';
    }
  };
  installOptions(true, false);

  let triggerPointerCount = 0;
  for (const type of ['mousedown', 'mouseup', 'click'] as const) {
    trigger.addEventListener(type, () => { triggerPointerCount += 1; });
  }
  trigger.addEventListener('click', () => {
    const priorSelected = currentPrior.getAttribute('aria-selected') === 'true';
    const nextSelected = currentNext.getAttribute('aria-selected') === 'true';
    const thirdSelected = currentThird?.getAttribute('aria-selected') === 'true';
    trigger.setAttribute('aria-expanded', 'true');
    // Host libraries commonly replace option nodes after opening. Keep the
    // exact rule-owned identities/text/state but ensure the candidates are a
    // product of this transaction rather than pre-existing click targets.
    installOptions(priorSelected, nextSelected, thirdSelected);
  }, { once: true });

  return {
    form,
    trigger,
    optionRoot,
    triggerPointers: () => triggerPointerCount,
    optionPointers: () => optionPointerCount,
    prior: () => currentPrior,
    next: () => currentNext,
    third: () => currentThird,
  };
}

function watchPriorPointers(optionRoot: HTMLElement): {
  readonly count: () => number;
} {
  let pointerCount = 0;
  for (const type of ['mousedown', 'mouseup', 'click'] as const) {
    optionRoot.addEventListener(type, (event) => {
      const target = event.target;
      if (target instanceof Element && target.getAttribute('data-option-id') === 'prior') {
        pointerCount += 1;
      }
    }, true);
  }
  return { count: () => pointerCount };
}

function armWrittenProofThirdStateDrift(mounted: MountedCanary): {
  readonly reads: () => number;
} {
  const third = mounted.third();
  const prototypeValue = Object.getOwnPropertyDescriptor(
    mounted.trigger.ownerDocument.defaultView!.HTMLInputElement.prototype,
    'value',
  );
  if (
    third === null ||
    typeof prototypeValue?.get !== 'function' ||
    typeof prototypeValue.set !== 'function'
  ) {
    throw new Error('three-option raw-value authority missing');
  }
  const writtenRawValue = prototypeValue.get.call(mounted.trigger) as string;
  let reads = 0;
  Object.defineProperty(mounted.trigger, 'value', {
    configurable: true,
    get: () => {
      reads += 1;
      if (reads === 2) {
        mounted.prior().setAttribute('aria-selected', 'false');
        mounted.next().setAttribute('aria-selected', 'false');
        third.setAttribute('aria-selected', 'true');
        prototypeValue.set!.call(mounted.trigger, 'Portland');
        // A hostile host getter can return the sealed raw value while changing
        // opaque semantic backing before the caller finishes its proof.
        return writtenRawValue;
      }
      return prototypeValue.get!.call(mounted.trigger) as string;
    },
    set: (value: string) => { prototypeValue.set!.call(mounted.trigger, value); },
  });
  return { reads: () => reads };
}

function watchSubmitWitnesses(form: HTMLFormElement): {
  readonly counts: () => readonly [number, number, number, number];
} {
  const submit = document.createElement('button');
  submit.type = 'submit';
  submit.textContent = 'Submit Application';
  let submitControlClicks = 0;
  let submitEvents = 0;
  let directSubmitCalls = 0;
  let requestSubmitCalls = 0;
  submit.addEventListener('click', () => { submitControlClicks += 1; });
  form.addEventListener('submit', (event) => {
    submitEvents += 1;
    event.preventDefault();
  });
  Object.defineProperty(form, 'submit', {
    configurable: true,
    value: () => { directSubmitCalls += 1; },
  });
  Object.defineProperty(form, 'requestSubmit', {
    configurable: true,
    value: () => { requestSubmitCalls += 1; },
  });
  form.append(submit);
  return {
    counts: () => [
      submitControlClicks,
      submitEvents,
      directSubmitCalls,
      requestSubmitCalls,
    ],
  };
}

function prepareCanary(
  optionTag: 'div' | 'button' = 'div',
  includeThird = false,
): PreparedCanary {
  const mounted = mountCanary(optionTag, includeThird);
  const adapter = compileBundledAdapter(greenhouseCanary);
  const root = adapter.resolveRoot(document);
  if (root === null) throw new Error('controlled canary root missing');
  const plan = buildApplyPlan(
    { vendor: 'greenhouse', root, fields: [...adapter.scan(root)] },
    { location: 'Seattle' },
    { fillEmptyOnly: false },
  );
  const entry = plan.entries.find(
    (candidate): candidate is Extract<ApplyPlan['entries'][number], { kind: 'combobox' }> =>
      candidate.kind === 'combobox',
  );
  if (entry === undefined || entry.semanticAuthority === undefined) {
    throw new Error('controlled canary semantic authority missing');
  }
  return { mounted, root, plan, entry };
}

async function executeCanary(
  prepared: PreparedCanary,
  input: Readonly<{
    signal?: AbortSignal;
    readHostValidation?: () => { readonly ariaInvalid: string };
    lateRecheckDelay?: () => Promise<void>;
    scanStillCurrent?: () => boolean;
  }> = {},
): Promise<ExecutedCanary> {
  const journal = createUndoJournal();
  const summary = await runApplyPlan({
    plan: prepared.plan,
    auth: testAuthority(prepared.plan.fingerprint, 'fill', ['set-combobox']),
    journal,
    root: prepared.root,
    policy: testApplyPolicy(),
    readHostValidation: input.readHostValidation ?? (() => ({ ariaInvalid: 'false' })),
    lateRecheckMs: 1,
    lateRecheckDelay: input.lateRecheckDelay ?? (async () => undefined),
    ...(input.signal === undefined ? {} : { signal: input.signal }),
    ...(input.scanStillCurrent === undefined
      ? {}
      : { scanStillCurrent: input.scanStillCurrent }),
  });
  return { ...prepared, journal, summary };
}

afterEach(() => {
  document.body.innerHTML = '';
});

describe('combobox semantic authority hostile safety gates', () => {
  it('rejects a structurally complete but unbranded authority before every pointer event', async () => {
    const prepared = prepareCanary();
    const minted = prepared.entry.semanticAuthority!;
    // Shape parity is deliberately not provenance. A caller-created object can
    // carry arbitrary DOM knowledge; only the rules interpreter may mint the
    // runtime authority that unlocks a host interaction.
    const unbranded: ComboboxSemanticAuthority = Object.freeze({
      optionSource: minted.optionSource,
      semanticTransactionSource: minted.semanticTransactionSource,
      readSelection: minted.readSelection,
    });
    prepared.entry.semanticAuthority = unbranded;

    const run = await executeCanary(prepared);

    expect(run.summary.results).toEqual([
      { key: 'location', label: 'Location', ok: false, reason: 'CAPABILITY_DISABLED' },
    ]);
    expect(run.summary.filled).toBe(0);
    expect(run.mounted.triggerPointers()).toBe(0);
    expect(run.journal.size()).toBe(0);
  });

  it('stops the trigger pointer sequence when execution aborts after mousedown', async () => {
    const prepared = prepareCanary();
    const abort = new AbortController();
    const submit = watchSubmitWitnesses(prepared.mounted.form);
    prepared.mounted.trigger.addEventListener('mousedown', () => { abort.abort(); }, { once: true });

    const run = await executeCanary(prepared, { signal: abort.signal });

    expect(run.summary.results).toEqual([
      { key: 'location', label: 'Location', ok: false, reason: 'ABORTED' },
    ]);
    expect(run.summary.filled).toBe(0);
    expect(prepared.mounted.triggerPointers()).toBe(1);
    expect(prepared.mounted.optionPointers()).toBe(0);
    expect(run.journal.size()).toBe(0);
    expect(submit.counts()).toEqual([0, 0, 0, 0]);
  });

  it('compensates and records zero success when AbortSignal closes during late semantic recheck', async () => {
    const prepared = prepareCanary();
    const abort = new AbortController();
    const run = await executeCanary(prepared, {
      signal: abort.signal,
      lateRecheckDelay: async () => { abort.abort(); },
    });

    expect(run.summary.results).toEqual([
      { key: 'location', label: 'Location', ok: false, reason: 'ABORTED' },
    ]);
    expect(run.summary.filled).toBe(0);
    expect(run.entry.semanticAuthority?.readSelection(run.mounted.trigger, 'Manual')).toBe('MATCH');
    expect(run.entry.semanticAuthority?.readSelection(run.mounted.trigger, 'Seattle')).toBe('MISMATCH');
    expect(run.journal.size()).toBe(0);
  });

  it('demotes provisional success when host settle reverts the exact selected state', async () => {
    const prepared = prepareCanary();
    const run = await executeCanary(prepared, {
      lateRecheckDelay: async () => {
        // Programmatic host settle, not a trusted candidate edit.
        prepared.mounted.prior().click();
      },
    });

    expect(run.summary.results).toEqual([
      { key: 'location', label: 'Location', ok: false, reason: 'LATE_REVERTED' },
    ]);
    expect(run.summary.filled).toBe(0);
    expect(run.entry.semanticAuthority?.readSelection(run.mounted.trigger, 'Manual')).toBe('MATCH');
    expect(run.entry.semanticAuthority?.readSelection(run.mounted.trigger, 'Seattle')).toBe('MISMATCH');
    expect(run.journal.size()).toBe(0);
  });

  it('never restores over an unsealed third state created during host validation', async () => {
    const prepared = prepareCanary();
    let drifted = false;
    const run = await executeCanary(prepared, {
      readHostValidation: () => {
        if (!drifted) {
          drifted = true;
          // Opaque semantic drift: raw value, trigger dataset, membership and
          // option text remain unchanged. The old written seal no longer owns
          // this state, so even a rejected verdict cannot authorize rollback.
          prepared.mounted.prior().setAttribute('aria-selected', 'false');
          prepared.mounted.next().setAttribute('aria-selected', 'false');
        }
        return { ariaInvalid: 'true' };
      },
    });

    expect(run.entry.semanticAuthority?.readSelection(run.mounted.trigger, 'Manual')).toBe('EMPTY');
    expect(run.entry.semanticAuthority?.readSelection(run.mounted.trigger, 'Seattle')).toBe('EMPTY');
    expect(run.summary.results).toEqual([
      { key: 'location', label: 'Location', ok: false, reason: 'IDENTITY_CHANGED' },
    ]);
    expect(run.summary.filled).toBe(0);
    expect(run.journal.size()).toBe(0);
  });

  it('does not compensate from a written proof whose raw getter switches to a third state', async () => {
    const prepared = prepareCanary('div', true);
    const submit = watchSubmitWitnesses(prepared.mounted.form);
    const priorPointers = watchPriorPointers(prepared.mounted.optionRoot);
    let hostileReads = () => 0;
    let hostileArmed = false;

    const run = await executeCanary(prepared, {
      readHostValidation: () => {
        if (!hostileArmed) {
          hostileReads = armWrittenProofThirdStateDrift(prepared.mounted).reads;
          hostileArmed = true;
        }
        return { ariaInvalid: 'true' };
      },
    });

    expect(hostileReads()).toBeGreaterThanOrEqual(2);
    expect(run.summary.results).toEqual([
      { key: 'location', label: 'Location', ok: false, reason: 'IDENTITY_CHANGED' },
    ]);
    expect(run.summary).toMatchObject({ filled: 0, abortedBy: 'IDENTITY_CHANGED' });
    expect(run.entry.semanticAuthority?.readSelection(run.mounted.trigger, 'Portland')).toBe(
      'MATCH',
    );
    expect(run.entry.semanticAuthority?.readSelection(run.mounted.trigger, 'Seattle')).toBe(
      'MISMATCH',
    );
    expect(run.mounted.trigger.value).toBe('Portland');
    expect(priorPointers.count()).toBe(0);
    expect(run.journal.size()).toBe(0);
    expect(submit.counts()).toEqual([0, 0, 0, 0]);
  });

  it('fails retained Undo when its final written proof raw getter switches to a third state', async () => {
    const prepared = prepareCanary('div', true);
    const run = await executeCanary(prepared);
    expect(run.summary.filled).toBe(1);
    expect(run.journal.size()).toBe(1);
    const submit = watchSubmitWitnesses(run.mounted.form);
    const priorPointers = watchPriorPointers(run.mounted.optionRoot);
    const hostile = armWrittenProofThirdStateDrift(run.mounted);

    const undo = run.journal.undoAll(
      testAuthority(null, 'undo', [...run.journal.requiredUndoCapabilities()]),
    );

    expect(hostile.reads()).toBeGreaterThanOrEqual(2);
    expect(undo).toMatchObject({ restored: 0, failed: 1, remaining: 1 });
    expect(run.journal.size()).toBe(1);
    expect(run.entry.semanticAuthority?.readSelection(run.mounted.trigger, 'Portland')).toBe(
      'MATCH',
    );
    expect(run.entry.semanticAuthority?.readSelection(run.mounted.trigger, 'Seattle')).toBe(
      'MISMATCH',
    );
    expect(run.mounted.trigger.value).toBe('Portland');
    expect(priorPointers.count()).toBe(0);
    expect(submit.counts()).toEqual([0, 0, 0, 0]);
  });

  it('does not restore an unsealed third semantic state created while opening', async () => {
    const prepared = prepareCanary();
    const abort = new AbortController();
    prepared.mounted.trigger.addEventListener('click', () => {
      // The host has replaced the option nodes and entered a semantic state
      // that is neither this transaction's pre-state nor a sealed written
      // state. Abort cannot turn that third state into restore authority.
      prepared.mounted.prior().setAttribute('aria-selected', 'false');
      prepared.mounted.next().setAttribute('aria-selected', 'false');
      abort.abort();
    });

    const run = await executeCanary(prepared, { signal: abort.signal });

    expect(run.mounted.optionPointers()).toBe(0);
    expect(run.entry.semanticAuthority?.readSelection(run.mounted.trigger, 'Manual')).toBe(
      'EMPTY',
    );
    expect(run.entry.semanticAuthority?.readSelection(run.mounted.trigger, 'Seattle')).toBe(
      'EMPTY',
    );
    expect(run.journal.size()).toBe(0);
    expect(run.summary.results).toEqual([
      { key: 'location', label: 'Location', ok: false, reason: 'IDENTITY_CHANGED' },
    ]);
    expect(run.summary.filled).toBe(0);
  });

  it('fails semantic Undo without any Submit witness when final restore facts turn Submit-looking', async () => {
    const prepared = prepareCanary('button');
    const run = await executeCanary(prepared);
    expect(run.summary.filled).toBe(1);
    expect(run.journal.size()).toBe(1);

    const prior = run.mounted.prior() as HTMLButtonElement;
    prior.setAttribute('aria-label', 'Manual');
    let submitControlClicks = 0;
    let submitEvents = 0;
    let directSubmitCalls = 0;
    let requestSubmitCalls = 0;
    prior.addEventListener('click', () => { submitControlClicks += 1; });
    run.mounted.form.addEventListener('submit', (event) => {
      submitEvents += 1;
      event.preventDefault();
    });
    Object.defineProperty(run.mounted.form, 'submit', {
      configurable: true,
      value: () => { directSubmitCalls += 1; },
    });
    Object.defineProperty(run.mounted.form, 'requestSubmit', {
      configurable: true,
      value: () => { requestSubmitCalls += 1; },
    });

    let textReads = 0;
    Object.defineProperty(prior, 'textContent', {
      configurable: true,
      get: () => {
        textReads += 1;
        // Reads 1 and 2 are the written-state and restore-state proofs. Read 3
        // is collectClickFacts.labelText, after buttonType was cached but before
        // the current implementation's native click. A final facts fence must
        // observe this drift and dispatch nothing.
        if (textReads === 3) {
          prior.type = 'submit';
          prior.setAttribute('aria-label', 'Submit Application');
        }
        return 'Manual';
      },
    });

    const undo = run.journal.undoAll(
      testAuthority(null, 'undo', [...run.journal.requiredUndoCapabilities()]),
    );

    expect([
      submitControlClicks,
      submitEvents,
      directSubmitCalls,
      requestSubmitCalls,
    ]).toEqual([0, 0, 0, 0]);
    expect(undo).toMatchObject({ restored: 0, failed: 1, remaining: 1 });
    expect(run.entry.semanticAuthority?.readSelection(run.mounted.trigger, 'Seattle')).toBe('MATCH');
  });

  it('stops semantic Undo after restoration mousedown loses rule-owned membership', async () => {
    const prepared = prepareCanary();
    const run = await executeCanary(prepared);
    expect(run.summary.filled).toBe(1);
    expect(run.journal.size()).toBe(1);
    const submit = watchSubmitWitnesses(prepared.mounted.form);
    const restorePointers: string[] = [];
    const prior = prepared.mounted.prior();
    for (const type of ['mousedown', 'mouseup', 'click'] as const) {
      prior.addEventListener(type, () => { restorePointers.push(type); });
    }
    prior.addEventListener('mousedown', () => {
      // Identity is rule-owned membership but is intentionally absent from
      // generic ClickTargetFacts; only the semantic phase fence can see it.
      prior.removeAttribute('data-option-id');
    }, { once: true });

    const undo = run.journal.undoAll(
      testAuthority(null, 'undo', [...run.journal.requiredUndoCapabilities()]),
    );

    expect(restorePointers).toEqual(['mousedown']);
    expect(undo).toMatchObject({ restored: 0, failed: 1, remaining: 1 });
    expect(run.entry.semanticAuthority?.readSelection(run.mounted.trigger, 'Seattle')).toBe(
      'UNVERIFIABLE',
    );
    expect(submit.counts()).toEqual([0, 0, 0, 0]);
  });

  it('stops semantic Undo when restoration mousedown enters an unsealed third state', async () => {
    const prepared = prepareCanary();
    const run = await executeCanary(prepared);
    expect(run.summary.filled).toBe(1);
    expect(run.journal.size()).toBe(1);
    const submit = watchSubmitWitnesses(prepared.mounted.form);
    const restorePointers: string[] = [];
    const prior = prepared.mounted.prior();
    for (const type of ['mousedown', 'mouseup', 'click'] as const) {
      prior.addEventListener(type, () => { restorePointers.push(type); });
    }
    prior.addEventListener('mousedown', () => {
      prepared.mounted.prior().setAttribute('aria-selected', 'false');
      prepared.mounted.next().setAttribute('aria-selected', 'false');
    }, { once: true });

    const undo = run.journal.undoAll(
      testAuthority(null, 'undo', [...run.journal.requiredUndoCapabilities()]),
    );

    expect(restorePointers).toEqual(['mousedown']);
    expect(undo).toMatchObject({ restored: 0, failed: 1, remaining: 1 });
    expect(run.entry.semanticAuthority?.readSelection(run.mounted.trigger, 'Manual')).toBe(
      'EMPTY',
    );
    expect(run.entry.semanticAuthority?.readSelection(run.mounted.trigger, 'Seattle')).toBe(
      'EMPTY',
    );
    expect(submit.counts()).toEqual([0, 0, 0, 0]);
  });

  it('does not restore through a replacement trigger that mimics the sealed state', async () => {
    const prepared = prepareCanary();
    const run = await executeCanary(prepared);
    expect(run.summary.filled).toBe(1);
    expect(run.journal.size()).toBe(1);
    const submit = watchSubmitWitnesses(prepared.mounted.form);
    const replacement = prepared.mounted.trigger.cloneNode(true) as HTMLInputElement;
    prepared.mounted.trigger.replaceWith(replacement);
    const pointersBeforeUndo = prepared.mounted.optionPointers();

    const undo = run.journal.undoAll(
      testAuthority(null, 'undo', [...run.journal.requiredUndoCapabilities()]),
    );

    expect(undo).toMatchObject({ restored: 0, failed: 1, remaining: 1 });
    expect(prepared.mounted.optionPointers()).toBe(pointersBeforeUndo);
    expect(prepared.mounted.prior().getAttribute('aria-selected')).toBe('false');
    expect(prepared.mounted.next().getAttribute('aria-selected')).toBe('true');
    expect(submit.counts()).toEqual([0, 0, 0, 0]);
  });

  it('stops after mousedown when the chosen option becomes Submit-looking mid-sequence', async () => {
    const prepared = prepareCanary();
    const submit = watchSubmitWitnesses(prepared.mounted.form);
    const forwardPointers: string[] = [];
    for (const type of ['mousedown', 'mouseup', 'click'] as const) {
      prepared.mounted.optionRoot.addEventListener(type, (event) => {
        const target = event.target;
        if (target instanceof Element && target.getAttribute('data-option-id') === 'next') {
          forwardPointers.push(type);
        }
      }, true);
    }
    prepared.mounted.optionRoot.addEventListener('mousedown', (event) => {
      const target = event.target;
      if (!(target instanceof Element) || target.getAttribute('data-option-id') !== 'next') return;
      target.setAttribute('aria-label', 'Submit Application');
    }, { once: true });
    prepared.mounted.optionRoot.addEventListener('click', (event) => {
      const target = event.target;
      if (!(target instanceof Element) || target.getAttribute('data-option-id') !== 'next') return;
      prepared.mounted.form.requestSubmit();
    });

    const run = await executeCanary(prepared);

    expect(run.summary.results).toEqual([
      { key: 'location', label: 'Location', ok: false, reason: 'CLICK_DENIED' },
    ]);
    expect(run.summary.filled).toBe(0);
    expect(forwardPointers).toEqual(['mousedown']);
    expect(run.entry.semanticAuthority?.readSelection(run.mounted.trigger, 'Manual')).toBe('MATCH');
    expect(run.entry.semanticAuthority?.readSelection(run.mounted.trigger, 'Seattle')).toBe(
      'MISMATCH',
    );
    expect(run.journal.size()).toBe(0);
    expect(submit.counts()).toEqual([0, 0, 0, 0]);
  });

  it.each(['mousedown', 'mouseup'] as const)(
    'carries exact rule-owned membership through the option pointer sequence after %s',
    async (driftEvent) => {
      const prepared = prepareCanary();
      const submit = watchSubmitWitnesses(prepared.mounted.form);
      const baseAuthority = prepared.entry.semanticAuthority!;
      let chosenRemainsOwned = true;
      prepared.entry.semanticAuthority = sealRuleOwnedComboboxSemanticAuthority({
        readSelection: baseAuthority.readSelection,
        semanticTransactionSource: baseAuthority.semanticTransactionSource,
        optionSource: {
          isOpen: baseAuthority.optionSource.isOpen,
          read: (trigger, root) => baseAuthority.optionSource.read(trigger, root).filter(
            (option) => chosenRemainsOwned || option.text !== 'Seattle',
          ),
        },
      });
      const pointerEvents: string[] = [];
      for (const type of ['mousedown', 'mouseup', 'click'] as const) {
        prepared.mounted.optionRoot.addEventListener(type, (event) => {
          const target = event.target;
          if (target instanceof Element && target.getAttribute('data-option-id') === 'next') {
            pointerEvents.push(type);
          }
        }, true);
      }
      prepared.mounted.optionRoot.addEventListener(driftEvent, (event) => {
        const target = event.target;
        if (!(target instanceof Element) || target.getAttribute('data-option-id') !== 'next') return;
        // Keep the exact connected node, DOM facts, identity attribute, root and
        // text unchanged. Only the validated rule-owned source drops membership.
        chosenRemainsOwned = false;
      }, { once: true });
      prepared.mounted.optionRoot.addEventListener('click', () => {
        prepared.mounted.form.requestSubmit();
      });

      const run = await executeCanary(prepared);

      expect(run.summary.results).toEqual([
        { key: 'location', label: 'Location', ok: false, reason: 'IDENTITY_CHANGED' },
      ]);
      expect(run.summary).toMatchObject({ filled: 0, abortedBy: 'IDENTITY_CHANGED' });
      expect(pointerEvents).toEqual(
        driftEvent === 'mousedown' ? ['mousedown'] : ['mousedown', 'mouseup'],
      );
      expect(run.entry.semanticAuthority?.readSelection(run.mounted.trigger, 'Manual')).toBe('MATCH');
      expect(run.journal.size()).toBe(0);
      expect(submit.counts()).toEqual([0, 0, 0, 0]);
    },
  );

  it('re-runs the execution fence after the final written-state callback', async () => {
    const prepared = prepareCanary();
    const baseAuthority = prepared.entry.semanticAuthority!;
    let scanCurrent = true;
    let writtenStateReads = 0;
    let lateRecheckStarted = false;
    prepared.entry.semanticAuthority = sealRuleOwnedComboboxSemanticAuthority({
      optionSource: baseAuthority.optionSource,
      readSelection: baseAuthority.readSelection,
      semanticTransactionSource: {
        snapshot: (trigger, root): ComboboxSemanticTransaction | null => {
          const transaction = baseAuthority.semanticTransactionSource.snapshot(trigger, root);
          if (transaction === null) return null;
          return Object.freeze({
            ...transaction,
            captureWrittenState: (expectedOptionText: string) => {
              const undo = transaction.captureWrittenState(expectedOptionText);
              if (undo === null) return null;
              return Object.freeze({
                ...undo,
                isAtWrittenState: () => {
                  const sealed = undo.isAtWrittenState();
                  writtenStateReads += 1;
                  // Arm only after the settle delay so earlier select/commit
                  // proofs remain valid. This late callback is the final proof
                  // before success and stales execution while returning true.
                  if (lateRecheckStarted) scanCurrent = false;
                  return sealed;
                },
              });
            },
          });
        },
      },
    });

    const run = await executeCanary(prepared, {
      scanStillCurrent: () => scanCurrent,
      lateRecheckDelay: async () => { lateRecheckStarted = true; },
    });

    expect(writtenStateReads).toBeGreaterThanOrEqual(3);
    expect(run.summary.results).toEqual([
      { key: 'location', label: 'Location', ok: false, reason: 'ABORTED' },
    ]);
    expect(run.summary.filled).toBe(0);
    expect(run.entry.semanticAuthority?.readSelection(run.mounted.trigger, 'Manual')).toBe('MATCH');
    expect(run.entry.semanticAuthority?.readSelection(run.mounted.trigger, 'Seattle')).toBe(
      'MISMATCH',
    );
    expect(run.journal.size()).toBe(0);
  });

  it('never retains or restores an unsealed third semantic state', async () => {
    const prepared = prepareCanary();
    const baseAuthority = prepared.entry.semanticAuthority!;
    let restoreCalls = 0;
    let changedToThirdState = false;
    prepared.entry.semanticAuthority = sealRuleOwnedComboboxSemanticAuthority({
      optionSource: baseAuthority.optionSource,
      readSelection: (trigger, expectedOptionText) => {
        const selection = baseAuthority.readSelection(trigger, expectedOptionText);
        if (
          !changedToThirdState &&
          expectedOptionText === 'Seattle' &&
          selection === 'MATCH'
        ) {
          changedToThirdState = true;
          prepared.mounted.prior().setAttribute('aria-selected', 'false');
          prepared.mounted.next().setAttribute('aria-selected', 'false');
          return 'UNVERIFIABLE';
        }
        return selection;
      },
      semanticTransactionSource: {
        snapshot: (trigger, root): ComboboxSemanticTransaction | null => {
          const transaction = baseAuthority.semanticTransactionSource.snapshot(trigger, root);
          if (transaction === null) return null;
          return Object.freeze({
            ...transaction,
            restorePreWrite: () => {
              restoreCalls += 1;
              // Immediate compensation cannot prove restoration. A blind
              // retained handle would call again later and overwrite the
              // unrelated third semantic state with the old option.
              return restoreCalls === 1 ? false : transaction.restorePreWrite();
            },
          });
        },
      },
    });

    const run = await executeCanary(prepared);

    expect(changedToThirdState).toBe(true);
    expect(run.summary.results).toEqual([
      { key: 'location', label: 'Location', ok: false, reason: 'IDENTITY_CHANGED' },
    ]);
    expect(run.summary.filled).toBe(0);
    expect(restoreCalls).toBe(0);
    expect(run.journal.size()).toBe(0);
    expect(run.entry.semanticAuthority?.readSelection(run.mounted.trigger, 'Manual')).toBe(
      'EMPTY',
    );
    expect(run.entry.semanticAuthority?.readSelection(run.mounted.trigger, 'Seattle')).toBe(
      'EMPTY',
    );
  });

  it('never overwrites a trusted semantic user edit made after the verified write', async () => {
    const prepared = prepareCanary();
    const run = await executeCanary(prepared);
    expect(run.summary.filled).toBe(1);
    expect(run.journal.size()).toBe(1);

    const userChoice = run.mounted.prior();
    userChoice.setAttribute('data-option-id', 'user-choice');
    userChoice.textContent = 'Portland';
    const trusted = new Event('click', { bubbles: true, composed: true });
    Object.defineProperty(trusted, 'isTrusted', { value: true });
    userChoice.dispatchEvent(trusted);

    const undo = run.journal.undoAll(
      testAuthority(null, 'undo', [...run.journal.requiredUndoCapabilities()]),
    );
    expect(undo).toMatchObject({
      restored: 0,
      skippedUserEdited: 1,
      failed: 0,
      remaining: 0,
    });
    expect(run.entry.semanticAuthority?.readSelection(run.mounted.trigger, 'Portland')).toBe(
      'MATCH',
    );
    expect(run.journal.size()).toBe(0);
  });

  it('re-proves opaque pre-write state after trigger facts and before the first open dispatch', async () => {
    const prepared = prepareCanary();
    const baseAuthority = prepared.entry.semanticAuthority!;
    let opaqueAtPreWrite = true;
    prepared.entry.semanticAuthority = sealRuleOwnedComboboxSemanticAuthority({
      optionSource: baseAuthority.optionSource,
      readSelection: baseAuthority.readSelection,
      semanticTransactionSource: {
        snapshot: (trigger, root) => {
          const base = baseAuthority.semanticTransactionSource.snapshot(trigger, root);
          if (base === null) return null;
          return {
            canRestorePreWrite: base.canRestorePreWrite,
            restorePreWrite: () => {
              const restored = base.restorePreWrite();
              opaqueAtPreWrite = true;
              return restored && opaqueAtPreWrite;
            },
            isAtPreWriteState: () => base.isAtPreWriteState() && opaqueAtPreWrite,
            ownsEventTarget: base.ownsEventTarget,
            captureWrittenState: base.captureWrittenState,
          };
        },
      },
    });
    let triggerFactsRead = false;
    Object.defineProperty(prepared.mounted.trigger, 'textContent', {
      configurable: true,
      get: () => {
        triggerFactsRead = true;
        // The exact snapshot was valid. This getter runs in trigger facts after
        // rule-source and execution callbacks, flips only adapter-owned opaque
        // semantic state (no DOM/dataset/raw mutation), and still returns a
        // policy-safe value.
        opaqueAtPreWrite = false;
        return '';
      },
    });

    const run = await executeCanary(prepared);
    const result = run.summary.results[0];

    expect(triggerFactsRead).toBe(true);
    expect(run.mounted.triggerPointers()).toBe(0);
    expect(result?.ok).toBe(false);
    if (result?.ok !== false) throw new Error('hostile pre-open proof unexpectedly succeeded');
    expect(['CAPABILITY_DISABLED', 'IDENTITY_CHANGED']).toContain(result.reason);
    expect(run.summary.filled).toBe(0);
    expect(run.journal.size()).toBe(0);
  });

  it('revokes recovery when post-click membership drift breaks exact written ownership', async () => {
    const prepared = prepareCanary();
    const baseAuthority = prepared.entry.semanticAuthority!;
    let removedMembership = false;
    prepared.entry.semanticAuthority = sealRuleOwnedComboboxSemanticAuthority({
      optionSource: baseAuthority.optionSource,
      semanticTransactionSource: baseAuthority.semanticTransactionSource,
      readSelection: (trigger, expectedOptionText) => {
        const selection = baseAuthority.readSelection(trigger, expectedOptionText);
        if (
          !removedMembership &&
          expectedOptionText === 'Seattle' &&
          selection === 'MATCH'
        ) {
          removedMembership = true;
          prepared.mounted.prior().removeAttribute('role');
          return 'UNVERIFIABLE';
        }
        return selection;
      },
    });

    const run = await executeCanary(prepared);

    expect(removedMembership).toBe(true);
    expect(run.summary).toMatchObject({ filled: 0, abortedBy: 'IDENTITY_CHANGED' });
    expect(run.summary.results).toEqual([
      { key: 'location', label: 'Location', ok: false, reason: 'IDENTITY_CHANGED' },
    ]);
    expect(run.journal.size()).toBe(0);
    expect(run.entry.semanticAuthority?.readSelection(run.mounted.trigger, 'Seattle')).toBe(
      'MATCH',
    );

    // Restoring rule membership later must not resurrect a capability that
    // could now overwrite semantically identical host/third-party state.
    run.mounted.prior().setAttribute('role', 'option');
    expect(run.journal.canUndo()).toBe(false);
    expect(run.entry.semanticAuthority?.readSelection(run.mounted.trigger, 'Seattle')).toBe('MATCH');
  });

  it.each([
    ['hidden', (option: HTMLButtonElement) => { option.hidden = true; }],
    ['disabled', (option: HTMLButtonElement) => { option.disabled = true; }],
    ['Submit-looking', (option: HTMLButtonElement) => {
      option.type = 'submit';
      option.setAttribute('aria-label', 'Submit Application');
    }],
  ] as const)(
    'rejects an initially %s semantic restore target before the first trigger or option pointer',
    async (_kind, makeUnsafe) => {
      const prepared = prepareCanary('button');
      const submit = watchSubmitWitnesses(prepared.mounted.form);
      makeUnsafe(prepared.mounted.prior() as HTMLButtonElement);

      const run = await executeCanary(prepared);

      expect(run.summary.results).toEqual([
        { key: 'location', label: 'Location', ok: false, reason: 'CAPABILITY_DISABLED' },
      ]);
      expect(run.summary).toMatchObject({ filled: 0, abortedBy: null });
      expect(run.mounted.triggerPointers()).toBe(0);
      expect(run.mounted.optionPointers()).toBe(0);
      expect(run.journal.size()).toBe(0);
      expect(submit.counts()).toEqual([0, 0, 0, 0]);
    },
  );

  it('preserves a trusted third semantic choice dispatched from a nested composedPath target', async () => {
    const prepared = prepareCanary();
    const minted = prepared.entry.semanticAuthority!;
    const source = minted.semanticTransactionSource;
    prepared.entry.semanticAuthority = sealRuleOwnedComboboxSemanticAuthority({
      optionSource: minted.optionSource,
      readSelection: minted.readSelection,
      semanticTransactionSource: {
        snapshot: (trigger, root): ComboboxSemanticTransaction | null => {
          const transaction = source.snapshot(trigger, root);
          if (transaction === null) return null;
          const ownsExactSemanticNode = (target: EventTarget | null): boolean =>
            target === trigger ||
            target === prepared.mounted.optionRoot ||
            [...prepared.mounted.optionRoot.children].some((option) => option === target);
          return Object.freeze({
            ...transaction,
            ownsEventTarget: ownsExactSemanticNode,
            captureWrittenState: (
              expectedOptionText: string,
            ): ComboboxSemanticUndoTransaction | null => {
              const undo = transaction.captureWrittenState(expectedOptionText);
              if (undo === null) return null;
              return Object.freeze({ ...undo, ownsEventTarget: ownsExactSemanticNode });
            },
          });
        },
      },
    });
    const run = await executeCanary(prepared);
    expect(run.summary.filled).toBe(1);
    expect(run.journal.size()).toBe(1);

    const third = makeOption('div', 'next', '', false);
    third.setAttribute('data-option-id', 'third');
    const nested = document.createElement('span');
    nested.textContent = 'Portland';
    third.append(nested);
    third.addEventListener('click', () => {
      run.mounted.prior().setAttribute('aria-selected', 'false');
      run.mounted.next().setAttribute('aria-selected', 'false');
      third.setAttribute('aria-selected', 'true');
    });
    run.mounted.optionRoot.append(third);

    const trusted = new Event('click', { bubbles: true, composed: true });
    Object.defineProperty(trusted, 'isTrusted', { value: true });
    Object.defineProperty(trusted, 'composedPath', {
      value: () => [
        nested,
        third,
        run.mounted.optionRoot,
        run.mounted.form,
        document.body,
        document,
        window,
      ],
    });
    nested.dispatchEvent(trusted);

    const undo = run.journal.undoAll(
      testAuthority(null, 'undo', [...run.journal.requiredUndoCapabilities()]),
    );
    expect(undo).toMatchObject({
      restored: 0,
      skippedUserEdited: 1,
      failed: 0,
      remaining: 0,
    });
    expect(run.entry.semanticAuthority?.readSelection(run.mounted.trigger, 'Portland')).toBe(
      'MATCH',
    );
    expect(run.journal.size()).toBe(0);
  });

  it('demotes and compensates when late host validation aborts the current run', async () => {
    const prepared = prepareCanary();
    const abort = new AbortController();
    let validationReads = 0;
    const run = await executeCanary(prepared, {
      signal: abort.signal,
      readHostValidation: () => {
        validationReads += 1;
        if (validationReads === 2) abort.abort();
        return { ariaInvalid: 'false' };
      },
    });

    expect(validationReads).toBe(2);
    expect(run.summary.results).toEqual([
      { key: 'location', label: 'Location', ok: false, reason: 'ABORTED' },
    ]);
    expect(run.summary).toMatchObject({ filled: 0, abortedBy: null });
    expect(run.entry.semanticAuthority?.readSelection(run.mounted.trigger, 'Manual')).toBe('MATCH');
    expect(run.entry.semanticAuthority?.readSelection(run.mounted.trigger, 'Seattle')).toBe(
      'MISMATCH',
    );
    expect(run.journal.size()).toBe(0);
  });

  it('demotes and retains Undo without another click when late validation observes a host submit', async () => {
    const prepared = prepareCanary();
    let validationReads = 0;
    let hostSubmitEvents = 0;
    prepared.mounted.form.addEventListener('submit', (event) => {
      hostSubmitEvents += 1;
      event.preventDefault();
    });
    const run = await executeCanary(prepared, {
      readHostValidation: () => {
        validationReads += 1;
        if (validationReads === 2) {
          prepared.mounted.form.dispatchEvent(
            new Event('submit', { bubbles: true, cancelable: true }),
          );
        }
        return { ariaInvalid: 'false' };
      },
    });

    expect(validationReads).toBe(2);
    expect(hostSubmitEvents).toBe(1);
    expect(run.summary.results).toEqual([
      { key: 'location', label: 'Location', ok: false, reason: 'HOST_SUBMITTED' },
    ]);
    expect(run.summary).toMatchObject({ filled: 0, abortedBy: 'HOST_SUBMITTED' });
    // Once any host submit is observed, the kernel must not spend a new
    // compensation click. The verified semantic Undo remains visible instead
    // of leaking a filled milestone or silently discarding recovery.
    expect(run.entry.semanticAuthority?.readSelection(run.mounted.trigger, 'Manual')).toBe(
      'MISMATCH',
    );
    expect(run.entry.semanticAuthority?.readSelection(run.mounted.trigger, 'Seattle')).toBe(
      'MATCH',
    );
    expect(run.journal.size()).toBe(1);
  });

  it('does not dispatch a compensation click after option dispatch observes host submit', async () => {
    const prepared = prepareCanary();
    const submit = watchSubmitWitnesses(prepared.mounted.form);
    prepared.mounted.optionRoot.addEventListener('click', (event) => {
      const target = event.target;
      if (!(target instanceof Element) || target.getAttribute('data-option-id') !== 'next') return;
      prepared.mounted.form.dispatchEvent(
        new Event('submit', { bubbles: true, cancelable: true }),
      );
    });

    const run = await executeCanary(prepared);

    expect(run.summary.results).toEqual([
      { key: 'location', label: 'Location', ok: false, reason: 'HOST_SUBMITTED' },
    ]);
    expect(run.summary).toMatchObject({ filled: 0, abortedBy: 'HOST_SUBMITTED' });
    // The first three events are the forward option sequence. Once its click
    // reports host submission, compensation must retain exact Undo without a
    // second restoration pointer sequence.
    expect(run.mounted.optionPointers()).toBe(3);
    expect(run.entry.semanticAuthority?.readSelection(run.mounted.trigger, 'Manual')).toBe(
      'MISMATCH',
    );
    expect(run.entry.semanticAuthority?.readSelection(run.mounted.trigger, 'Seattle')).toBe(
      'MATCH',
    );
    expect(run.journal.size()).toBe(1);
    expect(submit.counts()).toEqual([0, 1, 0, 0]);
  });
});
