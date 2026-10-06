import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ApplyPlan } from '../../src/contracts';
import { fieldSignature } from '../../src/fieldIdentity';
import { runApplyPlan } from '../../src/runner';
import { createScanRoot } from '../../src/scanRoot';
import { createUndoJournal } from '../../src/undo';
import { testApplyPolicy, testAuthority } from '../helpers/applyTestAuthority';

afterEach(() => {
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

describe('S0 · apply never submits', () => {
  it('never reaches submit/requestSubmit or emits submit while filling', async () => {
    const form = document.createElement('form');
    const input = document.createElement('input');
    form.appendChild(input);
    document.body.appendChild(form);
    const submit = vi.spyOn(HTMLFormElement.prototype, 'submit').mockImplementation(() => undefined);
    const requestSubmit = vi.spyOn(HTMLFormElement.prototype, 'requestSubmit').mockImplementation(() => undefined);
    const submitEvents: string[] = [];
    form.addEventListener('submit', (event) => {
      submitEvents.push(event.type);
      event.preventDefault();
    });

    // Reverse probes prove the spies and event listener can see violations.
    form.submit();
    form.requestSubmit();
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    expect(submit, 'submit 探针没有抓到 canary').toHaveBeenCalledTimes(1);
    expect(requestSubmit, 'requestSubmit 探针没有抓到 canary').toHaveBeenCalledTimes(1);
    expect(submitEvents, 'submit 事件探针没有抓到 canary').toEqual(['submit']);
    submit.mockClear();
    requestSubmit.mockClear();
    submitEvents.length = 0;

    const root = createScanRoot(document.body, []);
    const plan: ApplyPlan = {
      vendor: 'greenhouse',
      fingerprint: 's0-never-submit',
      fillEmptyOnly: true,
      entries: [{ kind: 'text', required: false, key: 'email', label: 'Email', value: 'alex@example.com', element: input, order: 0, confidence: 1, signature: fieldSignature(input, root) }],
      skipped: [],
    };
    const result = await runApplyPlan({
      plan,
      auth: testAuthority(plan.fingerprint),
      journal: createUndoJournal(),
      root,
      policy: testApplyPolicy(),
    });

    expect(result.filled).toBe(1);
    expect(submit).not.toHaveBeenCalled();
    expect(requestSubmit).not.toHaveBeenCalled();
    expect(submitEvents).toEqual([]);
  });
});
