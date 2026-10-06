// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest';
import type { AuditRow, AuditView } from '@edaix/apply-kernel/audit';

import {
  mountAutofillDock,
  type AutofillDockHandlers,
  type AutofillDockProgress,
  type DockAdvanceOutcome,
} from '../lib/autofillDock';

/**
 * 多页申请的「继续到下一页」（2026-09-22；2026-09-23 按新设计重画）。
 *
 * Workday 的申请是五六步的向导，每一步底部都是同一颗 Save and Continue，浮层展开时正好压在它
 * 上面。浮层底栏自己给一颗「继续到下一页」，上方一行小字「会替你按网站上的「Save and Continue」」：
 * 用户按我们的，我们按宿主那一颗；还有要他处理的项目时，主按钮是「去第一项」（2026-09-28 之前是「逐项处理」），「继续到下一页」
 * 退为次级按钮。翻过去之后上一页的审计收掉；按了没翻，主卡下面出现 rose 色横幅「网站没有翻页」。
 *
 * 这份文件只测浮层这一层。找哪一颗、按不按得、翻没翻过去，是内容脚本与内核的事。
 */

class TrustedClick extends MouseEvent { get isTrusted() { return true; } }

const settledRun = (runId = 'gesture-1'): AutofillDockProgress & { phase: 'SETTLED' } => ({
  runId,
  phase: 'SETTLED',
  requiredCompleted: 2,
  requiredQuestions: 2,
  rows: [
    { label: 'First Name', required: true, done: true, value: 'Ke' },
    { label: 'Last Name', required: true, done: true, value: 'Chen' },
  ],
});

function row(label: string): AuditRow {
  return {
    key: null, required: true, status: 'FILLED', reason: null, attemptedValue: null,
    resolvedOptionText: null, confidence: null, order: 0, element: document.createElement('input'), label,
  };
}
const view = (): AuditView => ({
  rows: [row('First Name')], filled: 1, requiredTotal: 1, requiredHandled: 1,
  needsAttention: 0, blockedByUs: 0, awaitingUser: 0,
});

/** 一个可以从外面决定结论的 advance。 */
function deferredAdvance() {
  let settle: (outcome: DockAdvanceOutcome) => void = () => {};
  const advance = vi.fn((_event: MouseEvent, _shadow: ShadowRoot) =>
    new Promise<DockAdvanceOutcome>((resolve) => { settle = resolve; }));
  return { advance, settle: (outcome: DockAdvanceOutcome) => settle(outcome) };
}

function mount(nextStep?: AutofillDockHandlers['nextStep']) {
  const doc = document.implementation.createHTMLDocument();
  const handle = mountAutofillDock({ kind: 'UNAVAILABLE', reason: 'NO_MISSION' }, {
    onAutofill: () => {},
    onOpenEntry: () => {},
    ...(nextStep === undefined ? {} : { nextStep }),
  }, doc);
  handle.openPanel();
  return handle;
}

const flush = () => new Promise<void>((resolve) => { setTimeout(resolve, 0); });
const text = (element: Element | null | undefined) => (element?.textContent ?? '').replace(/\s+/g, ' ').trim();
const toastText = (handle: ReturnType<typeof mount>) =>
  text((handle.sceneRoot()?.getRootNode() as ShadowRoot | undefined)?.querySelector('.toast'));
const banner = (handle: ReturnType<typeof mount>) => {
  const node = handle.sceneRoot()?.querySelector<HTMLElement>('.banner');
  return node === null || node === undefined || node.style.display === 'none' ? null : node;
};

