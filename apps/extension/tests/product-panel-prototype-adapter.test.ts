import { describe, expect, it, vi } from 'vitest';

import { createProductPanelPrototypeAdapter } from '../product-panel/prototypeAdapter';

describe('Product Panel unpacked prototype adapter', () => {
  it('keeps the home model when the existing production boundary is not proved default-off', async () => {
    const adapter = createProductPanelPrototypeAdapter(async () => ({
      ok: false,
      code: 'PRODUCT_PANEL_INTENT_UNAVAILABLE',
    }));
    const listener = vi.fn();
    adapter.subscribe(listener);

    await expect(adapter.requestStartAutofill({ kind: 'START_AUTOFILL' })).resolves.toEqual({
      ok: false,
      code: 'PRODUCT_PANEL_INTENT_UNAVAILABLE',
    });
    expect(adapter.getSnapshot().run).toBeNull();
    expect(listener).not.toHaveBeenCalled();
  });

  it('rejects malformed or accessor-backed default-off confirmation results', async () => {
    const malformed = createProductPanelPrototypeAdapter(async () => ({
      ok: 'truthy-but-invalid',
      detail: 'private-boundary-detail',
    } as never));
    await expect(malformed.requestStartAutofill({ kind: 'START_AUTOFILL' })).resolves.toEqual({
      ok: false,
      code: 'PRODUCT_PANEL_INTENT_UNAVAILABLE',
    });
    expect(malformed.getSnapshot().run).toBeNull();

    const okGetter = vi.fn(() => true);
    const hostile = { code: 'private-boundary-detail' } as Record<string, unknown>;
    Object.defineProperty(hostile, 'ok', { enumerable: true, get: okGetter });
    const accessor = createProductPanelPrototypeAdapter(async () => hostile as never);
    await expect(accessor.requestStartAutofill({ kind: 'START_AUTOFILL' })).resolves.toEqual({
      ok: false,
      code: 'PRODUCT_PANEL_INTENT_UNAVAILABLE',
    });
    expect(accessor.getSnapshot().run).toBeNull();
    expect(okGetter).not.toHaveBeenCalled();
  });

  it('rejects Continue before a successful guarded Start', async () => {
    const confirm = vi.fn(async () => ({ ok: true }) as const);
    const adapter = createProductPanelPrototypeAdapter(confirm);
    const intent = {
      kind: 'CONTINUE_TO_NEXT_PAGE',
      runId: 'run-prototype-1',
      intentId: 'continue-prototype-1',
    } as const;

    await expect(adapter.requestContinue(intent)).resolves.toEqual({
      ok: false,
      code: 'CONTINUE_INTENT_REJECTED',
    });
    expect(confirm).not.toHaveBeenCalled();
    expect(adapter.getSnapshot().run).toBeNull();
  });

  it('allows only one pending Start boundary check', async () => {
    let resolveBoundary!: (result: { readonly ok: true }) => void;
    const boundary = new Promise<{ readonly ok: true }>((resolve) => { resolveBoundary = resolve; });
    const confirm = vi.fn(() => boundary);
    const adapter = createProductPanelPrototypeAdapter(confirm);

    const first = adapter.requestStartAutofill({ kind: 'START_AUTOFILL' });
    await expect(adapter.requestStartAutofill({ kind: 'START_AUTOFILL' })).resolves.toEqual({
      ok: false,
      code: 'PRODUCT_PANEL_INTENT_REJECTED',
    });
    expect(confirm).toHaveBeenCalledTimes(1);

    resolveBoundary({ ok: true });
    await expect(first).resolves.toEqual({ ok: true });
  });

  it('exposes all four value-free entry action seams', async () => {
    const adapter = createProductPanelPrototypeAdapter(async () => ({ ok: true }));
    for (const target of [
      'CURRENT_JOB',
      'AUTOFILL_INFORMATION',
      'RESUME',
      'COVER_LETTER',
    ] as const) {
      expect(await Promise.resolve(
        adapter.requestOpenEntry({ kind: 'OPEN_ENTRY', target }),
      )).toEqual({ ok: true });
    }
  });

  it('projects all prototype states only after default-off proof and advances one intent once', async () => {
    const confirm = vi.fn(async () => ({ ok: true }) as const);
    const adapter = createProductPanelPrototypeAdapter(confirm);
    const listener = vi.fn();
    adapter.subscribe(listener);

    await expect(adapter.requestStartAutofill({ kind: 'START_AUTOFILL' })).resolves.toEqual({
      ok: true,
    });
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(adapter.getSnapshot().run?.questions.map((question) => question.status)).toEqual([
      'PREFILLED',
      'FILLED',
      'AI_SUGGESTED',
      'USER_CONFIRMATION_REQUIRED',
      'MANUAL_REQUIRED',
      'POLICY_BLOCKED',
      'DISCOVERY_INCOMPLETE',
    ]);

    const intent = {
      kind: 'CONTINUE_TO_NEXT_PAGE',
      runId: 'run-ua5-1',
      intentId: 'continue-preview-1',
    } as const;
    await expect(adapter.requestContinue(intent)).resolves.toEqual({ ok: true });
    expect(adapter.getSnapshot().run?.continueIntent).toBeNull();
    await expect(adapter.requestContinue(intent)).resolves.toEqual({
      ok: false,
      code: 'CONTINUE_INTENT_REJECTED',
    });
    // One canonical terminal snapshot, then the consumed Continue is removed.
    expect(listener).toHaveBeenCalledTimes(2);
  });
});
