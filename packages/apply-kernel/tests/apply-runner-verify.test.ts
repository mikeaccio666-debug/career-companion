import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ApplyPlan } from '../src/contracts';
import { checkActiveCapability } from '../src/grant';
import { runApplyPlan } from '../src/runner';
import { fieldSignature } from '../src/fieldIdentity';
import { createScanRoot } from '../src/scanRoot';
import { createUndoJournal } from '../src/undo';
import { WRITE_VERIFICATION_TIMEOUT_MS } from '../src/write/verify';
import { testApplyPolicy, testAuthority } from './helpers/applyTestAuthority';

afterEach(() => {
  document.body.innerHTML = '';
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function textPlan(element: HTMLInputElement, value: string, fingerprint = 'runner-verify'): ApplyPlan {
  const root = createScanRoot(document.body, []);
  return {
    vendor: 'greenhouse',
    fingerprint,
    fillEmptyOnly: false,
    entries: [{ kind: 'text', required: false, key: 'email', label: 'Email', value, element, order: 0, confidence: 1, signature: fieldSignature(element, root) }],
    skipped: [],
  };
}

describe('runApplyPlan async write verification', () => {
  it('reports a controlled-host rollback and abandons its Undo ticket', async () => {
    const input = document.createElement('input');
    input.value = 'old@example.test';
    document.body.appendChild(input);
    input.addEventListener('input', () => {
      queueMicrotask(() => {
        input.value = 'old@example.test';
      });
    });
    const plan = textPlan(input, 'new@example.test');
    const journal = createUndoJournal();

    const summary = await runApplyPlan({
      plan,
      auth: testAuthority(plan.fingerprint),
      journal,
      root: createScanRoot(document.body, []),
      policy: testApplyPolicy(),
    });

    expect(summary).toMatchObject({ filled: 0, failed: 1 });
    expect(summary.results).toEqual([
      { key: 'email', label: 'Email', ok: false, reason: 'WRITE_REVERTED' },
    ]);
    expect(input.value).toBe('old@example.test');
    expect(journal.canUndo()).toBe(false);
  });

  it('reports a host-forced third value as VALUE_COERCED while preserving Undo', async () => {
    const input = document.createElement('input');
    document.body.appendChild(input);
    input.addEventListener('input', () => {
      queueMicrotask(() => {
        input.value = '+1 555 555 0123';
      });
    });
    const plan = textPlan(input, '555 555 0123');
    const journal = createUndoJournal();

    const summary = await runApplyPlan({
      plan,
      auth: testAuthority(plan.fingerprint),
      journal,
      root: createScanRoot(document.body, []),
      policy: testApplyPolicy(),
    });

    expect(summary.results).toEqual([
      { key: 'email', label: 'Email', ok: false, reason: 'VALUE_COERCED' },
    ]);
    expect(journal.canUndo()).toBe(true);
    expect(journal.undoAll(testAuthority(null, 'undo'))).toMatchObject({ restored: 1, remaining: 0 });
    expect(input.value).toBe('');
  });

  it('does not mistake a native select option label for its DOM value', async () => {
    const select = document.createElement('select');
    select.innerHTML = '<option value=""></option><option value="us">United States</option>';
    document.body.appendChild(select);
    const root = createScanRoot(document.body, []);
    const plan: ApplyPlan = {
      vendor: 'greenhouse',
      fingerprint: 'runner-select-value',
      fillEmptyOnly: false,
      entries: [{ kind: 'select', required: false, key: 'city', label: 'Country', value: 'United States', element: select, order: 0, confidence: 1, signature: fieldSignature(select, root) }],
      skipped: [],
    };
    const journal = createUndoJournal();

    const summary = await runApplyPlan({
      plan,
      auth: testAuthority(plan.fingerprint),
      journal,
      root,
      policy: testApplyPolicy(),
    });

    expect(summary).toMatchObject({ filled: 1, failed: 0 });
    expect(select.value).toBe('us');
    expect(journal.undoAll(testAuthority(null, 'undo'))).toMatchObject({ restored: 1 });
  });

  it('treats a field removed during settle as detached and never commits it', async () => {
    const input = document.createElement('input');
    document.body.appendChild(input);
    input.addEventListener('input', () => {
      queueMicrotask(() => input.remove());
    });
    const plan = textPlan(input, 'new@example.test');
    const journal = createUndoJournal();

    const summary = await runApplyPlan({
      plan,
      auth: testAuthority(plan.fingerprint),
      journal,
      root: createScanRoot(document.body, []),
      policy: testApplyPolicy(),
    });

    expect(summary.results).toEqual([
      { key: 'email', label: 'Email', ok: false, reason: 'DETACHED' },
    ]);
    expect(journal.canUndo()).toBe(false);
  });

  it('never turns a trusted edit during verification into an Undo snapshot', async () => {
    const input = document.createElement('input');
    document.body.appendChild(input);
    input.addEventListener('input', (event) => {
      if (event.isTrusted) return;
      queueMicrotask(() => {
        input.value = 'candidate@example.test';
        const userInput = new Event('input', { bubbles: true });
        Object.defineProperty(userInput, 'isTrusted', { value: true });
        input.dispatchEvent(userInput);
      });
    });
    const plan = textPlan(input, 'new@example.test');
    const journal = createUndoJournal();

    const summary = await runApplyPlan({
      plan,
      auth: testAuthority(plan.fingerprint),
      journal,
      root: createScanRoot(document.body, []),
      policy: testApplyPolicy(),
    });

    expect(summary.results).toEqual([
      { key: 'email', label: 'Email', ok: false, reason: 'VALUE_COERCED' },
    ]);
    expect(journal.canUndo()).toBe(false);
    expect(journal.undoAll(testAuthority(null, 'undo'))).toMatchObject({ restored: 0, remaining: 0 });
    expect(input.value).toBe('candidate@example.test');
  });

  it('releases write authority before a bounded verification timeout', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1));
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
    const input = document.createElement('input');
    document.body.appendChild(input);
    const plan = textPlan(input, 'new@example.test', 'runner-timeout');
    const auth = testAuthority(plan.fingerprint);
    const journal = createUndoJournal();

    const pending = runApplyPlan({
      plan,
      auth,
      journal,
      root: createScanRoot(document.body, []),
      policy: testApplyPolicy(),
    });
    expect(checkActiveCapability(auth, 'set-text')).toEqual({ ok: false, code: 'GESTURE_UNTRUSTED' });

    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(WRITE_VERIFICATION_TIMEOUT_MS);
    await expect(pending).resolves.toEqual({
      results: [{ key: 'email', label: 'Email', ok: false, reason: 'VERIFY_TIMEOUT' }],
      filled: 0,
      failed: 1,
      abortedBy: null,
      identityDrift: 0,
      labelHintDrifted: 0,
      recheck: expect.any(Function),
    });
    expect(journal.canUndo()).toBe(true);
    expect(journal.undoAll(testAuthority(null, 'undo'))).toMatchObject({ restored: 1, remaining: 0 });
    expect(input.value).toBe('');
  });
});
