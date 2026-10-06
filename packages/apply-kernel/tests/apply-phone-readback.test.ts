import { afterEach, describe, expect, it } from 'vitest';

import type { ApplyPlan } from '../src/contracts';
import { runApplyPlan } from '../src/runner';
import { fieldSignature } from '../src/fieldIdentity';
import { createScanRoot } from '../src/scanRoot';
import { createUndoJournal } from '../src/undo';
import { testApplyPolicy, testAuthority } from './helpers/applyTestAuthority';

afterEach(() => {
  document.body.innerHTML = '';
});

/**
 * 2026-09-15 实测：Workable（intl-tel-input）与 Rippling 都会把写入的
 * `+1 415 555 0142` 改写成本地记法并把 +1 挪进自己的国家选择器。
 * 只有电话控件走 tel-aware 回读；其它控件的宿主改写仍是 VALUE_COERCED。
 */
describe('runApplyPlan tel-aware phone readback', () => {
  function plan(element: HTMLInputElement, key: 'phone' | 'email', value: string): ApplyPlan {
    const root = createScanRoot(document.body, []);
    return {
      vendor: 'workable',
      fingerprint: `runner-tel-${key}`,
      fillEmptyOnly: true,
      entries: [{ kind: 'text', required: true, key, label: key, value, element, order: 0, confidence: 1, signature: fieldSignature(element, root) }],
      skipped: [],
    };
  }

  function reformatOnInput(input: HTMLInputElement, reformatted: string): void {
    input.addEventListener('input', () => {
      queueMicrotask(() => {
        input.value = reformatted;
      });
    });
  }

  it('accepts a host that reformats a type=tel number and moves +1 into its country selector', async () => {
    const input = document.createElement('input');
    input.type = 'tel';
    document.body.appendChild(input);
    reformatOnInput(input, '(415) 555-0142');
    const journal = createUndoJournal();
    const current = plan(input, 'phone', '+1 415 555 0142');

    const summary = await runApplyPlan({
      plan: current,
      auth: testAuthority(current.fingerprint),
      journal,
      root: createScanRoot(document.body, []),
      policy: testApplyPolicy(),
      lateRecheckMs: 5,
    });

    expect(summary.results).toEqual([{ key: 'phone', label: 'phone', ok: true }]);
    expect(summary).toMatchObject({ filled: 1, failed: 0 });
    expect(input.value).toBe('(415) 555-0142');
    // Undo restores the pre-write empty value, not the profile string.
    expect(journal.undoAll(testAuthority(null, 'undo'))).toMatchObject({ restored: 1, remaining: 0 });
    expect(input.value).toBe('');
  });

  it('still reports a phone host that keeps a different number as VALUE_COERCED', async () => {
    const input = document.createElement('input');
    input.type = 'tel';
    document.body.appendChild(input);
    reformatOnInput(input, '(415) 555-0100');
    const current = plan(input, 'phone', '+1 415 555 0142');

    const summary = await runApplyPlan({
      plan: current,
      auth: testAuthority(current.fingerprint),
      journal: createUndoJournal(),
      root: createScanRoot(document.body, []),
      policy: testApplyPolicy(),
    });

    expect(summary.results).toEqual([{ key: 'phone', label: 'phone', ok: false, reason: 'VALUE_COERCED' }]);
  });

  it('keeps the strict comparison for a non-phone text control', async () => {
    const input = document.createElement('input');
    document.body.appendChild(input);
    reformatOnInput(input, '(415) 555-0142');
    const current = plan(input, 'email', '+1 415 555 0142');

    const summary = await runApplyPlan({
      plan: current,
      auth: testAuthority(current.fingerprint),
      journal: createUndoJournal(),
      root: createScanRoot(document.body, []),
      policy: testApplyPolicy(),
    });

    expect(summary.results).toEqual([{ key: 'email', label: 'email', ok: false, reason: 'VALUE_COERCED' }]);
  });
});
