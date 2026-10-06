import { afterEach, describe, expect, it } from 'vitest';

import applyRulesPackage from '../../apply-rules/package.json';
import ashbyCanary from '../../apply-rules/rules/ashby-controlled-combobox-canary.json';
import greenhouseCanary from '../../apply-rules/rules/greenhouse-controlled-combobox-canary.json';
import ripplingCanary from '../../apply-rules/rules/rippling-controlled-combobox-canary.json';
import smartrecruitersCanary from '../../apply-rules/rules/smartrecruiters-controlled-combobox-canary.json';
import greenhouseRules from '@edaix/apply-rules/greenhouse.json';

import { buildApplyPlan } from '../src/engine';
import type { ComboboxSemanticAuthority, ScanRoot, VendorAdapter } from '../src/contracts';
import { compileBundledAdapter } from '../src/rules/interpreter';
import { parseVendorRuleset } from '../src/rules/schema';
import { runApplyPlan } from '../src/runner';
import { createUndoJournal } from '../src/undo';
import { testApplyPolicy, testAuthority } from './helpers/applyTestAuthority';

const CANARIES = [
  ['greenhouse', greenhouseCanary],
  ['ashby', ashbyCanary],
  ['rippling', ripplingCanary],
  ['smartrecruiters', smartrecruitersCanary],
] as const;

interface MountedCanary {
  readonly form: HTMLFormElement;
  readonly trigger: HTMLInputElement;
  readonly optionRoot: HTMLDivElement;
  readonly prior: HTMLDivElement;
  readonly next: HTMLDivElement;
  readonly priorClicks: () => number;
}

function mountCanary(priorText = 'Manual'): MountedCanary {
  const form = document.createElement('form');
  const label = document.createElement('label');
  label.append('Location');

  const trigger = document.createElement('input');
  trigger.type = 'text';
  trigger.setAttribute('role', 'combobox');
  trigger.setAttribute('aria-expanded', 'false');
  label.append(trigger);

  const optionRoot = document.createElement('div');
  optionRoot.setAttribute('role', 'listbox');

  const prior = document.createElement('div');
  prior.setAttribute('role', 'option');
  prior.setAttribute('data-option-id', 'prior');
  prior.setAttribute('aria-selected', 'true');
  prior.textContent = priorText;

  const next = document.createElement('div');
  next.setAttribute('role', 'option');
  next.setAttribute('data-option-id', 'next');
  next.setAttribute('aria-selected', 'false');
  next.textContent = 'Seattle';

  let priorClickCount = 0;
  const select = (option: Element) => {
    for (const member of [prior, next]) {
      member.setAttribute('aria-selected', member === option ? 'true' : 'false');
    }
  };
  prior.addEventListener('click', () => {
    priorClickCount += 1;
    select(prior);
  });
  next.addEventListener('click', () => select(next));

  optionRoot.append(prior, next);
  form.append(label, optionRoot);
  document.body.append(form);
  return { form, trigger, optionRoot, prior, next, priorClicks: () => priorClickCount };
}

interface SubmitWitness {
  readonly counts: () => readonly [number, number, number, number];
}

function watchSubmit(mounted: MountedCanary): SubmitWitness {
  const submit = document.createElement('button');
  submit.type = 'submit';
  submit.textContent = 'Submit Application';
  let buttonClicks = 0;
  let submitEvents = 0;
  let directSubmitCalls = 0;
  let requestSubmitCalls = 0;
  submit.addEventListener('click', () => { buttonClicks += 1; });
  mounted.form.addEventListener('submit', (event) => {
    submitEvents += 1;
    event.preventDefault();
  });
  Object.defineProperty(mounted.form, 'submit', {
    configurable: true,
    value: () => { directSubmitCalls += 1; },
  });
  Object.defineProperty(mounted.form, 'requestSubmit', {
    configurable: true,
    value: () => { requestSubmitCalls += 1; },
  });
  mounted.form.append(submit);
  return {
    counts: () => [buttonClicks, submitEvents, directSubmitCalls, requestSubmitCalls],
  };
}

function makeOption(
  identity: string,
  text: string,
  selected: boolean,
): HTMLDivElement {
  const option = document.createElement('div');
  option.setAttribute('role', 'option');
  option.setAttribute('data-option-id', identity);
  option.setAttribute('aria-selected', selected ? 'true' : 'false');
  option.textContent = text;
  return option;
}

