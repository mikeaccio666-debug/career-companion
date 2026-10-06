// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';

import { mountAutofillDock, type AutofillDockProgress } from '../lib/autofillDock';

class TrustedClick extends MouseEvent { get isTrusted() { return true; } }

const noop = { onAutofill: () => {}, onOpenEntry: () => {} };
const review = (): AutofillDockProgress => ({
  runId: 'run-1',
  requiredCompleted: 2,
  requiredQuestions: 3,
  rows: [
    { label: '姓名', required: true, done: true, value: 'Ke Chen' },
    { label: '邮箱', required: true, done: true, value: 'ke.chen@example.com' },
    { label: '你是怎么知道这个职位的？', required: true, done: false, needsUser: true },
    { label: '个人网站', required: false, done: false },
  ],
});

describe('the review sheet', () => {
  it('separates a field we could not fill from one only the user may answer', () => {
    // Both are "not done", and treating them the same sends the user hunting
    // through a form for something we were never allowed to answer for them.
    const doc = document.implementation.createHTMLDocument();
    const handle = mountAutofillDock({ kind: 'READY' }, noop, doc);
    handle.update(review());
    expect(handle.attentionCount()).toBe(1);
    expect(handle.fieldRows('required').map((r) => r.needsUser === true))
      .toEqual([false, false, true]);
  });
  it('shows back what it is about to write, so review is possible before the fill', () => {
    const doc = document.implementation.createHTMLDocument();
    const handle = mountAutofillDock({ kind: 'READY' }, noop, doc);
    handle.update(review());
    expect(handle.rowValues('required')).toEqual(['Ke Chen', 'ke.chen@example.com', null]);
  });
  it('offers the two ways on once the run has settled, and only on a real click', () => {
    // While fields are still settling there is nothing to press: a second fill
    // on top of a running one is a race, and the profile is one scene away
    // anyway. Once the worker has had its last word the footer offers both.
    const seen: string[] = [];
    const doc = document.implementation.createHTMLDocument();
    const handle = mountAutofillDock(
      { kind: 'READY' },
      { onAutofill: () => seen.push('FILL'), onOpenEntry: (t) => seen.push(`OPEN:${t}`) },
      doc,
    );
    handle.update(review());
    expect(handle.reviewButtons(), 'nothing to press while the run is still going').toEqual({ edit: null, fill: null });
    handle.finishRun({ started: true, outcome: 'FILLED' });
    const { edit, fill } = handle.reviewButtons();
    expect(edit).not.toBeNull();
    expect(fill).not.toBeNull();
    fill?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(seen, 'a page-dispatched click starts no fill').toEqual([]);
    edit?.dispatchEvent(new TrustedClick('click', { bubbles: true }));
    expect(handle.scene(), 'editing the profile opens the profile scene').toBe('PROFILE');
    handle.backHome();
    handle.reviewButtons().fill?.dispatchEvent(new TrustedClick('click', { bubbles: true }));
    expect(seen).toEqual(['OPEN:AUTOFILL_INFORMATION', 'FILL']);
    expect(handle.runState(), 'running it again starts by checking the page').toBe('PREPARING');
  });
  it('counts nothing for attention when every required field is settled', () => {
    const doc = document.implementation.createHTMLDocument();
    const handle = mountAutofillDock({ kind: 'READY' }, noop, doc);
    handle.update({ runId: 'r', requiredCompleted: 1, requiredQuestions: 1,
      rows: [{ label: '姓名', required: true, done: true, value: 'Ke Chen' }] });
    expect(handle.attentionCount()).toBe(0);
  });
});
