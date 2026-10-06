// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest';

import {
  CONTROL_SELECTOR,
  createScanRoot,
  resolveScanRootMutationPolicy,
  sealScanRootMutationPolicy,
  type ScanRootMutationPolicy,
} from '@edaix/apply-kernel/scanRoot';

import {
  installScanMutationThrottle,
  type ScanMutationObserverCallback,
  type ScanMutationObserverFactory,
} from '../lib/scanMutationThrottle';

describe('authorized scan mutation throttle', () => {
  function harness() {
    let callback: ScanMutationObserverCallback | undefined;
    const observe = vi.fn();
    const disconnect = vi.fn();
    const observerFactory: ScanMutationObserverFactory = (next) => {
      callback = next;
      return { observe, disconnect };
    };
    const onInvalidate = vi.fn();
    const policy: ScanRootMutationPolicy = {
      targets: [document.documentElement, document.createDocumentFragment()],
      observerOptions: {
        attributes: true,
        characterData: true,
        childList: true,
        subtree: true,
      },
      isCurrent: () => true,
      isExecutionCurrent: () => true,
      isRelevant: vi.fn((records: readonly MutationRecord[]) => records.some((record) =>
        record.type === 'childList' || record.attributeName === 'data-testid')),
    };
    const handle = installScanMutationThrottle({
      policy,
      observerFactory,
      onInvalidate,
    });
    expect(handle).not.toBeNull();
    expect(callback).toBeTypeOf('function');
    return { callback: callback!, disconnect, handle: handle!, observe, onInvalidate, policy };
  }

  it('observes every kernel-verified target with the exact kernel-owned options', () => {
    const h = harness();

    expect(h.observe).toHaveBeenCalledTimes(2);
    expect(h.observe).toHaveBeenNthCalledWith(1, document.documentElement, {
      attributes: true,
      characterData: true,
      childList: true,
      subtree: true,
    });
    expect(h.observe.mock.calls[1]?.[0]).toBeInstanceOf(DocumentFragment);
    h.callback([{ type: 'attributes', attributeName: 'value' } as MutationRecord]);
    expect(h.onInvalidate).not.toHaveBeenCalled();
    expect(h.policy.isRelevant).toHaveBeenCalledTimes(1);
  });

  it('marks the scan dirty immediately and exactly once without starting a rescan', () => {
    const h = harness();

    h.callback([
      { type: 'childList', attributeName: null } as MutationRecord,
      { type: 'attributes', attributeName: 'aria-required' } as MutationRecord,
    ]);
    expect(h.onInvalidate).toHaveBeenCalledTimes(1);
    expect(h.disconnect).toHaveBeenCalledTimes(1);

    h.callback([{ type: 'childList', attributeName: null } as MutationRecord]);
    expect(h.onInvalidate).toHaveBeenCalledTimes(1);
  });

  it('dispose disconnects the observer and blocks future invalidation', () => {
    const h = harness();

    h.handle.dispose();
    h.callback([{ type: 'attributes', attributeName: 'id' } as MutationRecord]);

    expect(h.disconnect).toHaveBeenCalledTimes(1);
    expect(h.onInvalidate).not.toHaveBeenCalled();
  });

  it('fails closed when no verified mutation target exists or observer installation fails', () => {
    const onInvalidate = vi.fn();
    const emptyPolicy: ScanRootMutationPolicy = {
      targets: [],
      observerOptions: { attributes: true, childList: true, subtree: true },
      isCurrent: () => true,
      isExecutionCurrent: () => true,
      isRelevant: () => true,
    };
    expect(installScanMutationThrottle({ policy: emptyPolicy, onInvalidate })).toBeNull();
    expect(installScanMutationThrottle({
      policy: { ...emptyPolicy, targets: [document.documentElement] },
      onInvalidate,
      observerFactory: () => ({
        disconnect: vi.fn(),
        observe: () => {
          throw new Error('observer unavailable');
        },
      }),
    })).toBeNull();
    expect(onInvalidate).not.toHaveBeenCalled();
  });

  it('ignores audit UI and combobox option churn, then invalidates a new control in a verified shadow root', async () => {
    document.body.innerHTML = '<form id="application"><x-fields></x-fields></form>';
    const form = document.querySelector('#application')!;
    const shadow = document.querySelector('x-fields')!.attachShadow({ mode: 'open' });
    shadow.innerHTML = '<input id="baseline" />';
    const root = createScanRoot(form, []);
    root.querySelectorAll(CONTROL_SELECTOR);
    expect(sealScanRootMutationPolicy(root)).not.toBeNull();
    const policy = resolveScanRootMutationPolicy(root);
    expect(policy?.targets).toEqual([form, shadow]);
    const onInvalidate = vi.fn();
    const handle = installScanMutationThrottle({
      policy: policy!,
      onInvalidate,
    });
    expect(handle).not.toBeNull();

    // auditPanel.ts attaches its own host below documentElement, outside the
    // backend-rule-proven application root. That must not dirty the scan.
    document.documentElement.append(document.createElement('edaix-apply-audit'));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(onInvalidate).not.toHaveBeenCalled();

    const option = document.createElement('div');
    option.setAttribute('role', 'option');
    shadow.append(option);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(onInvalidate).not.toHaveBeenCalled();

    shadow.append(document.createElement('input'));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(onInvalidate).toHaveBeenCalledTimes(1);
  });
});
