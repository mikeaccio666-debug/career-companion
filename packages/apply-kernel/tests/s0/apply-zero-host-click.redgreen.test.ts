import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ApplyPlan } from '../../src/contracts';
import { fieldSignature } from '../../src/fieldIdentity';
import { runApplyPlan } from '../../src/runner';
import { createScanRoot } from '../../src/scanRoot';
import { createUndoJournal } from '../../src/undo';
import { beginMainWorldReactChange } from '../../src/write/mainWorldBridge';
import { installMainWorldBridge } from '../../src/write/mainWorldHandler';
import { testApplyPolicy, testAuthority } from '../helpers/applyTestAuthority';

function planFor(input: HTMLInputElement): ApplyPlan {
  const root = createScanRoot(document.body, []);
  return {
    vendor: 'greenhouse',
    fingerprint: 's0-no-click',
    fillEmptyOnly: true,
    entries: [{ kind: 'text', required: false, key: 'email', label: 'Email', value: 'alex@example.com', element: input, order: 0, confidence: 1, signature: fieldSignature(input, root) }],
    skipped: [],
  };
}

afterEach(() => {
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

/**
 * Phase A keeps the current iron rule intact: the static click policy exists
 * only as a pure future guard, and the v1 write path must still cause zero
 * host clicks. The canary proves the concrete-prototype probe is live in
 * happy-dom instead of silently observing nothing.
 */
describe('S0 · apply zero host click', () => {
  it('writes a reviewed plan without click-family events or HTMLElement.click()', async () => {
    const click = vi.spyOn(HTMLElement.prototype, 'click');
    const seen: string[] = [];
    const observe = (event: Event) => seen.push(event.type);
    for (const type of ['click', 'mousedown', 'mouseup', 'pointerdown', 'pointerup']) {
      document.addEventListener(type, observe, true);
    }

    try {
      // Reverse probe: if this does not register, this S0 test is invalid.
      const canary = document.createElement('button');
      document.body.appendChild(canary);
      canary.click();
      expect(click, 'click 探针没有抓到故意违规的 canary').toHaveBeenCalledTimes(1);
      expect(seen, '事件探针没有抓到故意违规的 canary').toContain('click');
      click.mockClear();
      seen.length = 0;

      const input = document.createElement('input');
      document.body.appendChild(input);
      const removeMainBridge = installMainWorldBridge(document, { retryDelayMs: 1, hydrateTimeoutMs: 50 });
      Object.defineProperty(input, '__reactProps$zeroClick', {
        configurable: true,
        value: { onChange: () => undefined },
      });
      const plan = planFor(input);
      let result;
      try {
        result = await runApplyPlan({
          plan,
          auth: testAuthority(plan.fingerprint),
          journal: createUndoJournal(),
          root: createScanRoot(document.body, []),
          policy: testApplyPolicy(),
          startMainWorldBridge: beginMainWorldReactChange,
        });
      } finally {
        removeMainBridge();
      }

      expect(result!.filled).toBe(1);
      expect(click).not.toHaveBeenCalled();
      expect(seen).toEqual([]);
    } finally {
      for (const type of ['click', 'mousedown', 'mouseup', 'pointerdown', 'pointerup']) {
        document.removeEventListener(type, observe, true);
      }
    }
  });
});
