// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AuditRow, AuditView } from '@edaix/apply-kernel/audit';

import {
  mountAutofillDock,
  parseDockRunStep,
  type AutofillDockFieldRow,
  type AutofillDockHandlers,
  type AutofillDockProgress,
} from '../lib/autofillDock';

/**
 * AI 代答还在起草时，这一轮还没完（负责人 2026-09-24）。
 *
 * 他的原话：「ai 如果在启用的话，就代表正在填写，那个黑色的进度框应该还显示着，显示 ai 在填写，除非 ai 也写不出来」。
 * 从前规则那几遍一写完，浮层就换成「这一页填好了」、摆出「继续到下一页」，AI 的答案过几秒才默默填上——Workday
 * 第 2 页上他以为填完了去点继续，答案还在路上，网站没有翻页。
 *
 * 这份文件只测浮层这一层：`AI_DRAFTING` 这一步里，规则那几遍的终局单子（包括之后的复查）只换进度条，深色进度卡
 * 留着、写明 AI 在填；没有总结、没有「继续到下一页」与「提交」；收起按钮上也写着；「停止」照样在、交给调用方；
 * finishRun / reportBlocked 才收尾（收尾那一刻照旧读诊断码）；新的一轮、翻页都不带着它；worker 报来的步骤里没有它。
 * 什么时候说这一步、什么时候收尾，是内容脚本的事（gesture-ai-phase.test.ts）。
 *
 * 夹具全是合成文字。
 */

class TrustedClick extends MouseEvent { get isTrusted() { return true; } }

