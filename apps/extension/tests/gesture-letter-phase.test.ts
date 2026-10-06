// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { KernelAiAnswersOutcome } from '../lib/aiAnswers';
import { mountAutofillDock, type AutofillDockFieldRow, type AutofillDockProgress } from '../lib/autofillDock';
import { closeGestureRun } from '../lib/gestureRunClose';

/**
 * 求职信还在写，这一轮就还没完（负责人 2026-09-28，Y Soft 的 Greenhouse 页）。
 *
 * 他看到的：规则那几栏一填完浮层就收尾成「1 field still needs you」，求职信那一栏（可选，不在「需要你」里）写的这
 * 一段什么都不显示，写好附上了才冒出一句「已附上」。与 AI 代答同一条规矩（2026-09-24：「ai 如果在启用的话，那个
 * 黑色的进度框应该还显示着」）：信还在写，进度卡留着、写明「正在为这个岗位写求职信…」；附上了、要再点一下、附不了，
 * 才收尾。按「停止」不再等。AI 与信都在路上时，先写 AI 那一句，AI 有了结局再换成信那一句。
 *
 * 夹具全是合成文字。
 */
afterEach(() => {
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

const text = (node: Element | null | undefined) => (node?.textContent ?? '').replace(/\s+/g, ' ').trim();
const flush = () => new Promise<void>((done) => { setTimeout(done, 0); });
function deferred<T>() {
  let settle: (value: T) => void = () => {};
  const promise = new Promise<T>((done) => { settle = done; });
  return { promise, resolve: (value: T) => settle(value) };
}

const RUN = 'gesture-9';
const row = (label: string, state: AutofillDockFieldRow['state'], extra: Partial<AutofillDockFieldRow> = {}): AutofillDockFieldRow => ({
  label, required: true, done: state === 'CONFIRMED', state, ...extra,
});
const settled = (rows: readonly AutofillDockFieldRow[]): AutofillDockProgress =>
  ({ runId: RUN, requiredQuestions: rows.length, requiredCompleted: rows.filter((one) => one.done).length, rows, phase: 'SETTLED' }) as never;
const ROWS: readonly AutofillDockFieldRow[] = [row('First Name', 'CONFIRMED', { value: 'Sample' })];

function run(input: { letter: Promise<number>; ai?: Promise<KernelAiAnswersOutcome>; stop?: AbortController }) {
  const handle = mountAutofillDock({ kind: 'UNAVAILABLE', reason: 'NO_MISSION' }, {
    onAutofill: () => {}, onOpenEntry: () => {},
    nextStep: { label: () => 'Save and Continue', advance: async () => 'ADVANCED' },
  }, document);
  handle.openPanel();
  const stop = input.stop ?? new AbortController();
  handle.beginPreparing();
  // 内容脚本的次序：信还在写就说一声，再把规则那几遍的终局单子交给浮层。
  handle.setCoverLetter({ kind: 'WRITING', targets: [document.createElement('input')] });
  if (input.ai !== undefined) handle.setAiAnswers({ kind: 'DRAFTING', count: 1 });
  handle.setStep('AI_DRAFTING');
  handle.beginRun(settled(ROWS));
  handle.update(settled(ROWS));
  const closing = closeGestureRun({
    dock: () => handle,
    filled: 1,
    ...(input.ai === undefined ? {} : { ai: { outcome: input.ai } }),
    letter: { settled: input.letter },
    stop: stop.signal,
    current: () => true,
    onAiOutcome: (outcome) => { handle.setAiAnswers(outcome.kind === 'APPLIED' ? { kind: 'APPLIED', count: outcome.written } : { kind: 'IDLE' }); },
  });
  return { handle, closing, stop };
}
const ticker = (handle: ReturnType<typeof run>['handle']) => text(handle.sceneRoot()?.querySelector('.ticker-q'));

describe('求职信还在写：这一轮不收尾', () => {
  it('进度卡留着、写明正在写求职信，没有「继续到下一页」；附上了才收尾', async () => {
    const letter = deferred<number>();
    const { handle, closing } = run({ letter: letter.promise });
    await flush();
    expect(handle.runState()).toBe('RUNNING');
    expect(ticker(handle)).toBe('正在为这个岗位写求职信…');
    expect(handle.nextStepButton()).toBeNull();
    handle.setCoverLetter({ kind: 'ATTACHED' });
    letter.resolve(1);
    await closing;
    expect(handle.runState()).not.toBe('RUNNING');
  });

  it('AI 与信都在路上：先说 AI 在填，AI 有了结局换成信那一句，信好了才收尾', async () => {
    const ai = deferred<KernelAiAnswersOutcome>();
    const letter = deferred<number>();
    const { handle, closing } = run({ letter: letter.promise, ai: ai.promise });
    await flush();
    expect(ticker(handle)).toBe('AI 正在按你的资料填写 1 道题…');
    ai.resolve({ kind: 'NONE', noEvidence: [], unanswered: [] });
    await flush();
    expect(handle.runState()).toBe('RUNNING');
    expect(ticker(handle)).toBe('正在为这个岗位写求职信…');
    letter.resolve(0);
    await closing;
    expect(handle.runState()).not.toBe('RUNNING');
  });

  it('按「停止」：不再等信，当场照「已停止」收尾', async () => {
    const letter = deferred<number>();
    const stop = new AbortController();
    const { handle, closing } = run({ letter: letter.promise, stop });
    await flush();
    stop.abort();
    await closing;
    expect(handle.runState()).not.toBe('RUNNING');
  });
});

describe('接线', () => {
  const content = readFileSync(resolve(__dirname, '../entrypoints/apply.content.ts'), 'utf8');
  it('内容脚本：信还在写就让进度卡留着，收尾时把信的结局交给 closeGestureRun', () => {
    expect(content).toMatch(/letterSettled/u);
    expect(content).toMatch(/closeGestureRun\(\{[\s\S]{0,600}letter: \{ settled: letterSettled \}/u);
    expect(content).toMatch(/letterPending !== null && letterEarly === null[\s\S]{0,200}setStep\('AI_DRAFTING'\)/u);
  });
});
