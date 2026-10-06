import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AutofillDockFieldRow, AutofillDockHandle, AutofillDockProgress, DockAdvanceOutcome, DockChainState, DockSubmitOutcome } from '../lib/autofillDock';
import { parseDockRunOutcome, type DockRunOutcomeMessage } from '../lib/runOutcome';
import { createRunOutcomeTap, type RunOutcomeTap } from '../lib/runOutcomeTap';

/**
 * 一轮怎么收场，从浮层上看（2026-10-04，体检 11-1）：内容脚本把挂上的浮层包一层，这一轮给浮层的那几下收场
 * （finishRun / reportBlocked / retireRun / setChain / autoAdvance）原样转给浮层，同时记下这一轮的结局；
 * 收场时交给 worker 一条闭集消息。浮层看到什么，上报的就是什么。
 */
type FakeDock = AutofillDockHandle & { calls: Array<[string, unknown[]]> };

function fakeDock(): FakeDock {
  const calls: Array<[string, unknown[]]> = [];
  const record = (name: string) => (...args: unknown[]) => { calls.push([name, args]); };
  return {
    calls,
    beginRun: record('beginRun'),
    update: record('update'),
    finishRun: record('finishRun'),
    reportBlocked: record('reportBlocked'),
    retireRun: record('retireRun'),
    setChain: record('setChain'),
    autoAdvance: record('autoAdvance'),
    setStep: record('setStep'),
    faceKey: () => 'READY',
  } as unknown as FakeDock;
}

const element = (filled: boolean): Element => ({ filled } as unknown as Element);
const row = (overrides: Partial<AutofillDockFieldRow>): AutofillDockFieldRow =>
  ({ label: 'x', required: false, done: false, ...overrides }) as AutofillDockFieldRow;
const progress = (rows: readonly AutofillDockFieldRow[]): AutofillDockProgress =>
  ({ runId: 'gesture-1', requiredCompleted: 0, requiredQuestions: 0, rows });
const chain = (page: number, stop: DockChainState['stop'] = null): DockChainState =>
  ({ page, maxPages: 8, site: null, donePages: page - 1, doneFields: 0, stop });