afterEach(() => {
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

const click = (node: Element | null | undefined) => node?.dispatchEvent(new TrustedClick('click', { bubbles: true, composed: true }));
const text = (node: Element | null | undefined) => (node?.textContent ?? '').replace(/\s+/g, ' ').trim();

const RUN = 'gesture-1';
const row = (label: string, state: AutofillDockFieldRow['state'], extra: Partial<AutofillDockFieldRow> = {}): AutofillDockFieldRow => ({
  label, required: true, done: state === 'CONFIRMED', state, ...extra,
});
/** 规则那几遍填完的样子：两栏填好了，两道开放题留给 AI。 */
const RULE_ROWS: readonly AutofillDockFieldRow[] = [
  row('First Name', 'CONFIRMED', { value: 'Sample' }),
  row('Email', 'CONFIRMED', { value: 'sample@example.test' }),
  row('Why do you want to work here?', 'MANUAL', { needsUser: true, reason: 'USER_ONLY' }),
  row('Tell us about a project', 'MANUAL', { needsUser: true, reason: 'LOW_CONFIDENCE' }),
];
/** AI 写上之后：那两道题成了 AI 代答的行。 */
const AI_ROWS: readonly AutofillDockFieldRow[] = [
  RULE_ROWS[0]!,
  RULE_ROWS[1]!,
  row('Why do you want to work here?', 'CONFIRMED', { value: 'I build payment tools.', aiAnswered: true }),
  row('Tell us about a project', 'CONFIRMED', { value: 'A ledger service.', aiAnswered: true }),
];
const streaming = (rows: readonly AutofillDockFieldRow[]): AutofillDockProgress => ({
  runId: RUN,
  requiredQuestions: rows.length,
  requiredCompleted: rows.filter((one) => one.done).length,
  rows: rows.map((one) => (one.state === 'MANUAL' ? one : { ...one, done: false, state: 'PENDING' as const })),
});
const settled = (rows: readonly AutofillDockFieldRow[], runId = RUN): AutofillDockProgress =>
  ({ runId, requiredQuestions: rows.length, requiredCompleted: rows.filter((one) => one.done).length, rows, phase: 'SETTLED' }) as never;

function auditRow(label: string): AuditRow {
  return {
    key: null, required: true, status: 'FILLED', reason: null, attemptedValue: null,
    resolvedOptionText: null, confidence: null, order: 0, element: document.createElement('input'), label,
  };
}
const auditView = (): AuditView => ({
  rows: [auditRow('First Name')], filled: 1, requiredTotal: 1, requiredHandled: 1,
  needsAttention: 0, blockedByUs: 0, awaitingUser: 0,
});

function mount(extra: Partial<AutofillDockHandlers> = {}) {
  const handle = mountAutofillDock({ kind: 'UNAVAILABLE', reason: 'NO_MISSION' }, {
    onAutofill: () => {},
    onOpenEntry: () => {},
    vendorLabel: 'Ashby',
    jobCard: () => ({ title: 'Mobile Engineer', company: 'Example Co' }),
    nextStep: { label: () => 'Save and Continue', advance: async () => 'ADVANCED' },
    submission: { available: () => true, send: async () => 'SUBMITTED' },
    ...extra,
  }, document);
  handle.openPanel();
  return handle;
}

/**
 * 内容脚本的次序：规则那几遍途中逐栏亮 → 送了题给 AI，先说 AI 在起草 → 再把终局单子与审计交给浮层。
 */
function toAiStep(handle: ReturnType<typeof mount>, count = 2, rows: readonly AutofillDockFieldRow[] = RULE_ROWS): void {
  handle.beginPreparing();
  handle.setStep('SCANNING');
  handle.setStep('PLANNING');
  handle.beginRun(streaming(rows));
  handle.setStep('FILLING');
  handle.setAiAnswers({ kind: 'DRAFTING', count });
  handle.setStep('AI_DRAFTING');
  handle.beginRun(settled(rows));
  handle.update(settled(rows));
  handle.showAudit!(auditView(), {});
}

const scene = (handle: ReturnType<typeof mount>) => handle.sceneRoot()!;
const tickerQ = (handle: ReturnType<typeof mount>) => text(scene(handle).querySelector('.ticker-q'));
const shown = (node: HTMLElement | null | undefined) => node !== null && node !== undefined && node.style.display !== 'none';

describe('AI 在起草：进度卡留着', () => {
  it('终局单子与审计都到了：深色进度卡照旧、写明 AI 在填；没有总结，也没有「继续到下一页」与「提交」', () => {
    const handle = mount();
    toAiStep(handle, 5);
    expect(handle.runState()).toBe('RUNNING');
    expect(handle.sheetFace()).toBe('WORKING');
    expect(scene(handle).querySelector('.hero')?.getAttribute('data-dark')).toBe('true');
    expect(scene(handle).querySelector('.act'), '进度卡').not.toBeNull();
    expect(tickerQ(handle)).toBe('AI 正在按你的资料填写 5 道题…');
    expect(handle.summaryText()).toBe('AI 正在按你的资料填写 5 道题…');
    // 进度条换成规则那几遍的结果；计数不写「4 / 4」——还没填完。
    expect(scene(handle).querySelectorAll('.seg')).toHaveLength(4);
    expect(text(scene(handle).querySelector('.act-count'))).toBe('');
    // 底下一行实时的数（2026-09-28）：已填 · AI 写的 · 需要你 · 按规定不代填。
    expect(text(scene(handle).querySelector('[data-tally="filled"]'))).toBe('已填 2');
    expect(scene(handle).querySelector('.sum'), '还没有总结').toBeNull();
    expect(handle.primaryButton(), '底栏还没出来').toBeNull();
    expect(handle.nextStepButton(), '「继续到下一页」还没出来').toBeNull();
    expect(shown(scene(handle).querySelector<HTMLElement>('.bar'))).toBe(false);
    expect(handle.reviewButtons()).toEqual({ edit: null, fill: null });
  });

  it('宿主回写的复查、AI 写上之后的单子：都只换行，不收尾；finishRun 之后才是总结，AI 那几栏单列', () => {
    const handle = mount();
    toAiStep(handle);
    handle.update(settled(RULE_ROWS));
    expect(handle.runState(), '迟到复查不收尾').toBe('RUNNING');
    handle.update(settled(AI_ROWS));
    handle.setAiAnswers({ kind: 'APPLIED', count: 2 });
    expect(handle.runState(), '要等调用方说收尾').toBe('RUNNING');
    handle.finishRun({ started: true, outcome: 'FILLED' });
    expect(handle.runState()).toBe('SETTLED');
    expect(text(scene(handle).querySelector('.sum-title'))).toBe('这一页填好了');
    expect(text(scene(handle).querySelector('.sum-sub'))).toContain('其中 AI 代答 2 项');
    expect(scene(handle).querySelectorAll('[data-ai-row]')).toHaveLength(2);
    expect(handle.nextStepButton()).not.toBeNull();
    expect(text(scene(handle)), 'AI 那一句跟着进度卡走了').not.toContain('AI 正在按你的资料');
  });

  it('回来晚了：收尾之后才摆「填入 AI 答案」', () => {
    const handle = mount();
    toAiStep(handle);
    handle.setAiAnswers({ kind: 'READY', count: 2, apply: async () => 2 });
    const offer = () => scene(handle).querySelector<HTMLElement>('[data-ai="offer"]');
    expect(shown(offer()), '还在进度卡上').toBe(false);
    handle.finishRun({ started: true, outcome: 'FILLED' });
    expect(shown(offer())).toBe(true);
    expect(text(offer())).toContain('AI 起草好了 2 道题的答案');
  });

  it('规则一项都没写成、AI 也没写出来：reportBlocked 收尾，照旧停在总结上；收尾那一刻才读诊断码', async () => {
    const recentDiagnostics = vi.fn(async () => ['EEO_ANSWERS_FETCH_FAILED']);
    const handle = mount({ recentDiagnostics });
    const gender = row('Gender', 'MANUAL', { needsUser: true, reason: 'MANUAL_ONLY', selfIdentification: true });
    toAiStep(handle, 2, [...RULE_ROWS.filter((one) => one.state === 'MANUAL'), gender]);
    expect(recentDiagnostics, '还没收尾').not.toHaveBeenCalled();
    handle.setAiAnswers({ kind: 'IDLE' });
    handle.reportBlocked('NOTHING_FILLED');
    expect(handle.runState()).toBe('SETTLED');
    expect(scene(handle).querySelector('.failed'), '行本身说明哪几项要他，不是失败卡').toBeNull();
    expect(text(scene(handle).querySelector('.sum-title'))).toBe('这一页还有 3 项需要你');
    expect(recentDiagnostics).toHaveBeenCalledTimes(1);
    await new Promise((resolve) => { setTimeout(resolve, 0); });
    // 2026-09-28：那句说明挂在它说的那一行上（自我认同那一栏），改说他能照着做的一句；总结下面不再另起一行。
    const genderRow = [...scene(handle).querySelectorAll('[data-need-row]')].find((node) => text(node.querySelector('.need-q')) === 'Gender');
    expect(text(genderRow?.querySelector('.need-why'))).toBe('暂时读不到你保存的答案，在这一栏选一下就好');
    expect(text(scene(handle).querySelector('.sum-notes'))).toBe('');
  });

  it('次数用完：收尾之后挂在要写的那几题上说一句', () => {
    const handle = mount();
    toAiStep(handle);
    handle.setAiAnswers({ kind: 'USED_UP' });
    handle.finishRun({ started: true, outcome: 'FILLED' });
    const why = [...scene(handle).querySelectorAll('[data-need-row]')].find((node) => text(node.querySelector('.need-q')) === 'Why do you want to work here?');
    expect(text(why?.querySelector('.need-why'))).toBe('这个月的 AI 次数用完了，自己写几句');
  });

  it('收起到右边：收起按钮上写着 AI 在填', () => {
    const handle = mount();
    toAiStep(handle);
    handle.closePanel();
    expect(text(handle.launcherButton())).toContain('AI 正在填写');
    expect(text(handle.launcherButton())).not.toContain('4/4');
  });

  it('AI 在起草的那几题还没有结论：不算进「需要你」；AI 没写上的，收尾后照实回到「需要你」', () => {
    // 2026-09-24 测试台 Ashby：进度卡写着「AI 正在按你的资料填写 6 道题…」，底下却列着同几题「需要你：开放题，要用你自己的话回答」。
    // 2026-09-28 起填写途中（AI 起草也算）「需要你」整组不摆——进度卡下面是填好的那一条列表；收尾之后它接过焦点。
    const why = document.createElement('textarea');
    const project = document.createElement('textarea');
    const gender = document.createElement('select');
    document.body.append(why, project, gender);
    const rows = [
      row('First Name', 'CONFIRMED', { value: 'Sample' }),
      row('Why do you want to work here?', 'MANUAL', { needsUser: true, reason: 'USER_ONLY', target: why }),
      row('Tell us about a project', 'MANUAL', { needsUser: true, reason: 'LOW_CONFIDENCE', target: project }),
      row('Gender', 'MANUAL', { needsUser: true, reason: 'MANUAL_ONLY', target: gender }),
    ];
    const handle = mount();
    handle.beginPreparing();
    handle.beginRun(streaming(rows));
    handle.setAiAnswers({ kind: 'DRAFTING', count: 2, targets: [why, project] });
    handle.setStep('AI_DRAFTING');
    handle.beginRun(settled(rows));
    handle.showAudit!(auditView(), {});
    const needs = () => [...scene(handle).querySelectorAll('[data-need-row] .need-q')].map((node) => node.textContent);
    expect(needs(), '还在填：「需要你」不摆').toEqual([]);
    expect(handle.attentionCount(), '只剩只能由你本人答的那一题').toBe(1);
    // AI 写上了一题、另一题没写上：收尾后那一题照实回到「需要你」。
    const written = row('Why do you want to work here?', 'CONFIRMED', { value: 'Because.', aiAnswered: true, target: why });
    handle.update(settled([rows[0]!, written, rows[2]!, rows[3]!]));
    handle.setAiAnswers({ kind: 'APPLIED', count: 1 });
    handle.finishRun({ started: true, outcome: 'FILLED' });
    expect(needs()).toEqual(['Tell us about a project', 'Gender']);
    expect(scene(handle).querySelectorAll('[data-ai-row]')).toHaveLength(1);
  });

  it('流上到了一批（2026-09-24）：题数减少；AI 看过没找到依据的那一栏当场回到「需要你」、写明原因，还在写的照旧不列', () => {
    const why = document.createElement('textarea');
    const project = document.createElement('textarea');
    const gender = document.createElement('select');
    document.body.append(why, project, gender);
    const rows = [
      row('First Name', 'CONFIRMED', { value: 'Sample' }),
      row('Why do you want to work here?', 'MANUAL', { needsUser: true, reason: 'USER_ONLY', target: why }),
      row('Tell us about a project', 'MANUAL', { needsUser: true, reason: 'LOW_CONFIDENCE', target: project }),
      row('Gender', 'MANUAL', { needsUser: true, reason: 'MANUAL_ONLY', target: gender }),
    ];
    const handle = mount();
    handle.beginPreparing();
    handle.beginRun(streaming(rows));
    handle.setAiAnswers({ kind: 'DRAFTING', count: 2, targets: [why, project] });
    handle.setStep('AI_DRAFTING');
    handle.beginRun(settled(rows));
    handle.showAudit!(auditView(), {});
    const needs = () => [...scene(handle).querySelectorAll('[data-need-row]')].map((node) => [
      node.querySelector('.need-q')?.textContent, node.querySelector('.need-why')?.textContent,
    ]);
    expect(handle.attentionCount()).toBe(1);
    // 选择题那一批到了：「Tell us about a project」AI 看过、没找到依据；「Why」还在写。没有写上的，单子不换。
    handle.setAiAnswers({ kind: 'DRAFTING', count: 1, targets: [why] });
    handle.setAiNoEvidence([project]);
    expect(tickerQ(handle)).toBe('AI 正在按你的资料填写 1 道题…');
    expect(handle.runState(), '流还开着').toBe('RUNNING');
    expect(handle.attentionCount(), 'AI 看过、没找到依据的那一栏当场算回「需要你」，还在写的照旧不算').toBe(2);
    expect(needs(), '还在填：「需要你」不摆').toEqual([]);
    // 收尾：列出来，写明原因。
    handle.setAiAnswers({ kind: 'APPLIED', count: 0 });
    handle.finishRun({ started: true, outcome: 'NEEDS_USER_INPUT' });
    const project_ = needs().find(([label]) => label === 'Tell us about a project');
    expect(project_?.[1], '开放题：说一句他能照着做的').toBe('AI 在你的资料里没找到依据，自己写几句');
  });

  it('起草题数还没交来：也照样写明 AI 在填', () => {
    const handle = mount();
    handle.beginPreparing();
    handle.beginRun(streaming(RULE_ROWS));
    handle.setStep('AI_DRAFTING');
    handle.beginRun(settled(RULE_ROWS));
    expect(handle.runState()).toBe('RUNNING');
    expect(tickerQ(handle)).toBe('AI 正在按你的资料填写…');
  });
});

describe('停止', () => {
  it('进度卡上的「停止」照样在：真点击交给调用方，浮层等调用方以「已停止」收尾', () => {
    const onStop = vi.fn();
    const handle = mount({ onStop });
    toAiStep(handle);
    const stop = scene(handle).querySelector<HTMLButtonElement>('[data-action="stop"]');
    expect(stop).not.toBeNull();
    stop?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(onStop, '页面派发的点击不算').not.toHaveBeenCalled();
    click(stop);
    expect(onStop).toHaveBeenCalledTimes(1);
    expect(handle.runState(), '单子已经在了，浮层不自己收掉').toBe('RUNNING');
    handle.setAiAnswers({ kind: 'IDLE' });
    handle.finishRun({ started: true, outcome: 'STOPPED' });
    expect(handle.runState()).toBe('STOPPED');
    expect(text(scene(handle).querySelector('.sum-title'))).toBe('填写已停止');
    expect(text(scene(handle).querySelector('.sum-sub'))).toBe('已填好 2 项，其余的请在网站上完成。');
  });
});

describe('这一轮作废：AI 那一步不带到下一轮', () => {
  it('用户在网站上翻了页：回到首页；下一轮的终局单子当场收尾', () => {
    const handle = mount();
    toAiStep(handle);
    handle.retireRun('PAGE_CHANGED');
    expect(handle.runState()).toBe('IDLE');
    handle.beginPreparing();
    handle.beginRun(settled(RULE_ROWS, 'gesture-2'));
    expect(handle.runState()).toBe('SETTLED');
    expect(scene(handle).querySelector('.ticker-q')).toBeNull();
  });

  it('AI 在起草时用户开了新的一轮：新的一轮从头来', () => {
    const onDismiss = vi.fn();
    const handle = mount();
    toAiStep(handle);
    handle.showAudit!(auditView(), { onDismiss });
    handle.beginPreparing();
    expect(onDismiss, '上一轮的审计收掉（调用方据此作废还没回来的 AI 答案）').toHaveBeenCalledTimes(1);
    handle.beginRun(settled(RULE_ROWS, 'gesture-2'));
    expect(handle.runState()).toBe('SETTLED');
  });
});

describe('这一步只由这一页自己的手势路说', () => {
  it('worker 报来的步骤里没有 AI_DRAFTING：进度卡不会被别人拖住', () => {
    expect(parseDockRunStep({ kind: 'dock/run-progress', step: 'AI_DRAFTING' })).toBeNull();
  });

  it('不在一轮里（首页、已经收尾）说这一步什么都不变', () => {
    const handle = mount();
    handle.setStep('AI_DRAFTING');
    expect(handle.runState()).toBe('IDLE');
    handle.beginPreparing();
    handle.beginRun(settled(RULE_ROWS));
    handle.setStep('AI_DRAFTING');
    expect(handle.runState()).toBe('SETTLED');
    expect(text(scene(handle).querySelector('.sum-title'))).toBe('这一页还有 2 项需要你');
  });
});
