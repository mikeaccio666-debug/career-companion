import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ApplyPlan } from '../src/contracts';
import { fieldSignature } from '../src/fieldIdentity';
import { runApplyPlan } from '../src/runner';
import { createScanRoot } from '../src/scanRoot';
import { createUndoJournal } from '../src/undo';
import { beginMainWorldReactChange } from '../src/write/mainWorldBridge';
import { installMainWorldBridge } from '../src/write/mainWorldHandler';
import { testApplyPolicy, testAuthority } from './helpers/applyTestAuthority';

afterEach(() => {
  document.body.innerHTML = '';
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function planFor(input: HTMLInputElement, root = createScanRoot(document.body, [])): ApplyPlan {
  return {
    vendor: 'greenhouse',
    fingerprint: 'main-world-ladder',
    fillEmptyOnly: false,
    entries: [
      {
        kind: 'text',
        required: false,
        key: 'email',
        label: 'Email',
        value: 'new@example.test',
        element: input,
        order: 0, confidence: 1,
        signature: fieldSignature(input, root),
      },
    ],
    skipped: [],
  };
}

function startBridge(
  target: HTMLInputElement | HTMLTextAreaElement,
  authority: Parameters<typeof beginMainWorldReactChange>[1],
  ticket: Parameters<typeof beginMainWorldReactChange>[2],
) {
  return beginMainWorldReactChange(target, authority, ticket, { timeoutMs: 200 });
}

/** A host whose native input envelope alone renders its prior controlled state. */
function controlledInput(): { input: HTMLInputElement; state: () => string } {
  const input = document.createElement('input');
  document.body.appendChild(input);
  const descriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!;
  let rendered = 'old@example.test';
  descriptor.set!.call(input, rendered);
  input.addEventListener('input', () => {
    queueMicrotask(() => descriptor.set!.call(input, rendered));
  });
  Object.defineProperty(input, '__reactProps$phaseB', {
    configurable: true,
    value: {
      onChange(event: Event) {
        rendered = (event.target as HTMLInputElement).value;
      },
    },
  });
  return { input, state: () => rendered };
}

describe('L2 → L3 controlled-input fallback', () => {
  it('在 native setter 后由 MAIN onChange 固定受控状态，随后仍由 C6 判决并保留 Undo ticket', async () => {
    const remove = installMainWorldBridge(document, { retryDelayMs: 1, hydrateTimeoutMs: 50 });
    const { input, state } = controlledInput();
    const root = createScanRoot(document.body, []);
    const plan = planFor(input, root);
    const journal = createUndoJournal();
    const before = input.outerHTML;

    try {
      const summary = await runApplyPlan({
        plan,
        auth: testAuthority(plan.fingerprint),
        journal,
        root,
        policy: testApplyPolicy(),
        startMainWorldBridge: startBridge,
      });

      expect(summary).toMatchObject({ filled: 1, failed: 0 });
      expect(state()).toBe('new@example.test');
      expect(input.value).toBe('new@example.test');
      expect(journal.canUndo()).toBe(true);
      expect(input.outerHTML).toBe(before);
    } finally {
      remove();
    }
  });

  it('没有 MAIN handler 时不把 ACK 当成功，C6 仍报告 native rollback', async () => {
    const remove = installMainWorldBridge(document, { retryDelayMs: 1, hydrateTimeoutMs: 10 });
    const input = document.createElement('input');
    input.value = 'old@example.test';
    document.body.appendChild(input);
    input.addEventListener('input', () => queueMicrotask(() => {
      input.value = 'old@example.test';
    }));
    const root = createScanRoot(document.body, []);
    const plan = planFor(input, root);

    try {
      const summary = await runApplyPlan({
        plan,
        auth: testAuthority(plan.fingerprint),
        journal: createUndoJournal(),
        root,
        policy: testApplyPolicy(),
        startMainWorldBridge: startBridge,
      });

      expect(summary.results).toEqual([
        { key: 'email', label: 'Email', ok: false, reason: 'WRITE_REVERTED' },
      ]);
    } finally {
      remove();
    }
  });

  it('宿主开始提交时取消尚未 hydration 的 bridge，后到的 props 不得再执行', async () => {
    vi.useFakeTimers();
    const remove = installMainWorldBridge(document, { retryDelayMs: 10, hydrateTimeoutMs: 100 });
    const form = document.createElement('form');
    const input = document.createElement('input');
    form.appendChild(input);
    document.body.appendChild(form);
    const root = createScanRoot(form, []);
    const plan = planFor(input, root);
    const onChange = vi.fn();
    input.addEventListener('input', () => form.dispatchEvent(new Event('submit', { bubbles: true })));

    try {
      const pending = runApplyPlan({
        plan,
        auth: testAuthority(plan.fingerprint),
        journal: createUndoJournal(),
        root,
        policy: testApplyPolicy(),
        startMainWorldBridge: startBridge,
      });
      await expect(pending).resolves.toMatchObject({ abortedBy: 'HOST_SUBMITTED' });
      Object.defineProperty(input, '__reactProps$phaseB', { configurable: true, value: { onChange } });
      await vi.advanceTimersByTimeAsync(200);
      expect(onChange).not.toHaveBeenCalled();
    } finally {
      remove();
    }
  });
});
