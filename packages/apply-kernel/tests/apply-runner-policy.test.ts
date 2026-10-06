import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ApplyPlan } from '../src/contracts';
import { fieldSignature } from '../src/fieldIdentity';
import { runApplyPlan } from '../src/runner';
import { createScanRoot } from '../src/scanRoot';
import { createUndoJournal } from '../src/undo';
import { testApplyPolicy, testAuthority } from './helpers/applyTestAuthority';

afterEach(() => {
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

function planFor(
  element: HTMLInputElement,
  confidence = 1,
): { readonly plan: ApplyPlan; readonly root: ReturnType<typeof createScanRoot> } {
  const root = createScanRoot(document.body, []);
  return {
    root,
    plan: {
      vendor: 'greenhouse',
      fingerprint: 'policy-runner',
      fillEmptyOnly: true,
      entries: [
        {
          kind: 'text',
          required: false,
          key: 'email',
          label: 'Email',
          value: 'alex@example.test',
          element,
          confidence,
          order: 0,
          signature: fieldSignature(element, root),
        },
      ],
      skipped: [],
    },
  };
}

function setterCanary(input: HTMLInputElement) {
  const setter = vi.spyOn(HTMLInputElement.prototype, 'value', 'set');
  input.value = 'policy-canary';
  expect(setter, 'input value setter 探针没有抓到 canary').toHaveBeenCalledTimes(1);
  input.value = '';
  setter.mockClear();
  return setter;
}

describe('runApplyPlan policy backstop', () => {
  it.each([
    {
      name: 'global kill closes the policy',
      policy: () => ({ ...testApplyPolicy(), enabled: false }),
    },
    {
      name: 'current vendor is disabled',
      policy: () => {
        const baseline = testApplyPolicy();
        return {
          ...baseline,
          vendors: { ...baseline.vendors, greenhouse: false },
        };
      },
    },
  ])('$name causes zero host writes', async ({ policy }) => {
    const input = document.createElement('input');
    document.body.appendChild(input);
    const { plan, root } = planFor(input);
    const journal = createUndoJournal();
    const setter = setterCanary(input);

    const run = await runApplyPlan({
      plan,
      auth: testAuthority(plan.fingerprint),
      journal,
      root,
      policy: policy(),
    });

    expect(run).toMatchObject({ filled: 0, failed: 1 });
    expect(run.results).toEqual([
      { key: 'email', label: 'Email', ok: false, reason: 'POLICY_DISABLED' },
    ]);
    expect(setter).not.toHaveBeenCalled();
    expect(journal.size()).toBe(0);
  });

  it('rechecks a stricter minimum confidence before recording an Undo ticket', async () => {
    const input = document.createElement('input');
    document.body.appendChild(input);
    // The engine's bundled threshold admits this reviewed plan (0.8 >= 0.7),
    // while a freshly loaded policy may only tighten it to 0.9.
    const { plan, root } = planFor(input, 0.8);
    const journal = createUndoJournal();
    const setter = setterCanary(input);
    const baseline = testApplyPolicy();

    const run = await runApplyPlan({
      plan,
      auth: testAuthority(plan.fingerprint),
      journal,
      root,
      policy: { ...baseline, minConfidence: 0.9 },
    });

    expect(run).toMatchObject({ filled: 0, failed: 1 });
    expect(run.results).toEqual([
      { key: 'email', label: 'Email', ok: false, reason: 'LOW_CONFIDENCE' },
    ]);
    expect(setter).not.toHaveBeenCalled();
    expect(journal.size()).toBe(0);
  });

  it('a remote capability kill denies the matching field before any host write', async () => {
    const input = document.createElement('input');
    document.body.appendChild(input);
    const { plan, root } = planFor(input);
    const baseline = testApplyPolicy();
    const setter = setterCanary(input);

    const run = await runApplyPlan({
      plan,
      auth: testAuthority(plan.fingerprint),
      journal: createUndoJournal(),
      root,
      policy: {
        ...baseline,
        capabilities: { ...baseline.capabilities, 'set-text': false },
      },
    });

    expect(run.results).toEqual([
      { key: 'email', label: 'Email', ok: false, reason: 'CAPABILITY_DISABLED' },
    ]);
    expect(setter).not.toHaveBeenCalled();
  });

  it('rechecks remote policy expiry after each host interaction', async () => {
    document.body.innerHTML = '<input id="first"><input id="second">';
    const first = document.querySelector<HTMLInputElement>('#first')!;
    const second = document.querySelector<HTMLInputElement>('#second')!;
    const root = createScanRoot(document.body, []);
    const plan: ApplyPlan = {
      vendor: 'greenhouse',
      fingerprint: 'policy-expiry-between-fields',
      fillEmptyOnly: true,
      entries: [first, second].map((element, index) => ({
        kind: 'text' as const,
        required: false,
        key: index === 0 ? 'firstName' as const : 'lastName' as const,
        label: index === 0 ? 'First name' : 'Last name',
        value: index === 0 ? 'Ada' : 'Lovelace',
        element,
        confidence: 1,
        order: index,
        signature: fieldSignature(element, root),
      })),
      skipped: [],
    };
    let clock = 100;
    const policy = { ...testApplyPolicy(), notAfter: 150 };

    const run = await runApplyPlan({
      plan,
      auth: testAuthority(plan.fingerprint),
      journal: createUndoJournal(),
      root,
      policy,
      now: () => clock,
      mutationDeliveryCheckpoint: async () => {
        clock = 200;
      },
    });

    expect(first.value).toBe('Ada');
    expect(second.value).toBe('');
    expect(run.results[1]).toEqual({
      key: 'lastName',
      label: 'Last name',
      ok: false,
      reason: 'POLICY_DISABLED',
    });
  });

  it('crosses a real task boundary before the next reviewed field', async () => {
    document.body.innerHTML = '<input id="first"><input id="second">';
    const first = document.querySelector<HTMLInputElement>('#first')!;
    const second = document.querySelector<HTMLInputElement>('#second')!;
    const root = createScanRoot(document.body, []);
    const plan: ApplyPlan = {
      vendor: 'greenhouse',
      fingerprint: 'nested-microtask-mutation',
      fillEmptyOnly: true,
      entries: [first, second].map((element, index) => ({
        kind: 'text' as const,
        required: false,
        key: index === 0 ? 'firstName' as const : 'lastName' as const,
        label: index === 0 ? 'First name' : 'Last name',
        value: index === 0 ? 'Ada' : 'Lovelace',
        element,
        confidence: 1,
        order: index,
        signature: fieldSignature(element, root),
      })),
      skipped: [],
    };
    let scanCurrent = true;
    first.addEventListener('input', () => {
      void Promise.resolve().then(() => Promise.resolve()).then(() => {
        scanCurrent = false;
      });
    });

    const run = await runApplyPlan({
      plan,
      auth: testAuthority(plan.fingerprint),
      journal: createUndoJournal(),
      root,
      policy: testApplyPolicy(),
      scanStillCurrent: () => scanCurrent,
    });

    expect(first.value).toBe('Ada');
    expect(second.value).toBe('');
    expect(run.results[1]).toEqual({
      key: 'lastName',
      label: 'Last name',
      ok: false,
      reason: 'ABORTED',
    });
  });
});