function installInteractiveOptions(
  mounted: MountedCanary,
  mode: 'raw-value-only' | 'semantic-success',
): () => number {
  let rawValueWrites = 0;
  mounted.trigger.addEventListener('click', () => {
    mounted.trigger.setAttribute('aria-expanded', 'true');
    const prior = makeOption('prior', 'Manual', true);
    const next = makeOption('next', 'Seattle', false);
    const select = (selected: Element) => {
      prior.setAttribute('aria-selected', selected === prior ? 'true' : 'false');
      next.setAttribute('aria-selected', selected === next ? 'true' : 'false');
    };
    prior.addEventListener('click', () => {
      select(prior);
      mounted.trigger.setAttribute('aria-expanded', 'false');
    });
    next.addEventListener('click', () => {
      // This visible search-input value is deliberately never read as semantic
      // success. Nine B-R2 canaries reproduce value===expected at the host
      // handler boundary with the exact prior selected option unchanged; the
      // failed transaction must then compensate both semantic and visible
      // control state.
      mounted.trigger.value = 'Seattle';
      rawValueWrites += 1;
      if (mode === 'semantic-success') select(next);
      mounted.trigger.setAttribute('aria-expanded', 'false');
    });
    mounted.optionRoot.replaceChildren(prior, next);
  }, { once: true });
  return () => rawValueWrites;
}

async function runControlledCanary(
  source: unknown,
  mode: 'raw-value-only' | 'semantic-success',
) {
  const mounted = mountCanary();
  const submit = watchSubmit(mounted);
  const rawValueWrites = installInteractiveOptions(mounted, mode);
  const parsed = parseVendorRuleset(source);
  if (!parsed.ok) throw new Error(parsed.code);
  const adapter = compileBundledAdapter(source);
  const root = adapter.resolveRoot(document)!;
  const form = {
    vendor: parsed.value.vendor,
    root,
    fields: [...adapter.scan(root)],
  };
  const plan = buildApplyPlan(
    form,
    { location: 'Seattle' },
    { fillEmptyOnly: false },
  );
  const journal = createUndoJournal();
  const summary = await runApplyPlan({
    plan,
    auth: testAuthority(plan.fingerprint, 'fill', ['set-combobox']),
    journal,
    root,
    policy: testApplyPolicy(),
    readHostValidation: () => ({ ariaInvalid: 'false' }),
    lateRecheckMs: 1,
    lateRecheckDelay: async () => undefined,
  });
  const entry = plan.entries.find((candidate) => candidate.kind === 'combobox');
  expect(entry?.kind).toBe('combobox');
  return { mounted, submit, root, plan, entry: entry!, journal, summary, rawValueWrites };
}

function authorityFor(
  source: unknown,
  mounted: MountedCanary,
): { readonly authority: ComboboxSemanticAuthority; readonly root: ScanRoot; readonly adapter: VendorAdapter } {
  const adapter = compileBundledAdapter(source);
  const root = adapter.resolveRoot(document);
  expect(root).not.toBeNull();
  const field = adapter.scan(root!).find((candidate) => candidate.element === mounted.trigger);
  expect(field?.kind).toBe('combobox');
  const authority = field?.kind === 'combobox' ? field.semanticAuthority : undefined;
  expect(authority).toBeDefined();
  return { authority: authority!, root: root!, adapter };
}

afterEach(() => {
  document.body.innerHTML = '';
});