describe('什么时候摆出「继续到下一页」', () => {
  it('跑完、宿主页上有一颗能按的下一步 → 它是底栏的主按钮，上方一行写明会按网站上的哪一颗', () => {
    const handle = mount({ label: () => 'Save and Continue', advance: async () => 'ADVANCED' });
    handle.beginRun(settledRun());
    const next = handle.nextStepButton();
    expect(next).not.toBeNull();
    expect(next).toBe(handle.primaryButton());
    expect(text(next)).toBe('继续到下一页');
    expect(text(handle.sceneRoot()?.querySelector('.bar-caption'))).toBe('会替你按网站上的「Save and Continue」');
    // 这一页后面还有下一步：总结说的是「这一页」。
    expect(text(handle.sceneRoot()?.querySelector('.sum-title'))).toBe('这一页填好了');
  });

  it('宿主页上没有能按的（最后一步是 Submit）→ 没有这颗按钮；这里替不了用户按提交，主按钮照实写「去网站上提交」', () => {
    const handle = mount({ label: () => null, advance: async () => 'ADVANCED' });
    handle.beginRun(settledRun());
    expect(handle.nextStepButton()).toBeNull();
    expect(text(handle.primaryButton())).toBe('去网站上提交');
  });

  it('没接翻页处理器 → 没有这颗按钮', () => {
    const handle = mount();
    handle.beginRun(settledRun());
    expect(handle.nextStepButton()).toBeNull();
  });

  it('还在填 → 没有这颗按钮（一轮没结束就翻页，等于丢下没写完的字段）', () => {
    const handle = mount({ label: () => 'Next', advance: async () => 'ADVANCED' });
    handle.beginRun({ ...settledRun(), phase: 'FILLING' } as never);
    expect(handle.nextStepButton()).toBeNull();
  });

  it('问字样时抛了异常 → 当作没有，不崩、不猜', () => {
    const handle = mount({ label: () => { throw new Error('boom'); }, advance: async () => 'ADVANCED' });
    handle.beginRun(settledRun());
    expect(handle.nextStepButton()).toBeNull();
  });

  it('还有必填要用户自己完成 → 主按钮是「去第一项」，「继续到下一页」退为次级按钮', () => {
    const handle = mount({ label: () => 'Save and Continue', advance: async () => 'ADVANCED' });
    handle.beginRun({
      ...settledRun(),
      rows: [
        { label: 'School', required: true, done: false, state: 'FAILED', reason: 'NO_OPTION_MATCH' },
        { label: 'Work authorization', required: true, done: false, needsUser: true },
      ],
    });
    expect(text(handle.primaryButton())).toBe('去第一项');
    const next = handle.nextStepButton();
    expect(next).not.toBe(handle.primaryButton());
    expect(next?.className).toBe('btn-secondary');
    // 总结与列表数的是同一批。
    expect(text(handle.sceneRoot()?.querySelector('.sum-title'))).toBe('这一页还有 2 项需要你');
  });
});

describe('只认真点击，事件原样交出去', () => {
  it('页面派发的点击什么都不按', () => {
    const { advance } = deferredAdvance();
    const handle = mount({ label: () => 'Next', advance });
    handle.beginRun(settledRun());
    handle.nextStepButton()?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(advance).not.toHaveBeenCalled();
  });

  it('真点击：事件与我方 shadow root 一起交给调用方，按钮转成「正在翻页…」且不可再按', () => {
    const { advance } = deferredAdvance();
    const handle = mount({ label: () => 'Next', advance });
    handle.beginRun(settledRun());
    const shadow = handle.showAudit!(view(), {}).shadowRoot;
    handle.nextStepButton()?.dispatchEvent(new TrustedClick('click', { bubbles: true }));
    expect(advance).toHaveBeenCalledTimes(1);
    expect(advance.mock.calls[0]?.[0]).toBeInstanceOf(MouseEvent);
    expect(advance.mock.calls[0]?.[1]).toBe(shadow);
    const busy = handle.nextStepButton();
    expect(busy?.disabled).toBe(true);
    expect(text(busy)).toContain('正在翻页…');
  });

  it('连按两下 → 宿主只被按一次', () => {
    const { advance } = deferredAdvance();
    const handle = mount({ label: () => 'Next', advance });
    handle.beginRun(settledRun());
    const first = handle.nextStepButton();
    first?.dispatchEvent(new TrustedClick('click', { bubbles: true }));
    first?.dispatchEvent(new TrustedClick('click', { bubbles: true }));
    expect(advance).toHaveBeenCalledTimes(1);
  });
});