describe('一轮的结局（浮层那几下收场）', () => {
  let clock = 0;
  let sent: DockRunOutcomeMessage[];
  let tap: RunOutcomeTap;
  let dock: FakeDock;
  let observed: AutofillDockHandle;
  let ids = 0;

  beforeEach(() => {
    vi.useFakeTimers();
    clock = 1_000;
    sent = [];
    ids = 0;
    tap = createRunOutcomeTap({
      send: (message) => { sent.push(message); },
      page: () => ({ vendor: 'workday', lane: 'host' }),
      hasValue: (target) => (target as unknown as { filled: boolean }).filled,
      now: () => clock,
      newId: () => `${String(ids += 1).padStart(2, '0')}${'ab'.repeat(15)}`,
    });
    dock = fakeDock();
    observed = tap.observe(dock);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const begin = (input: { continuesChain?: boolean; superseded?: () => boolean } = {}) => {
    const stopper = new AbortController();
    tap.begin({ continuesChain: input.continuesChain ?? false, signal: stopper.signal, superseded: input.superseded ?? (() => false) });
    return stopper;
  };
  const events = () => sent.map((message) => ({ final: message.final, ...message.event }));

  it('填上了一些、还有必填要他：NEEDS_YOU，数是桶，按这一轮最后那份单子算；页面上空着的必填另数', () => {
    begin();
    observed.beginRun(progress([]));
    clock += 7_500;
    observed.update(progress([
      row({ required: true, state: 'CONFIRMED', signedOnBehalf: 'TERMS_CONSENT' }),
      row({ required: true, state: 'MANUAL', needsUser: true, target: element(false) }),
      row({ required: true, state: 'PRESERVED', target: element(true) }),
      row({ state: 'CONFIRMED', aiAnswered: true }),
      row({ state: 'UNVERIFIED' }),
      row({ state: 'FAILED', signedOnBehalf: 'SIGNATURE_NAME' }),
    ]));
    observed.finishRun({ started: true, outcome: 'FILLED' });

    expect(events()).toEqual([{
      final: false,
      runId: `01${'ab'.repeat(15)}`,
      vendor: 'workday',
      lane: 'host',
      outcome: 'NEEDS_YOU',
      planned: '6-10',
      filled: '3',
      needsYou: '1',
      aiAnswered: '1',
      signedOnBehalf: '1',
      requiredEmptyOnPage: '1',
      fillRate: '50-74',
      durationBucket: '5_10S',
      chainPages: 0,
      submitOutcome: 'none',
    }]);
    // 浮层照样收到每一下，参数不变。
    expect(dock.calls.map(([name]) => name)).toEqual(['beginRun', 'update', 'finishRun']);
    expect(dock.calls[2]?.[1]).toEqual([{ started: true, outcome: 'FILLED' }]);
  });

  it('每一条消息 worker 都认（闭集、跨字段一致）', () => {
    begin();
    observed.reportBlocked('PROFILE_UNAVAILABLE');
    begin();
    observed.beginRun(progress([row({ required: true, state: 'CONFIRMED' })]));
    observed.finishRun({ started: true, outcome: 'FILLED' });
    tap.pageHidden();
    expect(sent.length).toBeGreaterThan(0);
    for (const message of sent) expect(parseDockRunOutcome(message)).not.toBeNull();
  });

  it('全都填好：FILLED_ALL；先交一份草稿，他在浮层里按「提交」、网站确认之后交终稿', async () => {
    begin();
    observed.beginRun(progress([row({ required: true, state: 'CONFIRMED' })]));
    observed.finishRun({ started: true, outcome: 'FILLED' });
    let settle!: (outcome: DockSubmitOutcome) => void;
    tap.pressed(new Promise<DockSubmitOutcome>((resolve) => { settle = resolve; }));
    settle('SUBMITTED');
    await vi.runAllTimersAsync();

    expect(events().map(({ final, outcome, submitOutcome }) => ({ final, outcome, submitOutcome }))).toEqual([
      { final: false, outcome: 'FILLED_ALL', submitOutcome: 'none' },
      // 按下去那一刻：页面若就此整页跳走，worker 手里至少有「按了」。
      { final: false, outcome: 'FILLED_ALL', submitOutcome: 'unconfirmed' },
      { final: true, outcome: 'FILLED_ALL', submitOutcome: 'confirmed' },
    ]);
  });

  it('网站没收：说 rejected，这一页还开着（他改好再按一次）；离开页面时交终稿', async () => {
    begin();
    observed.beginRun(progress([row({ required: true, state: 'CONFIRMED' })]));
    observed.finishRun({ started: true, outcome: 'FILLED' });
    tap.pressed(Promise.resolve<DockSubmitOutcome>('NOT_SUBMITTED'));
    await vi.runAllTimersAsync();
    tap.pageHidden();

    expect(events().map(({ final, submitOutcome }) => ({ final, submitOutcome }))).toEqual([
      { final: false, submitOutcome: 'none' },
      { final: false, submitOutcome: 'unconfirmed' },
      { final: false, submitOutcome: 'rejected' },
      { final: true, submitOutcome: 'rejected' },
    ]);
  });

  it('开始之前就被拒（还没有单子）：FAILED，带闭集里的原因，列出 0 栏、填写率 NONE', () => {
    begin();
    clock += 1_200;
    observed.reportBlocked('PROFILE_UNAVAILABLE');

    expect(events()).toEqual([expect.objectContaining({
      final: true, outcome: 'FAILED', reason: 'PROFILE_UNAVAILABLE', planned: '0', filled: '0', fillRate: 'NONE', durationBucket: 'LT_2S',
    })]);
  });

  it('扫描停下的码带后缀：只送前面那一段；认不出的码送 OTHER', () => {
    begin();
    observed.reportBlocked('NOT_SEALABLE:ROOT_MUTATED');
    begin();
    observed.reportBlocked('https://boards.greenhouse.io/acme');
    expect(events().map(({ reason }) => reason)).toEqual(['NOT_SEALABLE', 'OTHER']);
    expect(JSON.stringify(sent)).not.toContain('greenhouse');
  });

  it('跑完了一项都没写上：NOTHING_FILLED，原因是第一条拒绝；半路抛了是 FAILED / RUN_FAILED', () => {
    begin();
    observed.beginRun(progress([row({ required: true, state: 'MANUAL' })]));
    observed.reportBlocked('NO_VALUE');
    begin();
    observed.beginRun(progress([row({ state: 'PENDING' })]));
    observed.reportBlocked('RUN_FAILED');

    expect(events().map(({ outcome, reason, final }) => ({ outcome, reason, final }))).toEqual([
      { outcome: 'NOTHING_FILLED', reason: 'NO_VALUE', final: false },
      // 新的一轮开始：上一轮的草稿交成终稿。
      { outcome: 'NOTHING_FILLED', reason: 'NO_VALUE', final: true },
      { outcome: 'FAILED', reason: 'RUN_FAILED', final: true },
    ]);
  });

  it('扫出了表、填写说「什么都没填上」（没有单子）：NOTHING_FILLED（不当成没能开始），草稿等提交', () => {
    begin();
    observed.setStep('SCANNING');
    observed.setStep('PLANNING');
    observed.reportBlocked('NOTHING_FILLED');
    expect(events()).toEqual([expect.objectContaining({ outcome: 'NOTHING_FILLED', planned: '0', fillRate: 'NONE', final: false })]);
    expect(events()[0]).not.toHaveProperty('reason');
    // 准备时就被拒（扫出表之后、要档案时）：照旧是 FAILED，一次交终稿。
    begin();
    observed.setStep('PLANNING');
    observed.reportBlocked('PROFILE_UNAVAILABLE');
    expect(events().at(-1)).toEqual(expect.objectContaining({ outcome: 'FAILED', reason: 'PROFILE_UNAVAILABLE', final: true }));
  });

  it('连填：第 1 页翻过去是 CHAIN_ADVANCED，第 2 页停在检查页是 CHAIN_STOPPED / REVIEW', async () => {
    begin();
    observed.setChain(chain(1));
    observed.beginRun(progress([row({ state: 'CONFIRMED' }), row({ state: 'CONFIRMED' })]));
    clock += 3_000;
    let advanced!: (outcome: DockAdvanceOutcome) => void;
    const pending = new Promise<DockAdvanceOutcome>((resolve) => { advanced = resolve; });
    observed.autoAdvance(pending, 'Save and Continue');
    // 翻过去了：连填在同一拍里用新一页的凭证接着填（runGestureFill），之后翻页的结论才到。
    clock += 4_000;
    observed.setChain(chain(2));
    begin({ continuesChain: true });
    advanced('ADVANCED_FILLING');
    await vi.runAllTimersAsync();
    observed.setChain(chain(2));
    observed.beginRun(progress([row({ required: true, state: 'CONFIRMED' })]));
    observed.setChain(chain(2, 'REVIEW'));
    observed.finishRun({ started: true, outcome: 'FILLED' });

    expect(events().map(({ final, outcome, reason, chainPages, durationBucket, filled }) => ({ final, outcome, reason, chainPages, durationBucket, filled }))).toEqual([
      // 这一页填完那一刻定的数与时长，不算等网站翻页的那几秒。
      { final: true, outcome: 'CHAIN_ADVANCED', reason: undefined, chainPages: 1, durationBucket: '2_5S', filled: '2' },
      { final: false, outcome: 'CHAIN_STOPPED', reason: 'REVIEW', chainPages: 2, durationBucket: 'LT_2S', filled: '1' },
    ]);
  });

  it('连填按了网站的下一步、网站没翻：CHAIN_STOPPED / NOT_ADVANCED', async () => {
    begin();
    observed.setChain(chain(3));
    observed.beginRun(progress([row({ state: 'CONFIRMED' })]));
    observed.autoAdvance(new Promise<DockAdvanceOutcome>(() => {}), null);
    observed.setChain(chain(3, 'NOT_ADVANCED'));

    expect(events()).toEqual([expect.objectContaining({ outcome: 'CHAIN_STOPPED', reason: 'NOT_ADVANCED', chainPages: 3, final: false })]);
  });

  it('连填停在要他处理的必填上：CHAIN_STOPPED / NEEDS_USER（不是 NEEDS_YOU）', () => {
    begin();
    observed.setChain(chain(2));
    observed.beginRun(progress([row({ required: true, state: 'MANUAL' }), row({ state: 'CONFIRMED' })]));
    observed.setChain(chain(2, 'NEEDS_USER'));
    observed.finishRun({ started: true, outcome: 'FILLED' });
    expect(events()).toEqual([expect.objectContaining({ outcome: 'CHAIN_STOPPED', reason: 'NEEDS_USER', chainPages: 2 })]);
  });

  it('连填翻过去，新一页没有表：检查页是 CHAIN_STOPPED / REVIEW，验证码是 CHAIN_STOPPED / CAPTCHA', async () => {
    begin();
    observed.setChain(chain(1));
    observed.autoAdvance(new Promise<DockAdvanceOutcome>(() => {}), null);
    begin({ continuesChain: true });
    observed.setChain(chain(2, 'REVIEW'));
    observed.retireRun('ADVANCED_EMPTY');
    begin();
    observed.setChain(chain(1));
    observed.autoAdvance(new Promise<DockAdvanceOutcome>(() => {}), null);
    begin({ continuesChain: true });
    observed.reportBlocked('CHAIN_CAPTCHA');

    expect(events().filter((one) => one.final).map(({ outcome, reason, chainPages }) => ({ outcome, reason, chainPages }))).toEqual([
      { outcome: 'CHAIN_ADVANCED', reason: undefined, chainPages: 1 },
      { outcome: 'CHAIN_STOPPED', reason: 'REVIEW', chainPages: 2 },
      { outcome: 'CHAIN_ADVANCED', reason: undefined, chainPages: 1 },
      { outcome: 'CHAIN_STOPPED', reason: 'CAPTCHA', chainPages: 2 },
    ]);
  });

  it('准备时按了「停止」（浮层不再收到任何一下）：几秒后照 STOPPED 交，时长量到按下的那一刻', async () => {
    const stopper = begin();
    clock += 1_000;
    stopper.abort();
    clock += 60_000;
    await vi.advanceTimersByTimeAsync(3_000);

    expect(events()).toEqual([expect.objectContaining({ outcome: 'STOPPED', final: true, durationBucket: 'LT_2S' })]);
    expect(events()[0]).not.toHaveProperty('reason');
  });

  it('写的时候按了「停止」：浮层收尾说已停止，STOPPED', () => {
    const stopper = begin();
    observed.beginRun(progress([row({ state: 'CONFIRMED' })]));
    stopper.abort();
    observed.finishRun({ started: true, outcome: 'STOPPED' });
    expect(events()).toEqual([expect.objectContaining({ outcome: 'STOPPED', final: true, filled: '1' })]);
  });

  it('被新的一轮取代：STOPPED / SUPERSEDED，马上交，不等', () => {
    let serial = 1;
    const first = begin({ superseded: () => serial !== 1 });
    observed.beginRun(progress([row({ state: 'PENDING' })]));
    serial = 2;
    first.abort();
    begin();
    expect(events()).toEqual([expect.objectContaining({ outcome: 'STOPPED', reason: 'SUPERSEDED', final: true })]);
  });

  it('离开页面：还在跑的是 STOPPED / PAGE_LEFT；连填正替他翻页时整页跳走是 CHAIN_ADVANCED', () => {
    begin();
    observed.beginRun(progress([row({ state: 'PENDING' })]));
    tap.pageHidden();
    begin();
    observed.setChain(chain(4));
    observed.autoAdvance(new Promise<DockAdvanceOutcome>(() => {}), null);
    tap.pageHidden();

    expect(events().map(({ outcome, reason, final }) => ({ outcome, reason, final }))).toEqual([
      { outcome: 'STOPPED', reason: 'PAGE_LEFT', final: true },
      { outcome: 'CHAIN_ADVANCED', reason: undefined, final: true },
    ]);
  });

  it('收场之后浮层再收到的几下（他自己在网站上翻了页、晚到的复查）不改结局', () => {
    begin();
    observed.beginRun(progress([row({ required: true, state: 'CONFIRMED' })]));
    observed.finishRun({ started: true, outcome: 'FILLED' });
    observed.update(progress([row({ required: true, state: 'FAILED' })]));
    observed.retireRun('PAGE_CHANGED');
    observed.reportBlocked('DETACHED');
    expect(events()).toEqual([expect.objectContaining({ outcome: 'FILLED_ALL', final: false, needsYou: '0' })]);
  });

  it('不是连填时他自己在网站上翻了页：STOPPED / PAGE_CHANGED', () => {
    begin();
    observed.beginRun(progress([row({ state: 'PENDING' })]));
    observed.retireRun('PAGE_CHANGED');
    expect(events()).toEqual([expect.objectContaining({ outcome: 'STOPPED', reason: 'PAGE_CHANGED', final: true })]);
  });

  it('连填翻到的这一页不能用那一轮的凭证写：CHAIN_STOPPED，原因是调用方记下的那一条', () => {
    begin();
    observed.setChain(chain(2));
    observed.autoAdvance(new Promise<DockAdvanceOutcome>(() => {}), null);
    begin({ continuesChain: true });
    tap.note('TIME_CAP');
    observed.retireRun('ADVANCED');
    expect(events().at(-1)).toEqual(expect.objectContaining({ outcome: 'CHAIN_STOPPED', reason: 'TIME_CAP', chainPages: 3 }));
  });

  it('上报这一侧出了错，浮层照样收到那一下，填写不受影响', () => {
    const failing = createRunOutcomeTap({
      send: () => { throw new Error('channel closed'); },
      page: () => { throw new TypeError('no page'); },
      hasValue: () => false,
      onError: vi.fn(),
    });
    const wrapped = failing.observe(dock);
    failing.begin({ continuesChain: false, signal: new AbortController().signal, superseded: () => false });
    expect(() => wrapped.reportBlocked('PROFILE_UNAVAILABLE')).not.toThrow();
    expect(dock.calls).toEqual([['reportBlocked', ['PROFILE_UNAVAILABLE']]]);
  });

  it('没有在跑的一轮时，浮层的那几下只转给浮层', () => {
    observed.reportBlocked('GESTURE_UNTRUSTED');
    observed.finishRun({ started: true, outcome: 'FILLED' });
    expect(sent).toEqual([]);
    expect(dock.calls).toHaveLength(2);
  });

  it('浮层其余的方法原样留着：冻结的浮层（生产）与按需造方法的桩都行', () => {
    expect(observed.faceKey()).toBe('READY');
    const frozen = Object.freeze({ ...fakeDock(), openPanel: () => 'opened' }) as unknown as AutofillDockHandle;
    const wrappedFrozen = tap.observe(frozen);
    expect((wrappedFrozen as unknown as { openPanel: () => string }).openPanel()).toBe('opened');
    begin();
    wrappedFrozen.reportBlocked('AUTHORITY_UNAVAILABLE');
    expect(events().at(-1)).toEqual(expect.objectContaining({ outcome: 'FAILED', reason: 'AUTHORITY_UNAVAILABLE' }));
    const made: Record<string, unknown> = {};
    const lazy = new Proxy(made, { get: (target, key: string) => (target[key] ??= vi.fn(() => key)) }) as unknown as AutofillDockHandle;
    const wrappedLazy = tap.observe(lazy);
    expect((wrappedLazy as unknown as { toast: () => string }).toast()).toBe('toast');
    wrappedLazy.retireRun('PAGE_CHANGED');
    expect(made.retireRun).toHaveBeenCalledWith('PAGE_CHANGED');
  });
});
