// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest';
import type { AuditRow, AuditView } from '@edaix/apply-kernel/audit';

import { mountAutofillDock } from '../lib/autofillDock';

/**
 * The audit's controls, folded into the dock.
 *
 * After a fill the standalone audit panel used to stand beside the dock, a
 * second dark box on the same corner of the page. The run scene now takes the
 * audit: the rows it already shows, plus undo, the final review and the open
 * questions under them. What it must not change is the discipline those
 * controls carry — a real click in our own shadow, handed over as is.
 */
const handlers = { onAutofill: () => {}, onOpenEntry: () => {} };
class TrustedClick extends MouseEvent { get isTrusted() { return true; } }

function row(overrides: Partial<AuditRow> & { label: string }): AuditRow {
  return {
    key: null, required: true, status: 'FILLED', reason: null, attemptedValue: null,
    resolvedOptionText: null, confidence: null, order: 0, element: document.createElement('input'),
    ...overrides,
  };
}
function view(rows: AuditRow[]): AuditView {
  return { rows, filled: rows.filter((r) => r.status === 'FILLED').length, requiredTotal: rows.length,
    requiredHandled: rows.filter((r) => r.status === 'FILLED').length, needsAttention: 0, blockedByUs: 0, awaitingUser: 0 };
}

describe('the audit on the dock', () => {
  it('is offered by a real dock and not by the no-op one', () => {
    const doc = document.implementation.createHTMLDocument();
    expect(mountAutofillDock({ kind: 'HIDDEN' }, handlers, doc).showAudit).toBeUndefined();
    expect(mountAutofillDock({ kind: 'READY' }, handlers, doc).showAudit).toBeTypeOf('function');
  });
  it('hands back its own shadow root, and the undo click arrives with that same root', () => {
    const doc = document.implementation.createHTMLDocument();
    const handle = mountAutofillDock({ kind: 'READY' }, handlers, doc);
    const undoAll = vi.fn();
    const panel = handle.showAudit!(view([row({ label: 'Name' })]), { canUndo: () => true, undoAll });
    expect(panel.shadowRoot).toBeInstanceOf(ShadowRoot);
    const undo = handle.sceneRoot()?.querySelector<HTMLButtonElement>('[data-undo]');
    expect(undo).not.toBeNull();
    undo?.dispatchEvent(new TrustedClick('click', { bubbles: true }));
    expect(undoAll).toHaveBeenCalledTimes(1);
    expect(undoAll.mock.calls[0]?.[1]).toBe(panel.shadowRoot);
  });
  it('offers no undo when there is nothing to undo', () => {
    const doc = document.implementation.createHTMLDocument();
    const handle = mountAutofillDock({ kind: 'READY' }, handlers, doc);
    handle.showAudit!(view([row({ label: 'Name' })]), { canUndo: () => false, undoAll: () => {} });
    expect(handle.sceneRoot()?.querySelector('[data-undo]')).toBeNull();
  });
  it('takes the final review from the 提交 click itself: the same real click, the same root', async () => {
    // 2026-09-23 新浮层没有单独的「我已逐项复核」：用户在浮层里按「提交」就是复核（负责人：插件替用户点提交）。
    const doc = document.implementation.createHTMLDocument();
    const handle = mountAutofillDock({ kind: 'READY' }, handlers, doc);
    const confirmFinalReview = vi.fn(async (_event: Event, _root: ShadowRoot) => true);
    const panel = handle.showAudit!(view([row({ label: 'Name' })]), { canConfirmFinalReview: () => true, confirmFinalReview });
    const submit = handle.primaryButton();
    expect(submit?.dataset.action).toBe('submit');
    submit?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(confirmFinalReview, '页面派发的点击不算复核').not.toHaveBeenCalled();
    submit?.dispatchEvent(new TrustedClick('click', { bubbles: true }));
    expect(confirmFinalReview).toHaveBeenCalledTimes(1);
    expect(confirmFinalReview.mock.calls[0]?.[1]).toBe(panel.shadowRoot);
  });
  it('settles the run and lists the rows it was handed', () => {
    const doc = document.implementation.createHTMLDocument();
    const handle = mountAutofillDock({ kind: 'READY' }, handlers, doc);
    handle.beginPreparing();
    handle.showAudit!(view([row({ label: 'Name' }), row({ label: 'Referral', status: 'NEEDS_MANUAL' })]), {});
    expect(handle.runState()).toBe('SETTLED');
    expect(handle.sheetFace()).toBe('COMPLETE');
  });
  it('lets go on dismiss: the caller is told, and the controls leave the scene', () => {
    const doc = document.implementation.createHTMLDocument();
    const handle = mountAutofillDock({ kind: 'READY' }, handlers, doc);
    const onDismiss = vi.fn();
    const panel = handle.showAudit!(view([row({ label: 'Name' })]), { canUndo: () => true, undoAll: () => {}, onDismiss });
    expect(handle.sceneRoot()?.querySelector('[data-undo]')).not.toBeNull();
    panel.dismiss();
    panel.dismiss();
    expect(onDismiss).toHaveBeenCalledTimes(1);
    expect(handle.sceneRoot()?.querySelector('[data-undo]'), '收掉之后「撤销」也跟着走').toBeNull();
  });
  it('takes nothing when there is nothing to show', () => {
    const doc = document.implementation.createHTMLDocument();
    const handle = mountAutofillDock({ kind: 'READY' }, handlers, doc);
    const panel = handle.showAudit!(view([]), { canUndo: () => true, undoAll: () => {} });
    expect(panel.shadowRoot).toBeNull();
    expect(handle.sheetState()).toBe('ABSENT');
  });
  it('does not grow a question panel of its own: open questions stay in the needs list', () => {
    // 2026-09-23 新浮层不摆「补答」区（设计里没有）；没填的题照样在「需要你」里、逐项处理时一题一题走。
    const doc = document.implementation.createHTMLDocument();
    const handle = mountAutofillDock({ kind: 'READY' }, handlers, doc);
    handle.showAudit!(view([row({ label: 'Name' })]), { questions: { questions: [] } });
    expect(handle.sceneRoot()?.textContent).not.toContain('还有 1 题没填');
  });
});
