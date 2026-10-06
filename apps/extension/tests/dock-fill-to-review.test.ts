// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  mountAutofillDock,
  type AutofillDockFieldRow,
  type AutofillDockHandlers,
  type AutofillDockProgress,
  type DockAdvanceOutcome,
  type DockChainState,
} from '../lib/autofillDock';
import { closeGestureRun } from '../lib/gestureRunClose';

/**
 * 浮层上的连填（2026-09-28 负责人：按一下「自动填写」，一页一页填到检查页，停在那里等他按「提交」）。
 *
 * 钉住浮层这一层：进度卡上写第几页、这一步叫什么；一页填完、连填还要往下翻时进度卡不收尾；替他翻页的那几秒还是进度卡、
 * 「停止」一直在；翻过去接着填下一页；没翻过去、弹出关卡、到上限，各自照实说那一件事；到头了一句话总结。
 * 往下翻不翻、凭什么翻，是内容脚本与内核的事（fill-to-review.test.ts）。
 *
 * 夹具全是合成文字。
 */

class TrustedClick extends MouseEvent { get isTrusted() { return true; } }

afterEach(() => {
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

const text = (node: Element | null | undefined) => (node?.textContent ?? '').replace(/\s+/g, ' ').trim();
const flush = async () => { for (let i = 0; i < 4; i += 1) await new Promise<void>((resolve) => { setTimeout(resolve, 0); }); };

function deferred<T>() {
  let settle: (value: T) => void = () => {};
  const promise = new Promise<T>((resolve) => { settle = resolve; });
  return { promise, resolve: (value: T) => settle(value) };
}

const row = (label: string, state: AutofillDockFieldRow['state'], extra: Partial<AutofillDockFieldRow> = {}): AutofillDockFieldRow => ({
  label, required: true, done: state === 'CONFIRMED', state, ...extra,
});
const settled = (runId: string, rows: readonly AutofillDockFieldRow[]): AutofillDockProgress =>
  ({ runId, requiredQuestions: rows.length, requiredCompleted: rows.filter((one) => one.done).length, rows, phase: 'SETTLED' }) as never;
const ALL_FILLED = [row('First Name', 'CONFIRMED', { value: 'Sample' }), row('Last Name', 'CONFIRMED', { value: 'Person' })];

const chainState = (overrides: Partial<DockChainState> = {}): DockChainState => ({
  page: 2, maxPages: 10, site: null, donePages: 1, doneFields: 6, stop: null, ...overrides,
});

function mount(extra: Partial<AutofillDockHandlers> = {}) {
  const handle = mountAutofillDock({ kind: 'UNAVAILABLE', reason: 'NO_MISSION' }, {
    onAutofill: () => {},
    onOpenEntry: () => {},
    nextStep: { label: () => 'Save and Continue', advance: async () => 'ADVANCED' },
    ...extra,
  }, document);
  handle.openPanel();
  return handle;
}
const root = (handle: ReturnType<typeof mount>) => handle.sceneRoot();
const status = (handle: ReturnType<typeof mount>) => text(root(handle)?.querySelector('.act-label'));
const ticker = (handle: ReturnType<typeof mount>) => text(root(handle)?.querySelector('.ticker'));
const title = (handle: ReturnType<typeof mount>) => text(root(handle)?.querySelector('.sum-title'));
const sub = (handle: ReturnType<typeof mount>) => text(root(handle)?.querySelector('.sum-sub'));
const notes = (handle: ReturnType<typeof mount>) => Array.from(root(handle)?.querySelectorAll('.sum-note') ?? []).map((node) => text(node));
const banner = (handle: ReturnType<typeof mount>) => {
  const node = root(handle)?.querySelector<HTMLElement>('.banner');
  return node === null || node === undefined || node.style.display === 'none' ? null : text(node);
};
const toast = (handle: ReturnType<typeof mount>) => text((root(handle)?.getRootNode() as ShadowRoot).querySelector('.toast'));

/** 连填的一页：准备 → 连填的样子 → 终局单子交过来（内容脚本的次序）。 */
function chainPage(handle: ReturnType<typeof mount>, state: DockChainState, rows: readonly AutofillDockFieldRow[] = ALL_FILLED, runId = 'gesture-2') {
  handle.beginPreparing();
  handle.setChain(state);
  handle.beginRun(settled(runId, rows));
  handle.update(settled(runId, rows));
}

describe('进度卡上写第几页、这一步叫什么', () => {
  it('网站说得出：「第 2 页，共 5 页：正在填「My Experience」」', () => {
    const handle = mount();
    handle.beginPreparing();
    handle.setChain(chainState({ site: { index: 2, total: 5, name: 'My Experience' } }));
    expect(status(handle)).toBe('第 2 页，共 5 页：正在填「My Experience」');
  });

  it('网站说不出：「第 2 页：正在填写」（数的是这一轮连着填的第几页）', () => {
    const handle = mount();
    handle.beginPreparing();
    handle.setChain(chainState());
    expect(status(handle)).toBe('第 2 页：正在填写');
  });

  it('不是连填：说此刻在做什么（「正在读表单」）', () => {
    const handle = mount();
    handle.beginPreparing();
    expect(status(handle)).toBe('正在读表单');
  });
});

describe('一页填完、连填还要往下翻：进度卡不收尾', () => {
  it('终局单子到了也还是进度卡（没有总结、没有底栏），等连填说往下翻还是停下', () => {
    const handle = mount();
    chainPage(handle, chainState());
    expect(handle.runState()).toBe('RUNNING');
    expect(root(handle)?.querySelector('.sum-title')).toBeNull();
    expect(handle.primaryButton()).toBeNull();
  });

  it('不是连填：终局单子一到就是总结（与从前一样）', () => {
    const handle = mount();
    handle.beginPreparing();
    handle.beginRun(settled('gesture-1', ALL_FILLED));
    expect(handle.runState()).toBe('SETTLED');
    expect(title(handle)).toBe('这一页填好了');
  });
});

describe('替他翻页（没有点击）', () => {
  it('还是进度卡：「第 2 页：已填好」「正在翻到下一页…」「正在按网站上的「Save and Continue」」，「停止」在，没有底栏', () => {
    const handle = mount({ onStop: () => {} });
    chainPage(handle, chainState());
    handle.autoAdvance(deferred<DockAdvanceOutcome>().promise, 'Save and Continue');
    expect(handle.runState()).toBe('RUNNING');
    expect(status(handle)).toBe('第 2 页：已填好');
    expect(ticker(handle)).toContain('正在翻到下一页…');
    expect(ticker(handle)).toContain('正在按网站上的「Save and Continue」');
    expect(root(handle)?.querySelector('[data-action="stop"]')).not.toBeNull();
    expect(handle.primaryButton()).toBeNull();
    expect(handle.summaryText()).toBe('正在翻到下一页…');
  });

  it('翻过去、正在接着填下一页 → 上一页收掉，进下一页的「准备中」，不另弹提示', async () => {
    const handle = mount();
    chainPage(handle, chainState());
    const pending = deferred<DockAdvanceOutcome>();
    handle.autoAdvance(pending.promise, 'Save and Continue');
    handle.setChain(chainState({ page: 3, donePages: 2, doneFields: 12 }));
    pending.resolve('ADVANCED_FILLING');
    await flush();
    expect(handle.runState()).toBe('PREPARING');
    expect(handle.fieldRows('required')).toEqual([]);
    expect(status(handle)).toBe('第 3 页：正在填写');
    expect(toast(handle)).toBe('');
  });

  it('按了网站没翻 → 换回这一页的总结，横幅「网站没有翻页」，「继续到下一页」还在', async () => {
    const handle = mount();
    chainPage(handle, chainState());
    const pending = deferred<DockAdvanceOutcome>();
    handle.autoAdvance(pending.promise, 'Save and Continue');
    handle.setChain(chainState({ stop: 'NOT_ADVANCED' }));
    pending.resolve('NOT_ADVANCED');
    await flush();
    expect(handle.runState()).toBe('SETTLED');
    expect(banner(handle)).toContain('网站没有翻页');
    expect(handle.nextStepButton()).not.toBeNull();
    expect(notes(handle)).toContain('前 1 页已经填好。');
  });

  /**
   * 2026-09-28 测试台（adobe.wd5 第 1 页，连填按了 Next、网站报「邮编不对」）：有一次浮层在这一页上说「必填项都填好了 ·
   * 检查一遍，没问题就可以提交了」，底栏是「去网站上提交」，没有「继续到下一页」——收尾那一刻网站的「下一步」这一颗
   * 一时没读到（翻页按钮的读法答了 null），浮层就把这一页当成了最后一页。我们刚按过这一页的「下一步」：它不是最后一页，
   * 绝不说提交。
   */
  it('按了网站没翻、收尾那一刻读不到「下一步」→ 仍不说提交：总结是「这一页填好了」，「继续到下一页」还在', async () => {
    let label: string | null = 'Next';
    const handle = mount({ nextStep: { label: () => label, advance: async () => 'NOT_ADVANCED' } });
    chainPage(handle, chainState({ page: 1, donePages: 0, doneFields: 0 }));
    const pending = deferred<DockAdvanceOutcome>();
    handle.autoAdvance(pending.promise, 'Next');
    label = null;
    handle.setChain(chainState({ page: 1, donePages: 0, doneFields: 0, stop: 'NOT_ADVANCED' }));
    pending.resolve('NOT_ADVANCED');
    await flush();
    expect(handle.runState()).toBe('SETTLED');
    expect(title(handle)).toBe('这一页填好了');
    expect(title(handle)).not.toContain('都填好了');
    expect(banner(handle)).toContain('网站没有翻页');
    expect(handle.nextStepButton()).not.toBeNull();
    expect(text(handle.primaryButton())).not.toContain('提交');
  });

  it('网站自己说还有几步（第 2 步，共 5 步）、读不到「下一步」→ 也不说提交', async () => {
    const handle = mount({ nextStep: { label: () => null, advance: async () => 'UNAVAILABLE' } });
    chainPage(handle, chainState({ page: 2, site: { index: 2, total: 5, name: 'My Experience' }, stop: 'NEEDS_USER' }), ALL_FILLED);
    await flush();
    expect(title(handle)).not.toContain('都填好了');
    expect(text(handle.primaryButton())).not.toContain('提交');
  });

  it('按下去网站弹出了人机验证 → 总结说那一件事，不叠「网站没有翻页」', async () => {
    const handle = mount();
    chainPage(handle, chainState());
    const pending = deferred<DockAdvanceOutcome>();
    handle.autoAdvance(pending.promise, 'Save and Continue');
    handle.setChain(chainState({ stop: 'CAPTCHA' }));
    pending.resolve('NOT_ADVANCED');
    await flush();
    expect(title(handle)).toBe('网站要你先完成人机验证');
    expect(sub(handle)).toBe('在网站上完成验证之后，点「继续到下一页」接着往下填。');
    expect(banner(handle)).toBeNull();
  });

  it('翻页按钮此刻按不了 → 总结 + 一句「此刻按不了」', async () => {
    const handle = mount();
    chainPage(handle, chainState());
    const pending = deferred<DockAdvanceOutcome>();
    handle.autoAdvance(pending.promise, 'Save and Continue');
    handle.setChain(chainState({ stop: 'UNAVAILABLE' }));
    pending.resolve('UNAVAILABLE');
    await flush();
    expect(handle.runState()).toBe('SETTLED');
    expect(toast(handle)).toContain('此刻按不了');
  });

  it('翻页的那几秒里按了「停止」→ 当场停在这一页（已停止）；宿主随后翻过去了 → 回到可以点「自动填写」的样子', async () => {
    const onStop = vi.fn();
    const handle = mount({ onStop });
    chainPage(handle, chainState());
    const pending = deferred<DockAdvanceOutcome>();
    handle.autoAdvance(pending.promise, 'Save and Continue');
    root(handle)?.querySelector<HTMLButtonElement>('[data-action="stop"]')?.dispatchEvent(new TrustedClick('click', { bubbles: true }));
    expect(onStop).toHaveBeenCalledTimes(1);
    expect(handle.runState()).toBe('STOPPED');
    expect(title(handle)).toBe('填写已停止');
    pending.resolve('ADVANCED');
    await flush();
    expect(handle.scene()).toBe('HOME');
  });

  it('按了「停止」、宿主没翻 → 停在这一页的「已停止」上，不说「网站没有翻页」', async () => {
    const handle = mount({ onStop: () => {} });
    chainPage(handle, chainState());
    const pending = deferred<DockAdvanceOutcome>();
    handle.autoAdvance(pending.promise, 'Save and Continue');
    root(handle)?.querySelector<HTMLButtonElement>('[data-action="stop"]')?.dispatchEvent(new TrustedClick('click', { bubbles: true }));
    pending.resolve('NOT_ADVANCED');
    await flush();
    expect(title(handle)).toBe('填写已停止');
    expect(banner(handle)).toBeNull();
  });
});

describe('停下来的那一幕', () => {
  it('连着填到了最后一页（规则声明的最终提交在这一页上）→「都填好了」，一句话总结，按不了提交就说在网站上点', () => {
    const handle = mount({ nextStep: { label: () => null, advance: async () => 'ADVANCED' } });
    chainPage(handle, chainState({ page: 4, donePages: 3, doneFields: 20 }));
    handle.setChain(chainState({ page: 4, donePages: 3, doneFields: 20, stop: 'REVIEW' }));
    handle.finishRun({ started: true, outcome: 'FILLED' });
    expect(title(handle)).toBe('都填好了');
    expect(sub(handle)).toBe('已连着填好 4 页，共 22 项。检查一遍，没问题就在网站上点提交。');
    expect(text(handle.primaryButton())).toBe('去网站上提交');
  });

  it('插件替他按得了提交 → 说「按「提交」」，主按钮是「提交」', () => {
    const handle = mount({
      nextStep: { label: () => null, advance: async () => 'ADVANCED' },
      submission: { available: () => true, send: async () => 'SUBMITTED' },
    });
    chainPage(handle, chainState({ page: 2, donePages: 1, doneFields: 5 }));
    handle.setChain(chainState({ page: 2, donePages: 1, doneFields: 5, stop: 'REVIEW' }));
    handle.finishRun({ started: true, outcome: 'FILLED' });
    expect(sub(handle)).toBe('已连着填好 2 页，共 7 项。检查一遍，没问题就按「提交」。');
    expect(text(handle.primaryButton())).toBe('提交');
  });

  it('翻过去是一页没有表的检查页 →「都填好了」，数的是前面填好的页', () => {
    const handle = mount({ nextStep: { label: () => null, advance: async () => 'ADVANCED' } });
    handle.beginPreparing();
    handle.setChain(chainState({ page: 5, donePages: 4, doneFields: 30, stop: 'REVIEW' }));
    handle.retireRun('ADVANCED_EMPTY');
    expect(title(handle)).toBe('都填好了');
    expect(sub(handle)).toBe('已连着填好 4 页，共 30 项。检查一遍，没问题就在网站上点提交。');
  });

  it('单页申请（不连填）照旧：「必填项都填好了」', () => {
    const handle = mount({ nextStep: { label: () => null, advance: async () => 'ADVANCED' } });
    handle.beginPreparing();
    handle.beginRun(settled('gesture-1', ALL_FILLED));
    expect(title(handle)).toBe('必填项都填好了');
  });

  it('这一页还有要他处理的 → 照旧「这一页还有 1 项需要你」，并说处理好之后怎么接着填、前面几页已经填好', () => {
    const handle = mount();
    const rows = [row('First Name', 'CONFIRMED', { value: 'Sample' }), row('Phone Device Type', 'MANUAL', { needsUser: true, reason: 'CHOICE_NO_DATA' })];
    chainPage(handle, chainState({ page: 3, donePages: 2, doneFields: 14 }), rows);
    handle.setChain(chainState({ page: 3, donePages: 2, doneFields: 14, stop: 'NEEDS_USER' }));
    handle.finishRun({ started: true, outcome: 'FILLED' });
    expect(title(handle)).toBe('这一页还有 1 项需要你');
    expect(notes(handle)).toEqual(['前 2 页已经填好。', '处理好之后点「继续到下一页」，会接着往下填。']);
    expect(text(handle.primaryButton())).toBe('去第一项');
    expect(text(handle.nextStepButton())).toBe('继续到下一页');
  });

  it('页数到上限 →「这一页填好了」，说为什么停在这里、怎么接着填', () => {
    const handle = mount();
    chainPage(handle, chainState({ page: 10, donePages: 9, doneFields: 60 }));
    handle.setChain(chainState({ page: 10, donePages: 9, doneFields: 60, stop: 'PAGE_CAP' }));
    handle.finishRun({ started: true, outcome: 'FILLED' });
    expect(title(handle)).toBe('这一页填好了');
    expect(sub(handle)).toBe('已经连着填了 10 页，先停在这里。检查一遍，再点「继续到下一页」接着填。');
  });

  it('翻页按钮说不清是哪一颗 → 不说「都填好了、可以提交」，请他在网站上自己点', () => {
    const handle = mount({ nextStep: { label: () => null, advance: async () => 'ADVANCED' } });
    chainPage(handle, chainState());
    handle.setChain(chainState({ stop: 'UNAVAILABLE' }));
    handle.finishRun({ started: true, outcome: 'FILLED' });
    expect(title(handle)).toBe('这一页填好了');
    expect(sub(handle)).toContain('请在网站上自己点');
  });

  it('翻页之前这一页上就有登录框 → 说要他先登录', () => {
    const handle = mount();
    chainPage(handle, chainState());
    handle.setChain(chainState({ stop: 'LOGIN' }));
    handle.finishRun({ started: true, outcome: 'FILLED' });
    expect(title(handle)).toBe('网站要你先登录');
  });

  it('翻过去那一页是登录页（没有表）→ 卡片说要他先登录，按钮是「再试一次」', () => {
    const handle = mount();
    handle.beginPreparing();
    handle.setChain(chainState({ stop: 'LOGIN' }));
    handle.reportBlocked('CHAIN_LOGIN');
    expect(text(root(handle)?.querySelector('.face-title'))).toBe('网站要你先登录');
    expect(text(root(handle)?.querySelector('.face-sub'))).toBe('在网站上登录之后，点「再试一次」接着往下填。');
    expect(root(handle)?.querySelector('[data-action="retry"]')).not.toBeNull();
  });

  it('翻过去那一页我们认不出要填的（后面还有）→ 说要他自己填这一页', () => {
    const handle = mount();
    handle.beginPreparing();
    handle.reportBlocked('CHAIN_UNKNOWN_PAGE');
    expect(text(root(handle)?.querySelector('.face-title'))).toBe('这一页要你自己填');
  });

  it('新的一次点击「自动填写」：上一轮连填的样子不再算数', () => {
    const onAutofill = vi.fn();
    const handle = mountAutofillDock({ kind: 'READY' } as never, { onAutofill, onOpenEntry: () => {} }, document);
    handle.openPanel();
    handle.beginPreparing();
    handle.setChain(chainState({ page: 3 }));
    handle.retireRun('PAGE_CHANGED');
    handle.autofillButton()?.dispatchEvent(new TrustedClick('click', { bubbles: true }));
    expect(onAutofill).toHaveBeenCalledTimes(1);
    expect(status(handle)).toBe('正在读表单');
  });
});

describe('英文界面', () => {
  const mountEn = (extra: Partial<AutofillDockHandlers> = {}) => mount({ locale: 'en', ...extra });

  it('进度与总结说英文，一个中日韩文字都没有', async () => {
    const handle = mountEn({ nextStep: { label: () => null, advance: async () => 'ADVANCED' } });
    handle.beginPreparing();
    handle.setChain(chainState({ site: { index: 2, total: 5, name: 'My Experience' } }));
    expect(status(handle)).toBe('Page 2 of 5: filling “My Experience”');
    handle.beginRun(settled('gesture-2', ALL_FILLED));
    const pending = deferred<DockAdvanceOutcome>();
    handle.autoAdvance(pending.promise, 'Save and Continue');
    expect(ticker(handle)).toContain('Going to the next page…');
    expect(ticker(handle)).toContain('Pressing the site’s “Save and Continue”');
    handle.setChain(chainState({ site: { index: 2, total: 5, name: 'My Experience' }, stop: 'CAPTCHA' }));
    pending.resolve('NOT_ADVANCED');
    await flush();
    expect(title(handle)).toBe('The site wants you to prove you’re human');
    handle.setChain(chainState({ page: 5, donePages: 4, doneFields: 30, stop: 'REVIEW' }));
    handle.retireRun('ADVANCED_EMPTY');
    expect(title(handle)).toBe('Everything is filled');
    expect(sub(handle)).toBe('Filled 4 pages in a row, 30 fields in all. Look it over, then submit on the site.');
    expect(/[⺀-鿿]/u.test(text(root(handle)))).toBe(false);
  });
});

describe('收尾（closeGestureRun）：连填接手就不收尾', () => {
  const base = (handle: ReturnType<typeof mount>, next: (written: number) => Promise<boolean>, stop = new AbortController()) => {
    chainPage(handle, chainState());
    return closeGestureRun({ dock: () => handle, filled: 2, stop: stop.signal, current: () => true, next });
  };

  it('连填往下翻（交回 true）→ 不收尾：进度卡留着，交给它的是这一页写成了几项', async () => {
    const handle = mount();
    const next = vi.fn(async () => true);
    await base(handle, next);
    expect(next).toHaveBeenCalledWith(2);
    expect(handle.runState()).toBe('RUNNING');
  });

  it('连填停下（交回 false）→ 照常收尾', async () => {
    const handle = mount();
    await base(handle, async () => { handle.setChain(chainState({ stop: 'REVIEW' })); return false; });
    expect(handle.runState()).toBe('SETTLED');
  });

  it('问连填的那一会儿他按了「停止」→ 照「已停止」收尾', async () => {
    const handle = mount();
    const stop = new AbortController();
    await base(handle, async () => { stop.abort(); return false; }, stop);
    expect(handle.runState()).toBe('STOPPED');
  });

  it('连填那一侧出了错 → 照常收尾，别让进度卡一直转；错误照旧抛给调用方', async () => {
    const handle = mount();
    await expect(base(handle, async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    expect(handle.runState()).toBe('SETTLED');
  });
});
