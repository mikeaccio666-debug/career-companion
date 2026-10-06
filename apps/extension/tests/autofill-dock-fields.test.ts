// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';

import { mountAutofillDock, type AutofillDockProgress } from '../lib/autofillDock';

const handlers = { onAutofill: () => {}, onOpenEntry: () => {} };
const row = (label: string, required: boolean, done: boolean) => ({ label, required, done });
const progress = (over: Partial<AutofillDockProgress> = {}): AutofillDockProgress => ({
  runId: 'run-1', requiredCompleted: 1, requiredQuestions: 2,
  rows: [row('Full name', true, true), row('Email', true, false), row('LinkedIn URL', false, false)],
  ...over,
});
const texts = (handle: ReturnType<typeof mountAutofillDock>, group: 'required' | 'optional') =>
  handle.fieldRows(group).map((r) => r.label);

describe('autofill dock sheet arrives with the run', () => {
  // The dock is mounted when the page loads, long before any run exists, so a
  // sheet that could only be created at mount time could never appear at all.
  it('grows a sheet when the first progress arrives, and keeps the run it belongs to', () => {
    const doc = document.implementation.createHTMLDocument();
    const handle = mountAutofillDock({ kind: 'READY' }, handlers, doc);
    expect(handle.sheetState()).toBe('ABSENT');
    handle.update(progress());
    expect(handle.sheetState()).toBe('AUTOFILL_EXPANDED');
    expect(handle.summaryText()).toBe('必填 1/2');
    expect(texts(handle, 'required')).toEqual(['Full name', 'Email']);
  });
  it('still refuses a second run after the sheet exists', () => {
    const doc = document.implementation.createHTMLDocument();
    const handle = mountAutofillDock({ kind: 'READY' }, handlers, doc);
    handle.update(progress());
    handle.update(progress({ runId: 'run-2', requiredCompleted: 9, rows: [] }));
    expect(handle.summaryText()).toBe('必填 1/2');
  });
  it('never grows a sheet on a face that is only explaining itself', () => {
    const doc = document.implementation.createHTMLDocument();
    const handle = mountAutofillDock({ kind: 'GUIDANCE', guidance: 'SIGN_IN_FIRST' }, handlers, doc);
    handle.update(progress());
    expect(handle.sheetState()).toBe('ABSENT');
  });
});

describe('autofill dock field rows', () => {
  it('splits the sheet into what the form demands and what it merely accepts', () => {
    const doc = document.implementation.createHTMLDocument();
    const handle = mountAutofillDock({ kind: 'READY' }, handlers, doc, progress());
    expect(texts(handle, 'required')).toEqual(['Full name', 'Email']);
    expect(texts(handle, 'optional')).toEqual(['LinkedIn URL']);
  });
  it('keeps a field the run did not complete visibly unfinished', () => {
    const doc = document.implementation.createHTMLDocument();
    const handle = mountAutofillDock({ kind: 'READY' }, handlers, doc, progress());
    expect(handle.fieldRows('required').map((r) => r.done)).toEqual([true, false]);
  });
  it('updates in place without losing where the user put the sheet', () => {
    const doc = document.implementation.createHTMLDocument();
    const handle = mountAutofillDock({ kind: 'READY' }, handlers, doc, progress());
    handle.toggleSheet();
    expect(handle.sheetState()).toBe('AUTOFILL_STICKY_COLLAPSED');
    handle.update(progress({ requiredCompleted: 2, rows: [row('Full name', true, true), row('Email', true, true)] }));
    expect(handle.sheetState()).toBe('AUTOFILL_STICKY_COLLAPSED');
    expect(handle.summaryText()).toBe('必填 2/2');
    expect(texts(handle, 'required')).toEqual(['Full name', 'Email']);
  });
  it('refuses an update for a different run rather than mixing two runs on one sheet', () => {
    const doc = document.implementation.createHTMLDocument();
    const handle = mountAutofillDock({ kind: 'READY' }, handlers, doc, progress());
    handle.update(progress({ runId: 'run-2', requiredCompleted: 9, rows: [] }));
    expect(handle.summaryText()).toBe('必填 1/2');
  });
});
