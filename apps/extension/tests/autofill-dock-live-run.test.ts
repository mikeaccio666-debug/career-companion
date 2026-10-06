// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';

import { mountAutofillDock, type AutofillDockProgress } from '../lib/autofillDock';

/**
 * A run claims the sheet; refreshes only refresh it.
 *
 * `update` deliberately refuses a progress from another run, so that two
 * applications' counts can never land on one sheet. Live progress turns that
 * guard into a trap: the first fill of a tab claims the sheet forever, and the
 * second Autofill click — the one the user makes precisely because the first run
 * left rows unfinished — would tick a sheet that stopped being about their run.
 *
 * So starting a run is its own event. `beginRun` adopts the new run's rows and
 * replaces whatever the sheet was showing; `update` keeps refusing anything that
 * is not the run currently on screen, including the run that just lost it.
 */

const handlers = { onAutofill: () => {}, onOpenEntry: () => {} };
const run = (runId: string, label: string, done: boolean): AutofillDockProgress => ({
  runId,
  requiredCompleted: done ? 1 : 0,
  requiredQuestions: 1,
  rows: [{ label, required: true, done }],
});
const labels = (handle: ReturnType<typeof mountAutofillDock>) =>
  handle.fieldRows('required').map((row) => row.label);

describe('autofill dock live run', () => {
  it('grows the sheet for a run that has only just started', () => {
    const doc = document.implementation.createHTMLDocument();
    const handle = mountAutofillDock({ kind: 'READY' }, handlers, doc);
    handle.beginRun(run('fill-1', 'Full name', false));
    expect(handle.sheetState()).toBe('AUTOFILL_EXPANDED');
    expect(handle.summaryText()).toBe('必填 0/1');
    expect(labels(handle)).toEqual(['Full name']);
  });

  it('a second run replaces the sheet instead of being refused by the first', () => {
    const doc = document.implementation.createHTMLDocument();
    const handle = mountAutofillDock({ kind: 'READY' }, handlers, doc);
    handle.beginRun(run('fill-1', 'Full name', false));
    handle.update(run('fill-1', 'Full name', true));
    handle.beginRun(run('fill-2', 'Email', false));
    expect(labels(handle), 'the second Autofill click still shows the first run').toEqual(['Email']);
    expect(handle.summaryText()).toBe('必填 0/1');
  });

  it('the run that lost the sheet cannot tick it afterwards', () => {
    const doc = document.implementation.createHTMLDocument();
    const handle = mountAutofillDock({ kind: 'READY' }, handlers, doc);
    handle.beginRun(run('fill-1', 'Full name', false));
    handle.beginRun(run('fill-2', 'Email', false));
    handle.update(run('fill-1', 'Full name', true));
    expect(labels(handle)).toEqual(['Email']);
    expect(handle.summaryText()).toBe('必填 0/1');
  });

  it('a face that only explains itself has no run to report', () => {
    const doc = document.implementation.createHTMLDocument();
    const handle = mountAutofillDock({ kind: 'GUIDANCE', guidance: 'SIGN_IN_FIRST' }, handlers, doc);
    handle.beginRun(run('fill-1', 'Full name', false));
    expect(handle.sheetState()).toBe('ABSENT');
  });
});