describe('几种结论', () => {
  it('翻过去了 → 审计收掉、行清空，回到可以点「自动填写」的样子，并说一句', async () => {
    const { advance, settle } = deferredAdvance();
    const handle = mount({ label: () => 'Save and Continue', advance });
    handle.beginRun(settledRun());
    const onDismiss = vi.fn();
    handle.showAudit!(view(), { onDismiss });
    handle.nextStepButton()?.dispatchEvent(new TrustedClick('click', { bubbles: true }));
    settle('ADVANCED');
    await flush();
    expect(handle.scene()).toBe('HOME');
    expect(handle.sheetState()).toBe('ABSENT');
    expect(handle.runState()).toBe('IDLE');
    expect(handle.fieldRows('required')).toEqual([]);
    expect(onDismiss, '审计走它自己的收场，让调用方作废那一代审阅').toHaveBeenCalledTimes(1);
    expect(toastText(handle)).toBe('已到下一页。点「自动填写」填这一页。');
    expect(handle.autofillEnabled()).toBe(true);
  });

  it('按了没翻、这一页认得的必填都填好了 → 横幅「网站没有翻页」，不说成「还有必填没填好」', async () => {
    const { advance, settle } = deferredAdvance();
    const handle = mount({ label: () => 'Save and Continue', advance });
    handle.beginRun(settledRun());
    handle.nextStepButton()?.dispatchEvent(new TrustedClick('click', { bubbles: true }));
    settle('NOT_ADVANCED');
    await flush();
    expect(handle.scene()).toBe('AUTOFILL');
    expect(handle.fieldRows('required')).toHaveLength(2);
    const note = text(banner(handle));
    expect(note).toContain('网站没有翻页');
    expect(note).toContain('会话过期');
    expect(note).not.toContain('还有');
    expect(handle.nextStepButton()?.disabled).toBe(false);
  });

  it('按了没翻、这一页还有必填空着 → 照实说还差几项；用户改好之后横幅变成「都改好了」', async () => {
    const { advance, settle } = deferredAdvance();
    const handle = mount({ label: () => 'Save and Continue', advance });
    const input = document.createElement('input');
    handle.beginRun({
      ...settledRun(),
      rows: [
        { label: 'First Name', required: true, done: true, value: 'Ke' },
        { label: 'Phone Device Type', required: true, done: false, state: 'MANUAL', needsUser: true, reason: 'CHOICE_NO_DATA', target: input },
      ],
    });
    handle.nextStepButton()?.dispatchEvent(new TrustedClick('click', { bubbles: true }));
    settle('NOT_ADVANCED');
    await flush();
    expect(text(banner(handle))).toContain('这一页还有 1 项必填没填好');
    expect(banner(handle)?.dataset.ok).toBe('false');
  });

  it('翻过去了、而且正在接着填下一页 → 上一页收掉，直接进「准备中」，不回主界面等用户再按', async () => {
    // 2026-09-22 负责人：点击到下一页，就是自动开始填下一页了。
    const { advance, settle } = deferredAdvance();
    const handle = mount({ label: () => 'Save and Continue', advance });
    handle.beginRun(settledRun('gesture-page-1'));
    const onDismiss = vi.fn();
    handle.showAudit!(view(), { onDismiss });
    handle.nextStepButton()?.dispatchEvent(new TrustedClick('click', { bubbles: true }));
    settle('ADVANCED_FILLING');
    await flush();
    expect(onDismiss, '上一页的审计走它自己的收场').toHaveBeenCalledTimes(1);
    expect(handle.scene()).toBe('AUTOFILL');
    expect(handle.runState()).toBe('PREPARING');
    expect(handle.fieldRows('required'), '上一页的行不留在新一页上').toEqual([]);
    expect(text(handle.sceneRoot()?.querySelector('.ticker'))).toContain('已到下一页，正在填写这一页');
    expect(toastText(handle)).toBe('已到下一页，正在填写');
    // 上一页那一轮迟到的复查不收；新一页那一轮照常接管。
    handle.update(settledRun('gesture-page-1'));
    expect(handle.fieldRows('required')).toEqual([]);
    handle.beginRun(settledRun('gesture-page-2'));
    expect(handle.runState()).toBe('SETTLED');
    expect(handle.fieldRows('required')).toHaveLength(2);
  });

  it.each([
    ['UNAVAILABLE', '此刻按不了'],
    ['UNTRUSTED', '没接到你这一下'],
  ] as const)('%s → 什么都没按，照实说', async (outcome, words) => {
    const { advance, settle } = deferredAdvance();
    const handle = mount({ label: () => 'Next', advance });
    handle.beginRun(settledRun());
    handle.nextStepButton()?.dispatchEvent(new TrustedClick('click', { bubbles: true }));
    settle(outcome);
    await flush();
    expect(handle.scene()).toBe('AUTOFILL');
    expect(toastText(handle)).toContain(words);
    expect(handle.nextStepButton()?.disabled).toBe(false);
  });

  it('调用方同步抛了异常 → 当作按不了，不卡在「正在翻页」上', async () => {
    const handle = mount({ label: () => 'Next', advance: () => { throw new Error('boom'); } });
    handle.beginRun(settledRun());
    handle.nextStepButton()?.dispatchEvent(new TrustedClick('click', { bubbles: true }));
    await flush();
    expect(handle.nextStepButton()?.disabled).toBe(false);
    expect(toastText(handle)).toContain('此刻按不了');
  });
});

