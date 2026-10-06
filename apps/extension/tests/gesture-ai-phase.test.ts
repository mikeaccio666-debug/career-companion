// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AuditView } from '@edaix/apply-kernel/audit';

import type { KernelAiAnswersOutcome } from '../lib/aiAnswers';
import { mountAutofillDock, type AutofillDockFieldRow, type AutofillDockProgress } from '../lib/autofillDock';
import { closeGestureRun, type GestureRunDock } from '../lib/gestureRunClose';

/**
 * 手势填写一轮怎么收尾：AI 代答还在起草，这一轮就还没完（负责人 2026-09-24）。
 *
 * 负责人在 Workday 第 2 页看到：规则那几遍一写完，浮层就是「这一页填好了」与「继续到下一页」，AI 的 5 个答案过几秒
 * 才默默填上；他以为填完了去点继续，网站没有翻页。他的话：「ai 如果在启用的话，就代表正在填写，那个黑色的进度框
 * 应该还显示着，显示 ai 在填写，除非 ai 也写不出来」。
 *
 * 前半是行为：真浮层照内容脚本的次序走一轮，AI 的结局由测试决定——起草时不收尾；写上了是「填好了」；
 * 回来晚了、没写出来、被拒、次数用完都与没有 AI 时一样收尾；按「停止」不再等；这一轮作废就什么都不做。
 * 后半是接线（源码形状闸）：内容脚本在把终局单子交给浮层之前说 AI_DRAFTING，收尾只经 closeGestureRun，
 * 交的是这一轮自己的「停止」与轮次判断。
 *
 * 夹具全是合成文字。
 */

class TrustedClick extends MouseEvent { get isTrusted() { return true; } }

