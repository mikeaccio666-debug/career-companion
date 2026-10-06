// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';

import { dockProgressFromRunEvent, dockRunSummary } from '../product-panel/runProgress';

describe('what a live run may tell the panel', () => {
  // The run's progress carries counts and nothing else — no labels, no values.
  // That is deliberate, so the panel says what it actually knows at each phase
  // instead of dressing an unknown up as a number.
  it('reports scanning without claiming a total it does not have yet', () => {
    const progress = dockProgressFromRunEvent('run-1', { phase: 'OBSERVED', observedControls: 23 });
    expect(progress).toEqual({
      runId: 'run-1', phase: 'SCANNING', observedControls: 23,
      requiredCompleted: 0, requiredQuestions: 0, rows: [],
    });
    expect(dockRunSummary(progress)).toBe('正在读表单 · 已看到 23 栏');
  });
  it('reports how many it is allowed to answer once composition settles', () => {
    const progress = dockProgressFromRunEvent('run-1',
      { phase: 'COMPOSED', observableQuestions: 11, authorizedQuestions: 8 });
    expect(progress).toMatchObject({ phase: 'COMPOSING', authorizedQuestions: 8, observableQuestions: 11 });
    expect(dockRunSummary(progress)).toBe('11 个问题里，我们可以答 8 个');
  });
  it('reports the finished counts, and only then a percentage', () => {
    const progress = dockProgressFromRunEvent('run-1',
      { phase: 'SETTLED', requiredCompleted: 5, requiredQuestions: 6 });
    expect(progress).toMatchObject({ phase: 'SETTLED', requiredCompleted: 5, requiredQuestions: 6 });
    expect(dockRunSummary(progress)).toBe('必填 5/6');
  });
  it('says nothing rather than something wrong when the run reports no questions', () => {
    const progress = dockProgressFromRunEvent('run-1',
      { phase: 'SETTLED', requiredCompleted: 0, requiredQuestions: 0 });
    expect(dockRunSummary(progress)).toBe('这个表单没有需要我们填的必填项');
  });
  it('refuses an event it cannot name', () => {
    expect(dockProgressFromRunEvent('run-1', { phase: 'WHATEVER' } as never)).toBeNull();
  });
});

describe('the sheet reads the phase, not just the counts', () => {
  it('uses the run wording while a run is in flight, and the plain line otherwise', async () => {
    const { mountAutofillDock } = await import('../lib/autofillDock');
    const doc = globalThis.document.implementation.createHTMLDocument();
    const handle = mountAutofillDock({ kind: 'READY' }, { onAutofill: () => {}, onOpenEntry: () => {} }, doc);
    handle.update(dockProgressFromRunEvent('run-1', { phase: 'OBSERVED', observedControls: 12 })!);
    expect(handle.summaryText()).toBe('正在读表单 · 已看到 12 栏');
    handle.update(dockProgressFromRunEvent('run-1', { phase: 'SETTLED', requiredCompleted: 5, requiredQuestions: 6 })!);
    expect(handle.summaryText()).toBe('必填 5/6');
  });
  it('still words a plain progress the plain way', async () => {
    const { mountAutofillDock } = await import('../lib/autofillDock');
    const doc = globalThis.document.implementation.createHTMLDocument();
    const handle = mountAutofillDock({ kind: 'READY' }, { onAutofill: () => {}, onOpenEntry: () => {} }, doc);
    handle.update({ runId: 'r', requiredCompleted: 1, requiredQuestions: 2, rows: [] });
    expect(handle.summaryText()).toBe('必填 1/2');
  });
});