/**
 * 浮层压着网站右下角的按钮（2026-09-28 测试台：Workday 底栏的 Next 整个在展开的浮层下面，要先收起浮层才按得到）。
 * 浮层自己带着这一步（「继续到下一页」替他按那一颗）；只有要他去网站上自己点的时候——按了「去网站上提交」、或者我们的
 * 「继续到下一页」此刻按不了——浮层才收起让开，并说一句去网站上点哪一颗。不量版面、不跟着页面动：他按下的那一刻收起。
 */
describe('要他去网站上自己点：浮层收起让开', () => {
  it('按了「去网站上提交」（这里替不了他按提交）→ 浮层收起，说去网站上点提交', async () => {
    const handle = mount({ label: () => null, advance: async () => 'ADVANCED' });
    handle.beginRun(settledRun());
    expect(text(handle.primaryButton())).toBe('去网站上提交');
    expect(handle.isOpen()).toBe(true);
    handle.primaryButton()?.dispatchEvent(new TrustedClick('click', { bubbles: true }));
    await flush();
    expect(handle.isOpen()).toBe(false);
    expect(toastText(handle)).toBe('检查一遍，然后在网站上点提交。');
  });

  it('按了「继续到下一页」、网站的那一颗此刻按不了 → 浮层收起，说去网站上自己点', async () => {
    const { advance, settle } = deferredAdvance();
    const handle = mount({ label: () => 'Save and Continue', advance });
    handle.beginRun(settledRun());
    handle.nextStepButton()?.dispatchEvent(new TrustedClick('click', { bubbles: true }));
    settle('UNAVAILABLE');
    await flush();
    expect(handle.isOpen()).toBe(false);
    expect(toastText(handle)).toContain('请在网站上自己点');
  });

  /**
   * 2026-09-28 测试台（adobe.wd5 第 2 页，按了「继续到下一页」）：网站翻页的那两三秒里，总结写着「必填项都填好了 · 检查一遍，
   * 没问题就可以提交了」——控制器正在按网站的「下一步」，那几秒里答不出那一颗的字，浮层就当成了最后一页。正在翻页，就是还有下一步。
   */
  it('正在替他按网站的下一步（等结论的那几秒）→ 总结不说提交', () => {
    const { advance } = deferredAdvance();
    let pressing = false;
    const handle = mount({ label: () => (pressing ? null : 'Save and Continue'), advance });
    handle.beginRun(settledRun());
    pressing = true;
    handle.nextStepButton()?.dispatchEvent(new TrustedClick('click', { bubbles: true }));
    const title = text(handle.sceneRoot()?.querySelector('.sum-title'));
    expect(title).toBe('这一页填好了');
    expect(text(handle.sceneRoot()?.querySelector('.sum-sub'))).not.toContain('提交');
  });

  it('按了没翻（网站报错）→ 浮层留着：横幅说为什么，「继续到下一页」还在', async () => {
    const { advance, settle } = deferredAdvance();
    const handle = mount({ label: () => 'Save and Continue', advance });
    handle.beginRun(settledRun());
    handle.nextStepButton()?.dispatchEvent(new TrustedClick('click', { bubbles: true }));
    settle('NOT_ADVANCED');
    await flush();
    expect(handle.isOpen()).toBe(true);
    expect(handle.nextStepButton()).not.toBeNull();
  });
});

