// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';

import { mountAutofillDock } from '../lib/autofillDock';

const handlers = { onAutofill: () => {}, onOpenEntry: () => {} };
const progress = (requiredCompleted: number, requiredQuestions: number) =>
  ({ runId: 'run-1', requiredCompleted, requiredQuestions, rows: [] } as const);

describe('autofill dock bottom sheet', () => {
  it('has no sheet at all until a run exists', () => {
    const doc = document.implementation.createHTMLDocument();
    const handle = mountAutofillDock({ kind: 'READY' }, handlers, doc);
    expect(handle.sheetState()).toBe('ABSENT');
    expect(handle.summaryText()).toBeNull();
  });
  it('reports what is still missing rather than what we did', () => {
    const doc = document.implementation.createHTMLDocument();
    const handle = mountAutofillDock({ kind: 'READY' }, handlers, doc, progress(5, 6));
    expect(handle.summaryText()).toBe('必填 5/6');
  });
  it('opens expanded when a run appears, and collapses and expands again on request', () => {
    const doc = document.implementation.createHTMLDocument();
    const handle = mountAutofillDock({ kind: 'READY' }, handlers, doc, progress(2, 6));
    expect(handle.sheetState()).toBe('AUTOFILL_EXPANDED');
    handle.toggleSheet();
    expect(handle.sheetState()).toBe('AUTOFILL_STICKY_COLLAPSED');
    handle.toggleSheet();
    expect(handle.sheetState()).toBe('AUTOFILL_EXPANDED');
  });
  it('never shows a percentage it cannot compute', () => {
    const doc = document.implementation.createHTMLDocument();
    const handle = mountAutofillDock({ kind: 'READY' }, handlers, doc, progress(0, 0));
    expect(handle.summaryText()).toBe('必填 0/0');
  });
  it('keeps the sheet out of a face that is only explaining itself', () => {
    const doc = document.implementation.createHTMLDocument();
    const handle = mountAutofillDock({ kind: 'GUIDANCE', guidance: 'SIGN_IN_FIRST' }, handlers, doc, progress(5, 6));
    expect(handle.sheetState()).toBe('ABSENT');
  });
});