describe('apply-rules combobox semantic authority · default-off data boundary', () => {
  it.each(CANARIES)('%s controlled canary parses and mints one selector-free authority', (vendor, source) => {
    const parsed = parseVendorRuleset(source);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.value.vendor).toBe(vendor);
      expect(parsed.value.comboboxSemanticControls).toHaveLength(1);
    }

    const mounted = mountCanary();
    const { authority } = authorityFor(source, mounted);
    expect(authority.readSelection(mounted.trigger, 'Manual')).toBe('MATCH');
  });

  it('keeps every production ruleset default-off and every controlled canary outside runtime exports', () => {
    const parsed = parseVendorRuleset(greenhouseRules);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.value.comboboxSemanticControls).toEqual([]);

    expect(JSON.stringify(applyRulesPackage.exports)).not.toContain('controlled-combobox-canary');
  });

  it('mints no authority when the exact trigger selector resolves zero or multiple nodes', () => {
    const mounted = mountCanary();
    const duplicate = mounted.trigger.cloneNode(true);
    mounted.trigger.parentElement?.append(duplicate);

    const adapter = compileBundledAdapter(greenhouseCanary);
    const root = adapter.resolveRoot(document)!;
    const comboboxes = adapter.scan(root).filter((field) => field.kind === 'combobox');
    expect(comboboxes).toHaveLength(2);
    expect(comboboxes.every((field) => field.kind === 'combobox' && field.semanticAuthority === undefined)).toBe(true);
  });

  it('rejects incomplete, ambiguous, or widened transaction descriptors as RULES_MALFORMED', () => {
    const variants: unknown[] = [];
    for (const mutate of [
      (rule: Record<string, unknown>) => { delete rule['optionIdentityAttribute']; },
      (rule: Record<string, unknown>) => { rule['triggerSelector'] = ''; },
      (rule: Record<string, unknown>) => { rule['optionRootSelector'] = '   '; },
      (rule: Record<string, unknown>) => { rule['optionIdentityAttribute'] = 'bad attribute'; },
      (rule: Record<string, unknown>) => {
        (rule['selectedState'] as Record<string, unknown>)['unselectedValue'] = 'true';
      },
      (rule: Record<string, unknown>) => {
        (rule['transaction'] as Record<string, unknown>)['restoreActivation'] = 'set-value';
      },
      (rule: Record<string, unknown>) => { rule['fallbackSelector'] = '[role=option]'; },
    ]) {
      const source = structuredClone(greenhouseCanary) as Record<string, unknown>;
      const rule = (source['comboboxSemanticControls'] as Array<Record<string, unknown>>)[0]!;
      mutate(rule);
      variants.push(source);
    }
    for (const source of variants) {
      expect(parseVendorRuleset(source)).toEqual({ ok: false, code: 'RULES_MALFORMED' });
    }
  });
});

describe('apply-rules combobox semantic authority · selected state and Undo', () => {
  it('never treats trigger.value as semantic success and requires exact selected-state evidence', () => {
    const mounted = mountCanary();
    const { authority } = authorityFor(greenhouseCanary, mounted);

    mounted.trigger.value = 'Seattle';
    expect(authority.readSelection(mounted.trigger, 'Seattle')).toBe('MISMATCH');

    mounted.prior.setAttribute('aria-selected', 'false');
    mounted.next.setAttribute('aria-selected', 'true');
    mounted.trigger.value = 'not the selected option';
    expect(authority.readSelection(mounted.trigger, 'Seattle')).toBe('MATCH');

    mounted.next.removeAttribute('aria-selected');
    expect(authority.readSelection(mounted.trigger, 'Seattle')).toBe('UNVERIFIABLE');
  });

  it('snapshots one exact prior option, seals the semantic write, and restores through that option', () => {
    const mounted = mountCanary();
    const { authority, root } = authorityFor(ashbyCanary, mounted);
    const transaction = authority.semanticTransactionSource.snapshot(mounted.trigger, root);
    expect(transaction).not.toBeNull();
    expect(transaction?.isAtPreWriteState()).toBe(true);

    mounted.next.click();
    expect(authority.readSelection(mounted.trigger, 'Seattle')).toBe('MATCH');
    expect(transaction?.isAtPreWriteState()).toBe(false);

    const undo = transaction?.captureWrittenState('Seattle');
    expect(undo).not.toBeNull();
    expect(undo?.isAtWrittenState()).toBe(true);
    expect(undo?.wasUserEdited()).toBe(false);
    expect(undo?.restorePreWrite()).toBe(true);
    expect(undo?.isAtPreWriteState()).toBe(true);
    expect(authority.readSelection(mounted.trigger, 'Manual')).toBe('MATCH');
    expect(mounted.priorClicks()).toBe(1);
    expect(() => undo?.dispose()).not.toThrow();
  });

  it('refuses a transaction before any mutation when no exact prior selected option exists', () => {
    const mounted = mountCanary();
    mounted.prior.setAttribute('aria-selected', 'false');
    const { authority, root } = authorityFor(ripplingCanary, mounted);

    expect(authority.readSelection(mounted.trigger, 'Seattle')).toBe('EMPTY');
    expect(authority.semanticTransactionSource.snapshot(mounted.trigger, root)).toBeNull();
    expect(mounted.priorClicks()).toBe(0);
  });

  it('fails Undo closed on identity drift and rejects a Submit-looking restore target before write', () => {
    const identityDrift = mountCanary();
    const first = authorityFor(smartrecruitersCanary, identityDrift);
    const transaction = first.authority.semanticTransactionSource.snapshot(identityDrift.trigger, first.root)!;
    identityDrift.next.click();
    const undo = transaction.captureWrittenState('Seattle')!;
    identityDrift.prior.removeAttribute('role');
    expect(undo.restorePreWrite()).toBe(false);
    expect(identityDrift.priorClicks()).toBe(0);

    document.body.innerHTML = '';
    const submitLooking = mountCanary('Submit Application');
    const second = authorityFor(smartrecruitersCanary, submitLooking);
    const secondTransaction = second.authority.semanticTransactionSource.snapshot(
      submitLooking.trigger,
      second.root,
    )!;
    expect(secondTransaction.canRestorePreWrite()).toBe(false);
    expect(secondTransaction.captureWrittenState('Seattle')).toBeNull();
    expect(submitLooking.priorClicks()).toBe(0);
    expect(second.authority.readSelection(submitLooking.trigger, 'Submit Application')).toBe(
      'MATCH',
    );
    expect(second.authority.readSelection(submitLooking.trigger, 'Seattle')).toBe('MISMATCH');
  });
});