describe('用户自己在网站上按了下一步', () => {
  it('retireRun(PAGE_CHANGED) → 回到可以点「自动填写」的样子，说页面换了一步', () => {
    const handle = mount({ label: () => 'Save and Continue', advance: async () => 'ADVANCED' });
    handle.beginRun(settledRun());
    handle.retireRun('PAGE_CHANGED');
    expect(handle.scene()).toBe('HOME');
    expect(handle.sheetState()).toBe('ABSENT');
    expect(toastText(handle)).toBe('页面已换到下一步。点「自动填写」填这一页。');
  });

  it('作废那一轮之后迟到的进度（上一页的复查）一概不收', () => {
    const handle = mount();
    handle.beginRun(settledRun('gesture-old'));
    handle.retireRun('PAGE_CHANGED');
    handle.update(settledRun('gesture-old'));
    expect(handle.sheetState()).toBe('ABSENT');
    expect(handle.fieldRows('required')).toEqual([]);
    handle.beginRun(settledRun('gesture-new'));
    expect(handle.sheetState()).toBe('AUTOFILL_EXPANDED');
    expect(handle.fieldRows('required')).toHaveLength(2);
  });

  it('翻页的结论迟到了、而这一轮已经作废 → 那句结论不画到新的一幕上', async () => {
    const { advance, settle } = deferredAdvance();
    const handle = mount({ label: () => 'Next', advance });
    handle.beginRun(settledRun());
    handle.nextStepButton()?.dispatchEvent(new TrustedClick('click', { bubbles: true }));
    handle.retireRun('PAGE_CHANGED');
    settle('NOT_ADVANCED');
    await flush();
    expect(handle.scene()).toBe('HOME');
    expect(banner(handle)).toBeNull();
  });

  it('迟到的「翻过去了」不许把新的一页上刚开始的那一轮清掉', async () => {
    const { advance, settle } = deferredAdvance();
    const handle = mount({ label: () => 'Next', advance });
    handle.beginRun(settledRun('gesture-page-1'));
    handle.nextStepButton()?.dispatchEvent(new TrustedClick('click', { bubbles: true }));
    handle.retireRun('PAGE_CHANGED');
    handle.beginRun(settledRun('gesture-page-2'));
    settle('ADVANCED');
    await flush();
    expect(handle.sheetState()).toBe('AUTOFILL_EXPANDED');
    expect(handle.fieldRows('required')).toHaveLength(2);
  });

  it('翻过去了、新的一页上没有我们认得的表（最后的检查页）→「到检查页了」，主按钮是「去网站上提交」', () => {
    const handle = mount();
    handle.beginRun(settledRun());
    handle.retireRun('ADVANCED_EMPTY');
    expect(text(handle.sceneRoot()?.querySelector('.sum-title'))).toBe('到检查页了');
    expect(text(handle.primaryButton())).toBe('去网站上提交');
  });
});
