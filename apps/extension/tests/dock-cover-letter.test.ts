// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';

import { mountAutofillDock, type AutofillDockFieldRow, type AutofillDockHandlers, type AutofillDockProgress } from '../lib/autofillDock';
import type { AuditView } from '@edaix/apply-kernel/audit';

/**
 * 浮层上的求职信（2026-09-27 负责人：申请表上有求职信栏就附上为这个岗位写的一封）。
 *
 * 表上认出的求职信栏，行按状态说话：还在写——画成「正在写」，不列进「需要你」；写好了但那一下点击过了 30 秒——
 * 摆一颗「附上求职信」，点它就是写入的凭证（只认真实点击）；附不了——行上照实说为什么（读不到岗位描述、次数用完……）。
 */
class TrustedClick extends MouseEvent { get isTrusted() { return true; } }
const click = (node: Element | null | undefined) => node?.dispatchEvent(new TrustedClick('click', { bubbles: true, composed: true }));
const text = (node: Element | null | undefined) => (node?.textContent ?? '').replace(/\s+/g, ' ').trim();

afterEach(() => {
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

const RUN = 'gesture-1';
const row = (label: string, state: AutofillDockFieldRow['state'], extra: Partial<AutofillDockFieldRow> = {}): AutofillDockFieldRow => ({
  label, required: true, done: state === 'CONFIRMED', state, ...extra,
});
const settled = (rows: readonly AutofillDockFieldRow[]): AutofillDockProgress =>
  ({ runId: RUN, requiredQuestions: rows.length, requiredCompleted: rows.filter((one) => one.done).length, rows, phase: 'SETTLED' }) as never;
const auditView = (): AuditView => ({
  rows: [], filled: 1, requiredTotal: 1, requiredHandled: 1, needsAttention: 0, blockedByUs: 0, awaitingUser: 0,
});

function run(extra: Partial<AutofillDockHandlers> = {}) {
  const letter = document.createElement('textarea');
  const gender = document.createElement('select');
  const rows = [
    row('First Name', 'CONFIRMED', { value: 'Sample' }),
    row('Cover Letter', 'MANUAL', { needsUser: true, reason: 'UNSUPPORTED_CONTROL', target: letter }),
    row('Gender', 'MANUAL', { needsUser: true, reason: 'MANUAL_ONLY', target: gender }),
  ];
  const handle = mountAutofillDock({ kind: 'UNAVAILABLE', reason: 'NO_MISSION' }, {
    onAutofill: () => {}, onOpenEntry: () => {}, vendorLabel: 'Greenhouse', ...extra,
  }, document);
  handle.openPanel();
  handle.beginPreparing();
  return { handle, rows, letter };
}
const scene = (handle: ReturnType<typeof run>['handle']) => handle.sceneRoot()!;
const needs = (handle: ReturnType<typeof run>['handle']) =>
  [...scene(handle).querySelectorAll('[data-need-row]')].map((node) => [text(node.querySelector('.need-q')), text(node.querySelector('.need-why'))]);
const offer = (handle: ReturnType<typeof run>['handle']) => scene(handle).querySelector<HTMLElement>('[data-letter="offer"]');

describe('求职信还在写', () => {
  it('那一栏画成「正在写」、不列进「需要你」；只能由本人答的照旧列', () => {
    const { handle, rows, letter } = run();
    handle.setCoverLetter({ kind: 'WRITING', targets: [letter] });
    handle.beginRun(settled(rows));
    handle.update(settled(rows));
    handle.showAudit!(auditView(), {});
    handle.finishRun({ started: true, outcome: 'FILLED' });
    expect(needs(handle).map(([q]) => q)).toEqual(['Gender']);
  });
});

describe('求职信附不了：行上照实说为什么', () => {
  it('读不到这个岗位的描述', () => {
    const { handle, rows, letter } = run();
    handle.beginRun(settled(rows));
    handle.setCoverLetter({ kind: 'REFUSED', code: 'NEEDS_PAGE_JOB', targets: [letter] });
    handle.update(settled(rows));
    handle.showAudit!(auditView(), {});
    handle.finishRun({ started: true, outcome: 'FILLED' });
    expect(needs(handle)).toContainEqual(['Cover Letter', '读不到这个岗位的描述，求职信要你自己附']);
  });

  it('这个月的次数用完了（英文界面）', () => {
    const { handle, rows, letter } = run({ locale: 'en' });
    handle.beginRun(settled(rows));
    handle.setCoverLetter({ kind: 'REFUSED', code: 'USAGE_EXHAUSTED', targets: [letter] });
    handle.update(settled(rows));
    handle.showAudit!(auditView(), {});
    handle.finishRun({ started: true, outcome: 'FILLED' });
    expect(needs(handle)).toContainEqual(['Cover Letter', 'You’ve used this month’s cover letters. Please add yours yourself']);
  });
});

describe('求职信写好了、但那一下点击过了 30 秒：「附上求职信」', () => {
  it('收尾之后摆出来；真实点击交给调用方（带着浮层自己的 shadow），附上了就收起、说一声', async () => {
    const { handle, rows, letter } = run();
    handle.beginRun(settled(rows));
    handle.update(settled(rows));
    handle.showAudit!(auditView(), {});
    handle.finishRun({ started: true, outcome: 'FILLED' });
    const apply = vi.fn(async (_event: MouseEvent, _shadow: ShadowRoot) => true);
    handle.setCoverLetter({ kind: 'READY', targets: [letter], apply });
    expect(offer(handle)?.style.display).toBe('grid');
    expect(text(offer(handle))).toContain('求职信写好了');
    expect(needs(handle)).toContainEqual(['Cover Letter', '求职信写好了，点上面的「附上求职信」']);
    click(scene(handle).querySelector('[data-action="letter-attach"]'));
    expect(apply).toHaveBeenCalledTimes(1);
    expect(apply.mock.calls[0]![1]).toBeInstanceOf(ShadowRoot);
    await Promise.resolve();
    await Promise.resolve();
    expect(offer(handle)?.style.display).toBe('none');
  });

  it('页面派发的点击不算', () => {
    const { handle, rows, letter } = run();
    handle.beginRun(settled(rows));
    handle.finishRun({ started: true, outcome: 'FILLED' });
    const apply = vi.fn(async () => true);
    handle.setCoverLetter({ kind: 'READY', targets: [letter], apply });
    scene(handle).querySelector('[data-action="letter-attach"]')?.dispatchEvent(new MouseEvent('click', { bubbles: true, composed: true }));
    expect(apply).not.toHaveBeenCalled();
  });
});