afterEach(() => {
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

const text = (node: Element | null | undefined) => (node?.textContent ?? '').replace(/\s+/g, ' ').trim();
const flush = () => new Promise<void>((resolve) => { setTimeout(resolve, 0); });

function deferred<T>() {
  let settle: (value: T) => void = () => {};
  const promise = new Promise<T>((resolve) => { settle = resolve; });
  return { promise, resolve: (value: T) => settle(value) };
}

const RUN = 'gesture-7';
const row = (label: string, state: AutofillDockFieldRow['state'], extra: Partial<AutofillDockFieldRow> = {}): AutofillDockFieldRow => ({
  label, required: true, done: state === 'CONFIRMED', state, ...extra,
});
const settled = (rows: readonly AutofillDockFieldRow[]): AutofillDockProgress =>
  ({ runId: RUN, requiredQuestions: rows.length, requiredCompleted: rows.filter((one) => one.done).length, rows, phase: 'SETTLED' }) as never;
const RULES_FILLED: readonly AutofillDockFieldRow[] = [
  row('First Name', 'CONFIRMED', { value: 'Sample' }),
  row('Why do you want to work here?', 'MANUAL', { needsUser: true, reason: 'USER_ONLY' }),
];
const RULES_NOTHING: readonly AutofillDockFieldRow[] = [
  row('Why do you want to work here?', 'MANUAL', { needsUser: true, reason: 'USER_ONLY' }),
];
const withAi = (rows: readonly AutofillDockFieldRow[]): AutofillDockFieldRow[] => rows.map((one) =>
  (one.state === 'MANUAL' ? row(one.label, 'CONFIRMED', { value: 'A drafted answer.', aiAnswered: true }) : one));
const VIEW = { rows: [], filled: 0, requiredTotal: 0, requiredHandled: 0, needsAttention: 0 } as unknown as AuditView;

function mountDock(onStop?: () => void) {
  const handle = mountAutofillDock({ kind: 'UNAVAILABLE', reason: 'NO_MISSION' }, {
    onAutofill: () => {},
    onOpenEntry: () => {},
    nextStep: { label: () => 'Save and Continue', advance: async () => 'ADVANCED' },
    ...(onStop === undefined ? {} : { onStop }),
  }, document);
  handle.openPanel();
  return handle;
}

/**
 * 内容脚本在 fillFromGesture 之后的次序，原样照搬：送了题给 AI 就先说 AI 在起草，再交终局单子，然后经 closeGestureRun 收尾。
 * AI 的结局到了由 `draw` 画上去（内容脚本里是换单子、摆「填入 AI 答案」、说次数用完）。
 */
function run(input: {
  rows: readonly AutofillDockFieldRow[];
  filled: number;
  ai?: Promise<KernelAiAnswersOutcome>;
  stop?: AbortController;
  current?: () => boolean;
  onStop?: () => void;
}) {
  const handle = mountDock(input.onStop);
  const stop = input.stop ?? new AbortController();
  handle.beginPreparing();
  if (input.ai !== undefined) {
    handle.setAiAnswers({ kind: 'DRAFTING', count: 1 });
    handle.setStep('AI_DRAFTING');
  }
  handle.beginRun(settled(input.rows));
  handle.update(settled(input.rows));
  const draw = vi.fn((outcome: KernelAiAnswersOutcome) => {
    if (outcome.kind === 'APPLIED') {
      handle.update(settled(withAi(input.rows)));
      handle.setAiAnswers({ kind: 'APPLIED', count: outcome.written });
    } else if (outcome.kind === 'READY') {
      handle.setAiAnswers({ kind: 'READY', count: outcome.count, apply: async () => 0 });
    } else {
      handle.setAiAnswers(outcome.kind === 'REFUSED' && outcome.code === 'QUOTA_EXCEEDED' ? { kind: 'USED_UP' } : { kind: 'IDLE' });
    }
  });
  const closing = closeGestureRun({
    dock: () => handle,
    filled: input.filled,
    ...(input.ai === undefined ? {} : { ai: { outcome: input.ai } }),
    stop: stop.signal,
    current: input.current ?? (() => true),
    onAiOutcome: draw,
  });
  return { handle, closing, draw, stop };
}

const APPLIED: KernelAiAnswersOutcome = { kind: 'APPLIED', view: VIEW, written: 1, noEvidence: [], unanswered: [] };
const NONE: KernelAiAnswersOutcome = { kind: 'NONE', noEvidence: [], unanswered: [] };

describe('AI 在起草时这一轮不收尾', () => {
  it('规则填了、AI 还没回来：进度卡写着 AI 在填，没有「继续到下一页」；AI 写上了才是「这一页填好了」', async () => {
    const ai = deferred<KernelAiAnswersOutcome>();
    const { handle, closing, draw } = run({ rows: RULES_FILLED, filled: 1, ai: ai.promise });
    await flush();
    expect(handle.runState()).toBe('RUNNING');
    expect(text(handle.sceneRoot()?.querySelector('.ticker-q'))).toBe('AI 正在按你的资料填写 1 道题…');
    expect(handle.nextStepButton()).toBeNull();
    expect(draw).not.toHaveBeenCalled();
    ai.resolve(APPLIED);
    await closing;
    expect(draw).toHaveBeenCalledWith(APPLIED);
    expect(handle.runState()).toBe('SETTLED');
    expect(text(handle.sceneRoot()?.querySelector('.sum-title'))).toBe('这一页填好了');
    expect(handle.sceneRoot()?.querySelectorAll('[data-ai-row]')).toHaveLength(1);
    expect(handle.nextStepButton()).not.toBeNull();
  });

  it('AI 没写出来：与没有 AI 时一样收尾——规则填了就是填好了，要他答的照旧列着', async () => {
    const ai = deferred<KernelAiAnswersOutcome>();
    const { handle, closing } = run({ rows: RULES_FILLED, filled: 1, ai: ai.promise });
    await flush();
    expect(handle.runState()).toBe('RUNNING');
    ai.resolve(NONE);
    await closing;
    expect(handle.runState()).toBe('SETTLED');
    expect(text(handle.sceneRoot()?.querySelector('.sum-title'))).toBe('这一页还有 1 项需要你');
  });

  it('回来晚了：收尾，摆「填入 AI 答案」', async () => {
    const { handle, closing } = run({
      rows: RULES_FILLED, filled: 1,
      ai: Promise.resolve({ kind: 'READY', count: 1, written: 0, apply: async () => ({ ok: false, code: 'GESTURE_EXPIRED' }), noEvidence: [], unanswered: [] } as never),
    });
    await closing;
    expect(handle.runState()).toBe('SETTLED');
    const offer = handle.sceneRoot()?.querySelector<HTMLElement>('[data-ai="offer"]');
    expect(offer?.style.display).toBe('grid');
  });

  it('次数用完：收尾，要写的那一题照实说一句（2026-09-28 起挂在那一行上）', async () => {
    const { handle, closing } = run({ rows: RULES_FILLED, filled: 1, ai: Promise.resolve({ kind: 'REFUSED', code: 'QUOTA_EXCEEDED' }) });
    await closing;
    expect(handle.runState()).toBe('SETTLED');
    expect(text(handle.sceneRoot()?.querySelector('[data-need-row] .need-why'))).toBe('这个月的 AI 次数用完了，自己写几句');
  });
});

describe('规则一项都没写成', () => {
  const spyDock = (): GestureRunDock & { calls: string[] } => {
    const calls: string[] = [];
    return {
      calls,
      setAiAnswers: (state) => { calls.push(`ai:${state.kind}`); },
      finishRun: (outcome) => { calls.push(`finish:${outcome.started ? outcome.outcome : outcome.code}`); },
      reportBlocked: (code) => { calls.push(`blocked:${code}`); },
    };
  };

  it('AI 在起草：不先报「没有能填的」；AI 写上了就是「填好了」', async () => {
    const dock = spyDock();
    const ai = deferred<KernelAiAnswersOutcome>();
    const closing = closeGestureRun({
      dock: () => dock, filled: 0, refused: 'CHOICE_NO_DATA', ai: { outcome: ai.promise },
      stop: new AbortController().signal, current: () => true,
    });
    await flush();
    expect(dock.calls).toEqual([]);
    ai.resolve(APPLIED);
    await closing;
    expect(dock.calls).toEqual(['finish:FILLED']);
  });

  it('AI 也没写出来：照旧报那一条真实的拒绝理由；没有理由就是「没有能填的」', async () => {
    for (const [refused, expected] of [['CHOICE_NO_DATA', 'blocked:CHOICE_NO_DATA'], [undefined, 'blocked:NOTHING_FILLED']] as const) {
      const dock = spyDock();
      await closeGestureRun({
        dock: () => dock, filled: 0, refused, ai: { outcome: Promise.resolve(NONE) },
        stop: new AbortController().signal, current: () => true,
      });
      expect(dock.calls).toEqual([expected]);
    }
  });

  it('流上早到的写上了、晚到的改成按钮（READY 带着写上的几项，2026-09-24）：是「填好了」，不报「没有能填的」', async () => {
    const dock = spyDock();
    await closeGestureRun({
      dock: () => dock, filled: 0, refused: 'CHOICE_NO_DATA',
      ai: { outcome: Promise.resolve({ kind: 'READY', count: 1, written: 2, apply: async () => ({ ok: false, code: 'GESTURE_EXPIRED' }), noEvidence: [], unanswered: [] } as never) },
      stop: new AbortController().signal, current: () => true,
    });
    expect(dock.calls).toEqual(['finish:FILLED']);
  });

  it('没有 AI 代答：当场收尾，与从前一样', () => {
    const filledDock = spyDock();
    void closeGestureRun({ dock: () => filledDock, filled: 3, stop: new AbortController().signal, current: () => true });
    expect(filledDock.calls, '同步收尾，不等下一拍').toEqual(['finish:FILLED']);
    const emptyDock = spyDock();
    void closeGestureRun({ dock: () => emptyDock, filled: 0, refused: 'NO_VALUE', stop: new AbortController().signal, current: () => true });
    expect(emptyDock.calls).toEqual(['blocked:NO_VALUE']);
  });
});

describe('停止与作废', () => {
  const pressStop = (handle: ReturnType<typeof mountDock>) => handle.sceneRoot()
    ?.querySelector<HTMLButtonElement>('[data-action="stop"]')
    ?.dispatchEvent(new TrustedClick('click', { bubbles: true, composed: true }));

  it('起草时按了「停止」：不再等 AI，当场照「已停止」收尾；之后 AI 一个字没写上（被同一个停止挡住），什么都不画', async () => {
    const ai = deferred<KernelAiAnswersOutcome>();
    const stop = new AbortController();
    const { handle, closing, draw } = run({ rows: RULES_FILLED, filled: 1, ai: ai.promise, stop, onStop: () => stop.abort() });
    await flush();
    pressStop(handle);
    await closing;
    expect(handle.runState()).toBe('STOPPED');
    expect(text(handle.sceneRoot()?.querySelector('.sum-title'))).toBe('填写已停止');
    ai.resolve(NONE);
    await flush();
    expect(draw).not.toHaveBeenCalled();
    expect(handle.sceneRoot()?.querySelector('[data-ai="offer"]')?.getAttribute('style') ?? '').toContain('display: none');
  });

  it('按「停止」时 AI 的答案正写到一半：已经写上网页的那几项照实画上去、标成 AI 代答，这一轮仍是「已停止」', async () => {
    // 2026-09-24 测试台 Ashby：AI 的答案回来得快，进度卡换成 AI 那一句时已经在往网页上写；这时按停止，写上的 3 栏留在
    // 网页上，浮层却只说「填写已停止」、没把它们认成 AI 代答。
    const ai = deferred<KernelAiAnswersOutcome>();
    const stop = new AbortController();
    const { handle, closing, draw } = run({ rows: RULES_FILLED, filled: 1, ai: ai.promise, stop, onStop: () => stop.abort() });
    await flush();
    pressStop(handle);
    await closing;
    expect(text(handle.sceneRoot()?.querySelector('.sum-title'))).toBe('填写已停止');
    ai.resolve(APPLIED);
    await flush();
    expect(draw).toHaveBeenCalledWith(APPLIED);
    expect(handle.sceneRoot()?.querySelectorAll('[data-ai-row]')).toHaveLength(1);
    expect(handle.runState()).toBe('STOPPED');
    expect(text(handle.sceneRoot()?.querySelector('.sum-title'))).toBe('填写已停止');
  });

  it('按「停止」在 AI 开始之前（信号已经停了）：照「已停止」收尾，不等', async () => {
    const stop = new AbortController();
    stop.abort();
    const ai = deferred<KernelAiAnswersOutcome>();
    const { handle, closing, draw } = run({ rows: RULES_FILLED, filled: 1, ai: ai.promise, stop });
    await closing;
    expect(draw).not.toHaveBeenCalled();
    expect(handle.runState()).toBe('STOPPED');
  });

  it('这一轮已经作废（新的一轮、翻页、撤销、浮层换了）：AI 回来之后什么都不做', async () => {
    let current = true;
    const ai = deferred<KernelAiAnswersOutcome>();
    const { handle, closing, draw } = run({ rows: RULES_FILLED, filled: 1, ai: ai.promise, current: () => current });
    handle.retireRun('PAGE_CHANGED');
    current = false;
    ai.resolve(APPLIED);
    await closing;
    expect(draw).not.toHaveBeenCalled();
    expect(handle.runState(), '不在首页上凭空画出一张总结').toBe('IDLE');
  });

  it('被新的一轮停掉的那一轮（它的「停止」随新的一轮一起按下）：什么都不做', async () => {
    let current = true;
    const stop = new AbortController();
    const ai = deferred<KernelAiAnswersOutcome>();
    const { closing, draw, handle } = run({ rows: RULES_FILLED, filled: 1, ai: ai.promise, stop, current: () => current });
    current = false;
    stop.abort();
    await closing;
    expect(handle.runState(), '浮层上那一轮由新的一轮接手').toBe('RUNNING');
    ai.resolve(APPLIED);
    await flush();
    expect(draw).not.toHaveBeenCalled();
  });

  it('把结局画上去时出了错：照样收尾，不让进度卡一直转', async () => {
    const handle = mountDock();
    handle.beginPreparing();
    handle.setAiAnswers({ kind: 'DRAFTING', count: 1 });
    handle.setStep('AI_DRAFTING');
    handle.beginRun(settled(RULES_FILLED));
    const closing = closeGestureRun({
      dock: () => handle, filled: 1, ai: { outcome: Promise.resolve(NONE) },
      stop: new AbortController().signal, current: () => true,
      onAiOutcome: () => { throw new Error('draw failed'); },
    });
    await expect(closing).rejects.toThrow('draw failed');
    expect(handle.runState()).toBe('SETTLED');
  });
});

describe('内容脚本的接线（源码形状闸）', () => {
  const content = readFileSync(resolve(__dirname, '..', 'entrypoints', 'apply.content.ts'), 'utf8');
  const from = content.indexOf('const runGestureFill = async');
  const to = content.indexOf('const showFace = ', from);
  const gestureFill = content.slice(from, to);

  it('送了题给 AI：先告诉浮层 AI 在起草，再把规则那几遍的终局单子交给它', () => {
    expect(from).toBeGreaterThan(0);
    const aiStep = gestureFill.indexOf("dockHandle?.setStep('AI_DRAFTING');");
    expect(aiStep, '手势路没有说 AI_DRAFTING').toBeGreaterThan(0);
    // 送出去的那几栏一并交给浮层：它们还没有结论，不列进「需要你」。
    expect(gestureFill.slice(aiStep - 200, aiStep)).toContain("dockHandle?.setAiAnswers({ kind: 'DRAFTING', count: ai.asked, targets: ai.targets });");
    expect(aiStep).toBeLessThan(gestureFill.indexOf('dockHandle?.beginRun(progress);'));
    expect(aiStep).toBeLessThan(gestureFill.indexOf('const panel = present('));
  });

  it('收尾只经 closeGestureRun：交这一轮自己的「停止」与轮次判断，不在 AI 回来之前自己收尾', () => {
    const close = gestureFill.indexOf('closeGestureRun({');
    expect(close, '手势路没有经 closeGestureRun 收尾').toBeGreaterThan(0);
    const call = gestureFill.slice(close, close + 700);
    expect(call).toContain('stop: stopper.signal,');
    expect(call).toContain('current: stillThisRun,');
    // 停了之后回来的写成的那几项照样画（closeGestureRun），但不再摆「用 AI 写」：那一侧的写入已被同一个停止挡住。
    expect(gestureFill).toContain('if (stopper.signal.aborted || ai.revisable.length === 0');
    // 填完之后不再有直接的收尾：那正是「AI 还在写，浮层已经说填好了」。
    const afterFill = gestureFill.slice(gestureFill.indexOf('const result = await fillFromGesture('));
    expect(afterFill).not.toMatch(/finishRun\(\{\s*started:\s*true/u);
    expect(afterFill).not.toContain("'NOTHING_FILLED'");
  });

  it('「停止」关掉 AI 那条流，却不把这一轮当作废（2026-09-24 流）：照「已停止」收尾要这一轮还算数', () => {
    // 按下「停止」：服务端那一轮随之中止，之后到的一个字不写；closeGestureRun 的 current() 仍为真，才会照「已停止」收尾、
    // 把按下那一刻已经写上网页的照实画上去。作废（撤销、浮层收掉这一轮）才走 cancelAi。
    expect(gestureFill).toContain("stopper.signal.addEventListener('abort', () => { aiSession.cancel(); }, { once: true });");
    expect(gestureFill).not.toMatch(/stopper\.signal\.addEventListener\('abort',\s*cancelAi/u);
    // 流上每到一批，浮层换单子、题数减少（drawAiProgress）；按过「停止」就不再画这一批批的进度。
    expect(gestureFill).toContain('aiSession.attach(audit, (progress) => { drawAiProgress?.(progress); })');
    expect(gestureFill).toContain('if (!stillThisRun() || stopper.signal.aborted) return;');
  });

  it('「停止」一直管到这一轮收尾：AI 那一段也停得了', () => {
    const close = gestureFill.indexOf('closeGestureRun({');
    expect(gestureFill.slice(close, close + 900)).toContain('.finally(() => { if (gestureStop === stopper) gestureStop = null; });');
    const fill = gestureFill.indexOf('const result = await fillFromGesture(');
    const failed = gestureFill.indexOf('if (!result.ok) {', fill);
    // 填写本身失败时照旧当场放下；成功时不再在这里放下。
    expect(gestureFill.slice(fill, failed)).not.toContain('gestureStop = null');
    expect(gestureFill.slice(failed, failed + 200)).toContain('if (gestureStop === stopper) gestureStop = null;');
  });
});