const RAW_VALUE_FALSE_POSITIVE_CANARIES = [
  ['greenhouse-1', greenhouseCanary],
  ['greenhouse-2', greenhouseCanary],
  ['greenhouse-3', greenhouseCanary],
  ['ashby-1', ashbyCanary],
  ['ashby-2', ashbyCanary],
  ['rippling-1', ripplingCanary],
  ['rippling-2', ripplingCanary],
  ['smartrecruiters-1', smartrecruitersCanary],
  ['smartrecruiters-2', smartrecruitersCanary],
] as const;

describe('B-R2 raw-value false-positive matrix · CONTROLLED_REHEARSAL / NOT_E2E', () => {
  it.each(RAW_VALUE_FALSE_POSITIVE_CANARIES)(
    '%s keeps value-only success out of filled/journal/Submit',
    async (_name, source) => {
      const run = await runControlledCanary(source, 'raw-value-only');
      expect(run.rawValueWrites()).toBe(1);
      // Raw value alone is neither success nor restore ownership. The semantic
      // backing remains the prior exact option, while the unsealed raw residue
      // is left visible and cannot mint a future Undo capability.
      expect(run.mounted.trigger.value).toBe('Seattle');
      expect(run.entry.semanticAuthority?.readSelection(run.mounted.trigger, 'Seattle')).toBe(
        'MISMATCH',
      );
      expect(run.entry.semanticAuthority?.readSelection(run.mounted.trigger, 'Manual')).toBe(
        'MATCH',
      );
      expect(run.summary.filled).toBe(0);
      expect(run.summary.results).toEqual([
        { key: 'location', label: 'Location', ok: false, reason: 'IDENTITY_CHANGED' },
      ]);
      expect(run.journal.size()).toBe(0);
      expect(run.submit.counts()).toEqual([0, 0, 0, 0]);
    },
  );

  it('runs one semantic success through late recheck and exact journal Undo', async () => {
    const run = await runControlledCanary(greenhouseCanary, 'semantic-success');
    expect(run.summary).toMatchObject({ filled: 1, failed: 0, abortedBy: null });
    expect(run.entry.semanticAuthority?.readSelection(run.mounted.trigger, 'Seattle')).toBe(
      'MATCH',
    );
    expect(run.journal.size()).toBe(1);
    expect([...run.journal.requiredUndoCapabilities()]).toEqual(['set-combobox']);

    const undo = run.journal.undoAll(
      testAuthority(null, 'undo', [...run.journal.requiredUndoCapabilities()]),
    );
    expect(undo).toMatchObject({ restored: 1, failed: 0, remaining: 0 });
    expect(run.entry.semanticAuthority?.readSelection(run.mounted.trigger, 'Manual')).toBe(
      'MATCH',
    );
    expect(run.entry.semanticAuthority?.readSelection(run.mounted.trigger, 'Seattle')).toBe(
      'MISMATCH',
    );

    // `summary.filled` is the historical write result. A controlled acceptance
    // report after Undo must re-read current semantic state and never reuse it.
    const postUndoCurrentStateReport = {
      currentlyFilled: run.plan.entries.filter(
        (entry) => entry.kind === 'combobox' &&
          entry.semanticAuthority?.readSelection(entry.element, entry.resolvedOptionText ?? entry.value) ===
            'MATCH',
      ).length,
      acceptance: 'CONTROLLED_REHEARSAL_NOT_E2E' as const,
    };
    expect(postUndoCurrentStateReport).toEqual({
      currentlyFilled: 0,
      acceptance: 'CONTROLLED_REHEARSAL_NOT_E2E',
    });
    expect(run.journal.size()).toBe(0);
    expect(run.mounted.trigger.value).toBe('');
    expect(run.submit.counts()).toEqual([0, 0, 0, 0]);
  });
});
