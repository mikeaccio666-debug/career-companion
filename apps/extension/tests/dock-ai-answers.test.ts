// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';

import { mountAutofillDock, type AutofillDockFieldRow, type AutofillDockHandlers } from '../lib/autofillDock';
import type { DockAiGenerateOutcome, DockAiTools } from '../lib/dock/types';
import { AI_BADGE_POSITION, AI_EDGE_STYLE, AI_FIELD_CSS, badgeAnchorOf, railOf } from '../lib/dock/aiField';
import { EASE } from '../lib/dock/css';

/**
 * 浮层上的 AI 代答（2026-09-23）与「用 AI 写 / AI 改写」（2026-09-24 负责人）。
 *
 *  · AI 写成的那几栏单列一组「AI 代答」，写着问题与 AI 写进去的内容；总结里如实算：「已填好 N 项，其中 AI 代答 M 项」。
 *  · 起草中、次数用完各说一句；回来晚了摆一颗「填入 AI 答案」，那一下真实点击原样交给调用方。
 *  · 账户菜单里有开关（缺省开）；关掉之后网页上不再摆「用 AI 写」。
 *  · 网页上：AI 写的那一栏的左边框变蓝（标记 D）；用户自己改了那一栏就撤下。每一栏旁边的小片只看有没有字：空着是
 *    胶囊（帆船 + ArgoLand.AI），有字是圆片（只有帆船），有字的多行框落在底边上。点一下长出卡片：要求、取消、生成、
 *    这个月还能用几次；次数用完就说用完了、给一个去套餐页的链接；生成的那一下真实点击原样交给调用方；Esc 与点在
 *    外面都关卡片。
 *  · 全部在我们自己的 shadow 里，宿主的节点、值与样式一样不动。
 *
 * 夹具全是合成文字。
 */

class TrustedClick extends MouseEvent { get isTrusted() { return true; } }
class TrustedKey extends KeyboardEvent { get isTrusted() { return true; } }
class TrustedPointer extends MouseEvent { get isTrusted() { return true; } }

afterEach(() => {
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

const click = (node: Element | null | undefined) => node?.dispatchEvent(new TrustedClick('click', { bubbles: true, composed: true }));
/** 开着的卡片（收回去的那几百毫秒里它只是一个影子，不再是对话框）。 */
const openCardIn = (shadow: ShadowRoot) => shadow.querySelector<HTMLElement>('.aip[role="dialog"]');

const rect = (left: number, top: number, width: number, height: number) =>
  ({ left, top, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON: () => ({}) }) as DOMRect;

/** 宿主页上的一栏（合成），给它一个真实的盒子；外面一层很大，定位环不会往外扩。 */
function hostField(tag: 'textarea' | 'input', box = rect(40, 300, 400, 90)) {
  const wrap = document.createElement('div');
  const field = document.createElement(tag);
  wrap.append(field);
  document.body.append(wrap);
  vi.spyOn(field, 'getBoundingClientRect').mockReturnValue(box);
  vi.spyOn(wrap, 'getBoundingClientRect').mockReturnValue(rect(0, 0, 1000, 2000));
  return field as HTMLTextAreaElement & HTMLInputElement;
}

function mount(extra: Partial<AutofillDockHandlers> = {}) {
  const handle = mountAutofillDock({ kind: 'UNAVAILABLE', reason: 'NO_MISSION' }, { onAutofill: () => {}, onOpenEntry: () => {}, ...extra }, document);
  handle.openPanel();
  const shadow = handle.sceneRoot()!.getRootNode() as ShadowRoot;
  return { handle, shadow };
}

/** 负责人定了不要边、小片留在框里；留着备用的 hug 与 border 照样要测，几何测试显式指定它们。 */
const HUG_BORDER: Partial<AutofillDockHandlers> = { aiMarkStyle: { edge: 'hug', badge: 'border' } };

const row = (label: string, state: AutofillDockFieldRow['state'], extra: Partial<AutofillDockFieldRow> = {}): AutofillDockFieldRow => ({
  label, required: true, done: state === 'CONFIRMED', state, ...extra,
});

function settle(handle: ReturnType<typeof mount>['handle'], rows: readonly AutofillDockFieldRow[]): void {
  handle.beginPreparing();
  handle.beginRun({ runId: 'gesture-1', requiredQuestions: rows.length, requiredCompleted: rows.filter((one) => one.done).length, rows, phase: 'SETTLED' } as never);
}

describe('单子上的 AI 代答', () => {
  it('AI 写成的几栏单列一组、写着内容，不进「需要你」；总结如实算', () => {
    const { handle, shadow } = mount();
    settle(handle, [
      row('First Name', 'CONFIRMED', { value: 'Sample' }),
      row('Why do you want to work here?', 'CONFIRMED', { value: 'I build payment tools.', aiAnswered: true }),
      row('Do you have experience with Kotlin?', 'CONFIRMED', { value: 'Yes', aiAnswered: true }),
      row('Portfolio', 'MANUAL', { needsUser: true, reason: 'USER_ONLY' }),
    ]);
    const group = shadow.querySelector<HTMLElement>('[data-ai="group"]');
    expect(group?.style.display).toBe('block');
    expect(group?.querySelector('.grp-head')?.textContent).toBe('AI 代答2');
    expect([...shadow.querySelectorAll('[data-ai-row] .nq')].map((node) => node.textContent)).toEqual(['Why do you want to work here?', 'Do you have experience with Kotlin?']);
    expect([...shadow.querySelectorAll('[data-ai-row] .nai')].map((node) => node.textContent)).toEqual(['I build payment tools.', 'Yes']);
    expect([...shadow.querySelectorAll('[data-need-row] .need-q')].map((node) => node.textContent)).toEqual(['Portfolio']);
    expect(shadow.querySelector('.sum-sub')?.textContent).toBe('已填好 3 项，AI 写了 2 项');
  });

  it('都填好了：总结照样写明其中几项是 AI 代答的；没有 AI 的一轮总结逐字不变', () => {
    const { handle, shadow } = mount();
    settle(handle, [row('First Name', 'CONFIRMED', { value: 'Sample' }), row('Why us?', 'CONFIRMED', { value: 'Because.', aiAnswered: true })]);
    expect(shadow.querySelector('.sum-title')?.textContent).toBe('必填项都填好了');
    expect(shadow.querySelector('.sum-sub')?.textContent).toBe('已填好 2 项，其中 AI 代答 1 项。检查一遍，没问题就可以提交了。');
    settle(handle, [row('First Name', 'CONFIRMED', { value: 'Sample' })]);
    expect(shadow.querySelector('.sum-sub')?.textContent).toBe('检查一遍，没问题就可以提交了。');
    expect(shadow.querySelector<HTMLElement>('[data-ai="group"]')?.style.display).toBe('none');
  });

  it('次数用完：挂在要写的那几题上说一句（不推销，2026-09-28 起不再另起一行）；起草中那一句在进度卡上，不在总结里', () => {
    const { handle, shadow } = mount();
    settle(handle, [row('Portfolio', 'MANUAL', { needsUser: true, reason: 'USER_ONLY' })]);
    const why = () => shadow.querySelector('[data-need-row] .need-why')?.textContent;
    handle.setAiAnswers({ kind: 'USED_UP' });
    expect(why()).toBe('这个月的 AI 次数用完了，自己写几句');
    expect(shadow.querySelector('.sum-notes')?.textContent).toBe('');
    handle.setAiAnswers({ kind: 'IDLE' });
    expect(why()).toBe('开放题，用你自己的话写几句');
    // 2026-09-24：AI 在起草时这一轮还没完，那一句写在进度卡上（dock-ai-running.test.ts）；总结下面不再说。
    handle.setAiAnswers({ kind: 'DRAFTING', count: 3 });
    expect(shadow.querySelector('.sum-notes')?.textContent).toBe('');
  });

  it('回来晚了：「填入 AI 答案」把那一下真实点击原样交出去；页面伪造的点击什么都不做', async () => {
    const { handle, shadow } = mount();
    settle(handle, [row('Why us?', 'MANUAL', { needsUser: true, reason: 'USER_ONLY' })]);
    const apply = vi.fn(async (_event: MouseEvent, _root: ShadowRoot) => 2);
    handle.setAiAnswers({ kind: 'READY', count: 2, apply });
    const offer = shadow.querySelector<HTMLElement>('[data-ai="offer"]')!;
    expect(offer.style.display).toBe('grid');
    expect(offer.textContent).toContain('AI 起草好了 2 道题的答案');
    const button = offer.querySelector<HTMLButtonElement>('[data-action="ai-apply"]')!;
    expect(button.textContent).toBe('填入 AI 答案');
    button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(apply).not.toHaveBeenCalled();
    click(button);
    expect(apply).toHaveBeenCalledTimes(1);
    expect(apply.mock.calls[0]![1]).toBe(shadow);
    await Promise.resolve();
    await Promise.resolve();
    expect(offer.style.display).toBe('none');
    expect(shadow.querySelector('[data-toast]')?.textContent).toBe('AI 已代答 2 项，提交前请核对');
  });
});

describe('AI 写的那一段「换一个说法」（2026-09-28）', () => {
  it('能改写的那几栏摆「换一个说法」：那一下真点击原样交给单栏 AI 那一条路，要求写成英文、保持原来的语言；换好了说一声', async () => {
    const why = hostField('textarea');
    const kotlin = hostField('input', rect(40, 420, 400, 36));
    const { handle, shadow } = mount();
    settle(handle, [
      row('Why do you want to work here?', 'CONFIRMED', { value: 'I build payment tools.', aiAnswered: true, target: why }),
      row('Do you have experience with Kotlin?', 'CONFIRMED', { value: 'Yes', aiAnswered: true, target: kotlin }),
    ]);
    const again = () => [...shadow.querySelectorAll<HTMLButtonElement>('[data-action="ai-rephrase"]')];
    expect(again(), '没交来「用 AI 写」就不摆').toHaveLength(0);
    let finish: (outcome: DockAiGenerateOutcome) => void = () => {};
    const generate = vi.fn((_target: Element, _instruction: string, event: MouseEvent, root: ShadowRoot) => {
      expect(event.isTrusted).toBe(true);
      expect(root).toBe(shadow);
      return new Promise<DockAiGenerateOutcome>((resolve) => { finish = resolve; });
    });
    handle.setAiTools({ targets: [why], generate, quota: async () => null } as DockAiTools);
    expect(again(), '只给能改写的长文本那一栏').toHaveLength(1);
    expect(again()[0]?.textContent).toBe('换一个说法');
    again()[0]?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(generate, '页面派发的点击什么都不做').not.toHaveBeenCalled();
    click(again()[0]);
    expect(generate).toHaveBeenCalledTimes(1);
    expect(generate.mock.calls[0]?.[0]).toBe(why);
    expect(generate.mock.calls[0]?.[1]).toMatch(/^Say this differently: keep the meaning, the facts, the language/);
    expect(again()[0]?.textContent).toBe('正在换…');
    expect(again()[0]?.disabled).toBe(true);
    finish({ kind: 'WRITTEN' });
    await Promise.resolve();
    await Promise.resolve();
    expect(again()[0]?.textContent).toBe('换一个说法');
    expect(shadow.querySelector('[data-toast]')?.textContent).toBe('换好了，提交前请核对');
  });
});

describe('AI 看过、在资料里没找到依据的题', () => {
  it('「需要你」那几行与逐项处理小卡照实说 AI 没找到依据；没送给 AI 的题照旧说原来的原因', () => {
    const why = hostField('textarea');
    const hobby = hostField('input', rect(40, 420, 400, 36));
    const years = hostField('input', rect(40, 480, 400, 36));
    const { handle, shadow } = mount();
    settle(handle, [
      row('Why do you want to work here?', 'MANUAL', { needsUser: true, reason: 'USER_ONLY', target: why }),
      row('Hobbies', 'MANUAL', { needsUser: true, reason: 'LOW_CONFIDENCE', target: hobby }),
      row('Years of Kotlin', 'MANUAL', { needsUser: true, reason: 'LOW_CONFIDENCE', target: years }),
    ]);
    const reasons = () => [...shadow.querySelectorAll('[data-need-row] .need-why')].map((node) => node.textContent);
    expect(reasons()).toEqual(['开放题，用你自己的话写几句', '我们没认出这一题，你来答一下', '我们没认出这一题，你来答一下']);
    handle.setAiNoEvidence([why, years]);
    expect(reasons()).toEqual(['AI 在你的资料里没找到依据，自己写几句', '我们没认出这一题，你来答一下', 'AI 在你的资料里没找到依据']);
    // 新的一轮：清掉。
    settle(handle, [row('Why do you want to work here?', 'MANUAL', { needsUser: true, reason: 'USER_ONLY', target: why })]);
    expect(reasons()).toEqual(['开放题，用你自己的话写几句']);
  });
});

describe('送给了 AI、这一轮没拿到答案的题（2026-09-24）', () => {
  it('那几行照实说 AI 这次没答上；AI 看过没找到依据的照旧；没送给 AI 的题说原来的原因；新的一轮清掉', () => {
    const why = hostField('textarea');
    const hobby = hostField('input', rect(40, 420, 400, 36));
    const years = hostField('input', rect(40, 480, 400, 36));
    const { handle, shadow } = mount();
    settle(handle, [
      row('Why do you want to work here?', 'MANUAL', { needsUser: true, reason: 'USER_ONLY', target: why }),
      row('Hobbies', 'MANUAL', { needsUser: true, reason: 'LOW_CONFIDENCE', target: hobby }),
      row('Years of Kotlin', 'MANUAL', { needsUser: true, reason: 'LOW_CONFIDENCE', target: years }),
    ]);
    const reasons = () => [...shadow.querySelectorAll('[data-need-row] .need-why')].map((node) => node.textContent);
    handle.setAiNoEvidence([years]);
    handle.setAiUnanswered([why]);
    expect(reasons()).toEqual(['AI 这次没答上，再试一次', '我们没认出这一题，你来答一下', 'AI 在你的资料里没找到依据']);
    settle(handle, [row('Why do you want to work here?', 'MANUAL', { needsUser: true, reason: 'USER_ONLY', target: why })]);
    expect(reasons()).toEqual(['开放题，用你自己的话写几句']);
  });
});

describe('工作授权题：岗位国家知道了、资料里没有那一国的记录', () => {
  it('照实说缺的是哪一国的记录，不说「取决于这个岗位」；说不出是哪一国的照旧；AI 没找到依据也不盖过它', () => {
    const auth = hostField('input', rect(40, 300, 400, 36));
    const sponsor = hostField('input', rect(40, 360, 400, 36));
    const { handle, shadow } = mount();
    settle(handle, [
      row('Are you legally authorized to work in the country in which this role is located?', 'MANUAL', {
        needsUser: true, reason: 'JOB_DEPENDENT', regionWithoutRecord: '爱沙尼亚', target: auth,
      }),
      row('Do you require visa sponsorship?', 'MANUAL', { needsUser: true, reason: 'JOB_DEPENDENT', target: sponsor }),
    ]);
    const reasons = () => [...shadow.querySelectorAll('[data-need-row] .need-why')].map((node) => node.textContent);
    expect(reasons()).toEqual(['你的资料里没有在爱沙尼亚工作的许可记录', '答案取决于这个岗位']);
    handle.setAiNoEvidence([auth]);
    expect(reasons()[0]).toBe('你的资料里没有在爱沙尼亚工作的许可记录');
  });
});

describe('一段加了、填了、还没保存的经历（Workable 的「Update」）', () => {
  it('「需要你」里说是第几段、要点网站上的哪一颗保存', () => {
    const update = hostField('input', rect(40, 300, 80, 32));
    const { handle, shadow } = mount();
    settle(handle, [
      row('Title', 'CONFIRMED', { value: 'Data Analyst' }),
      row('Update', 'MANUAL', {
        needsUser: true, reason: 'MANUAL_ONLY', target: update,
        unsavedEntry: { collection: 'experience', number: 1, saveLabel: 'Update' },
      }),
    ]);
    const needs = [...shadow.querySelectorAll('[data-need-row]')].map((node) => [
      node.querySelector('.need-q')?.textContent, node.querySelector('.need-why')?.textContent,
    ]);
    expect(needs).toEqual([['工作经历第 1 段', '已填进网站的编辑框，点「Update」才会留下']]);
  });

  /** 2026-09-24 测试台：用户在 Workable 上按了 Update，那一段收成卡片、Update 从页面上消失，浮层却还在催他保存。 */
  it('用户在网站上按了保存、那颗保存钮从页面上消失：这一行离开「需要你」，记成「你已填好」', () => {
    const editor = document.createElement('div');
    const update = document.createElement('button');
    update.textContent = 'Update';
    editor.append(update);
    document.body.append(editor);
    const { handle, shadow } = mount();
    settle(handle, [
      row('Update', 'MANUAL', {
        needsUser: true, reason: 'MANUAL_ONLY', target: update,
        unsavedEntry: { collection: 'experience', number: 1, saveLabel: 'Update' },
      }),
    ]);
    const reason = () => shadow.querySelector('[data-need-row] .need-why')?.textContent;
    expect(reason()).toBe('已填进网站的编辑框，点「Update」才会留下');
    update.dispatchEvent(new TrustedPointer('pointerdown', { bubbles: true, composed: true }));
    editor.remove();
    document.dispatchEvent(new Event('change', { bubbles: true }));
    expect(reason()).toBeUndefined();
    expect([...shadow.querySelectorAll('.rrow')].map((node) => [node.querySelector('.rq')?.textContent, node.querySelector('.rv')?.textContent]))
      .toEqual([['工作经历第 1 段', '你已填好']]);
  });
});

/**
 * Workable 全加全存（2026-09-24 负责人）：我们替他按了「Update」、那一段留下了的，算我们填好的（在「其余已填好」里，
 * 写明「已替你按「Update」保存」），不是「你已填好」；没存上的那一段照实说还差什么；因此没加上的几段也单列一行。
 */
describe('全加全存：保存了的、没存上的、没加上的', () => {
  const restRows = (shadow: ShadowRoot) => new Map([...shadow.querySelectorAll('.rrow')].map((node) =>
    [node.querySelector('.rq')?.textContent, node.querySelector('.rv')?.textContent]));
  const needRows = (shadow: ShadowRoot) => [...shadow.querySelectorAll('[data-need-row]')].map((node) => [
    node.querySelector('.need-q')?.textContent, node.querySelector('.need-why')?.textContent,
  ]);

  it('保存了的那一段：进「其余已填好」，写着填进去的内容与「已替你按「Update」保存」；算进已填好，不进「需要你」', () => {
    const card = hostField('input');
    const { handle, shadow } = mount();
    settle(handle, [
      row('First Name', 'CONFIRMED', { value: 'Sample' }),
      row('Update', 'CONFIRMED', {
        value: 'Data Analyst · Acme', target: card,
        savedEntry: { collection: 'experience', number: 1, saveLabel: 'Update' },
      }),
      row('Update', 'CONFIRMED', {
        value: 'Example University', target: card,
        savedEntry: { collection: 'education', number: 2, saveLabel: 'Update' },
      }),
    ]);
    expect(needRows(shadow)).toEqual([]);
    const rest = restRows(shadow);
    expect(rest.get('工作经历第 1 段')).toBe('Data Analyst · Acme · 已替你按「Update」保存');
    expect(rest.get('教育经历第 2 段')).toBe('Example University · 已替你按「Update」保存');
    expect(shadow.querySelector('.sum-sub')?.textContent ?? '').not.toContain('你补上了');
  });

  it('没存上的那一段：缺必填就点名还差哪几格；网站没收下就照实说；两种都要他按「Update」', () => {
    const update = hostField('input', rect(40, 300, 80, 32));
    const other = hostField('input', rect(40, 400, 80, 32));
    const { handle, shadow } = mount();
    settle(handle, [
      row('Update', 'MANUAL', {
        needsUser: true, reason: 'NO_VALUE', target: update,
        unsavedEntry: { collection: 'experience', number: 2, saveLabel: 'Update', missing: ['Title'] },
      }),
      row('Update', 'MANUAL', {
        needsUser: true, reason: 'HOST_REJECTED', target: other,
        unsavedEntry: { collection: 'education', number: 1, saveLabel: 'Update' },
      }),
      // 编辑框里一格都认不出、一格都没写：不说「已填进编辑框」。
      row('Update', 'MANUAL', {
        needsUser: true, reason: 'NO_VALUE', target: hostField('input', rect(40, 500, 80, 32)),
        unsavedEntry: { collection: 'experience', number: 3, saveLabel: 'Update', missing: [] },
      }),
    ]);
    expect(needRows(shadow)).toEqual([
      ['工作经历第 2 段', '还差「Title」，填好后点「Update」'],
      ['教育经历第 1 段', '网站没收下这一段：看一下编辑框里的提示，改好后点「Update」'],
      ['工作经历第 3 段', '这一段没能填进编辑框，填好后点「Update」'],
    ]);
  });

  it('没加上的几段：一行说清是第几段到第几段、为什么、接下来怎么办', () => {
    const add = hostField('input', rect(40, 300, 80, 32));
    const { handle, shadow } = mount();
    settle(handle, [
      row('+ Add', 'MANUAL', {
        needsUser: true, reason: 'NO_VALUE', target: add,
        unaddedEntries: { collection: 'experience', from: 3, to: 4, afterUnsaved: true },
      }),
      row('+ Add', 'MANUAL', {
        needsUser: true, reason: 'GESTURE_EXPIRED', target: add,
        unaddedEntries: { collection: 'education', from: 2, to: 2, afterUnsaved: false },
      }),
      row('+ Add', 'MANUAL', {
        needsUser: true, reason: 'CLICK_DENIED', target: add,
        unaddedEntries: { collection: 'education', from: 1, to: 1, afterUnsaved: false },
      }),
    ]);
    expect(needRows(shadow)).toEqual([
      ['工作经历第 3–4 段', '还没加进网站：先把前面那一段保存好，再点一次自动填写'],
      ['教育经历第 2 段', '还没加进网站：再点一次自动填写，会接着加'],
      ['教育经历第 1 段', '还没加进网站：这个区在网站上还开着一段没保存，处理好之后再点一次自动填写'],
    ]);
  });
});

describe('账户菜单里的开关', () => {
  it('缺省开；点一下关掉并存下来；关掉之后网页上不再摆「用 AI 写」', async () => {
    const save = vi.fn(async (enabled: boolean) => enabled);
    const { handle, shadow } = mount({ aiAnswers: { load: async () => null, save } });
    const why = hostField('textarea');
    settle(handle, [row('Why us?', 'MANUAL', { needsUser: true, reason: 'USER_ONLY', target: why })]);
    handle.setAiTools({ targets: [why], generate: vi.fn(), quota: async () => null });
    expect(shadow.querySelector('button.aic')).not.toBeNull();

    const item = shadow.querySelector<HTMLButtonElement>('[data-action="ai-answers"]')!;
    expect(item.getAttribute('role')).toBe('switch');
    expect(item.getAttribute('aria-checked')).toBe('true');
    click(item);
    expect(save).toHaveBeenCalledWith(false);
    expect(item.getAttribute('aria-checked')).toBe('false');
    expect(shadow.querySelector('button.aic'), '关掉之后还摆着「用 AI 写」').toBeNull();
    await Promise.resolve();
    await Promise.resolve();
    expect(shadow.querySelector('[data-toast]')?.textContent).toBe('已关闭 AI 代答');
  });

  it('没接开关就没有这一项', () => {
    const { shadow } = mount();
    expect(shadow.querySelector('[data-action="ai-answers"]')).toBeNull();
  });
});

/** 给宿主控件一个假的盒子（happy-dom 没有布局；外层不给盒子就是 0×0，定位环会往外扩到它）。 */
const boxed = (node: Element, box: DOMRect): void => {
  vi.spyOn(node, 'getBoundingClientRect').mockReturnValue(box);
};

describe('网页上的标记 D', () => {
  it('负责人 2026-09-24 看过真页面后定的：不要边（none）、有字的多行框小片留在框里右下角（inside）；样子照样稿', () => {
    expect(AI_EDGE_STYLE).toBe('none');
    expect(AI_BADGE_POSITION).toBe('inside');
    // hug：这一栏自己的左边框变蓝——一圈透明的 2px 边框，只有左边是蓝的；ring：1.5px 蓝边外加 3px 淡光晕。
    expect(AI_FIELD_CSS).toContain(".aim-edge[data-edge='hug']{border:2px solid transparent;border-left-color:#2F6FEB}");
    expect(AI_FIELD_CSS).toContain(".aim-edge[data-edge='ring']{border:1.5px solid #2F6FEB;box-shadow:0 0 0 3px rgba(47,111,235,.13)}");
    // 小片：22px 高、白底、海军蓝 11px/600（浮层四档字号里的 caption），同一圈阴影；空着的胶囊左 5 右 9；ArgoLand.AI 与帆船之间 4px。
    expect(AI_FIELD_CSS).toMatch(
      /\.aic\{[^}]*height:22px;[^}]*border-radius:11px;background:#fff;color:#0A1128;\s*box-shadow:0 0 0 \.5px rgba\(10,17,40,\.2\),0 1px 3px rgba\(10,17,40,\.14\);\s*font-size:var\(--fs-caption\);font-weight:600;/,
    );
    expect(AI_FIELD_CSS).toContain(".aic[data-fill='empty']{padding:0 9px 0 5px}");
    expect(AI_FIELD_CSS).toMatch(/\.aic\[data-fill='empty'\] \.aic-word\{[^}]*opacity:1;margin-left:4px\}/);
    // 文字不再垫一块 92% 的底色。
    expect(AI_FIELD_CSS).not.toContain('--aic-bg');
  });

  it('负责人定的样子（不传覆盖）：AI 写的那一栏不画边；有字的多行框，圆片留在框里右下角', () => {
    const outer = document.createElement('div');
    const frame = document.createElement('div');
    frame.style.cssText = 'border:1px solid rgb(155, 154, 154);border-radius:8px';
    const why = document.createElement('textarea');
    why.style.cssText = 'border:1px solid transparent';
    frame.append(why);
    outer.append(frame);
    document.body.append(outer);
    boxed(outer, rect(0, 0, 1000, 2000));
    boxed(frame, rect(39, 299, 402, 92));
    boxed(why, rect(40, 300, 400, 90));
    why.value = 'I build payment tools.';
    const { handle, shadow } = mount();
    settle(handle, [row('Why us?', 'CONFIRMED', { value: 'I build payment tools.', aiAnswered: true, target: why })]);
    expect(shadow.querySelector('.aim-edge'), '不要边').toBeNull();
    const chip = shadow.querySelector<HTMLElement>('.aic')!;
    expect(chip.dataset.fill, '有字：只有帆船的圆片').toBe('filled');
    expect(chip.dataset.place, '留在框里，不落到底边上').toBe('inside');
  });

  it('AI 写的那一栏：边与看得见的那一格同一个矩形、同样的圆角（边框画在外层就量外层）；有字是圆片，圆心落在底边上；宿主节点一个都没动', () => {
    // Workable 的样子：输入框自己的边是透明的，边框画在外面第二层 div 上，四周大 1px。
    const outer = document.createElement('div');
    const frame = document.createElement('div');
    frame.style.cssText = 'border:1px solid rgb(155, 154, 154);border-radius:8px';
    const inner = document.createElement('div');
    const why = document.createElement('textarea');
    why.style.cssText = 'border:1px solid transparent';
    inner.append(why);
    frame.append(inner);
    outer.append(frame);
    document.body.append(outer);
    boxed(outer, rect(0, 0, 1000, 2000));
    boxed(frame, rect(39, 299, 402, 92));
    boxed(inner, rect(40, 300, 400, 90));
    boxed(why, rect(40, 300, 400, 90));
    why.value = 'I build payment tools.';
    const before = document.body.innerHTML;
    const { handle, shadow } = mount(HUG_BORDER);
    settle(handle, [row('Why us?', 'CONFIRMED', { value: 'I build payment tools.', aiAnswered: true, target: why })]);
    const edge = shadow.querySelector<HTMLElement>('.aim-edge')!;
    expect(edge.dataset.edge).toBe('hug');
    expect(edge.style.display).toBe('block');
    expect([edge.style.left, edge.style.top, edge.style.width, edge.style.height, edge.style.borderRadius]).toEqual(['39px', '299px', '402px', '92px', '8px']);
    const chip = shadow.querySelector<HTMLElement>('.aic')!;
    expect(chip.dataset.fill, '有字：只有帆船的圆片').toBe('filled');
    expect(chip.querySelector('img')).not.toBeNull();
    // 圆心在底边上（391），右边离框 16px（441 − 16）。
    expect([chip.dataset.place, chip.style.left, chip.style.top]).toEqual(['border', '425px', '391px']);
    // 宿主页上只多了我们那一个宿主节点，别的一个字没改。
    expect(document.body.innerHTML.replace(/<div id="edaix-autofill-dock"><\/div>/, '')).toBe(before);
  });

  it('小片落在哪：多行框空着在框里右下角（让开滚动条或把手），有字按 AI_BADGE_POSITION 落在底边上或留在框里；单行框右边 8px 居中；选择题框外右边 8px 居中', () => {
    const box = { left: 40, top: 300, right: 440, bottom: 390 };
    // 右边让 7 + 15（滚动条），下边让 7；锚点是小片的右边与上下中线。
    expect(badgeAnchorOf('multi', box, false, 15, 'border')).toEqual({ x: 418, y: 372, place: 'inside' });
    expect(badgeAnchorOf('multi', box, true, 15, 'border')).toEqual({ x: 424, y: 390, place: 'border' });
    expect(badgeAnchorOf('multi', box, true, 15, 'inside')).toEqual({ x: 418, y: 372, place: 'inside' });
    expect(badgeAnchorOf('multi', box, false, 16, 'inside')).toEqual({ x: 417, y: 372, place: 'inside' });
    expect(badgeAnchorOf('single', box, true, 0, 'border')).toEqual({ x: 432, y: 345, place: 'inside' });
    expect(badgeAnchorOf('single', box, false, 0, 'border')).toEqual({ x: 432, y: 345, place: 'inside' });
    expect(badgeAnchorOf('outside', box, true, 0, 'border')).toEqual({ x: 448, y: 345, place: 'outside' });
  });

  it('多行框右边让开多少：竖向滚动条多宽就让多宽；没有滚动条、能拖动大小时让 16px；都没有就不让', () => {
    const area = (style: string, offset: number, client: number) => {
      const node = document.createElement('textarea');
      node.style.cssText = style;
      document.body.append(node);
      Object.defineProperty(node, 'offsetWidth', { configurable: true, get: () => offset });
      Object.defineProperty(node, 'clientWidth', { configurable: true, get: () => client });
      return node;
    };
    expect(railOf(area('resize:none', 400, 385))).toBe(15);
    expect(railOf(area('resize:vertical', 400, 385)), '有滚动条时把手在滚动条底下').toBe(15);
    expect(railOf(area('resize:vertical', 400, 400))).toBe(16);
    expect(railOf(area('resize:none', 400, 400))).toBe(0);
  });

  it('选择题（单选、ARIA 是非按钮、下拉）：圆片在全部选项的外侧右边、上下居中，不压在选项上；边圈住全部选项', () => {
    document.body.innerHTML = `
      <form>
        <fieldset id="kotlin-q"><legend>Do you have experience with Kotlin?</legend>
          <label id="yes-l"><input type="radio" name="kotlin" id="yes" checked> Yes</label>
          <label id="no-l"><input type="radio" name="kotlin" id="no"> No</label>
        </fieldset>
        <div id="pair"><button type="button" aria-pressed="true" id="ash-yes" style="border-radius:10px 0 0 10px">Yes</button><button type="button" aria-pressed="false" id="ash-no" style="border-radius:0 10px 10px 0">No</button></div>
        <select id="mode"><option value="">Select</option><option value="r" selected>Remote</option></select>
      </form>`;
    boxed(document.getElementById('yes-l')!, rect(40, 300, 120, 24));
    boxed(document.getElementById('no-l')!, rect(40, 330, 120, 24));
    boxed(document.getElementById('yes')!, rect(40, 304, 16, 16));
    boxed(document.getElementById('no')!, rect(40, 334, 16, 16));
    boxed(document.getElementById('kotlin-q')!, rect(30, 280, 700, 90));
    boxed(document.getElementById('ash-yes')!, rect(40, 400, 80, 36));
    boxed(document.getElementById('ash-no')!, rect(128, 400, 80, 36));
    boxed(document.getElementById('pair')!, rect(40, 400, 168, 36));
    boxed(document.getElementById('mode')!, rect(40, 460, 300, 36));
    boxed(document.querySelector('form')!, rect(0, 0, 1000, 2000));
    const { handle, shadow } = mount(HUG_BORDER);
    settle(handle, [
      row('Do you have experience with Kotlin?', 'CONFIRMED', { value: 'Yes', aiAnswered: true, target: document.getElementById('yes')! }),
      row('Contributed to a mobile app?', 'CONFIRMED', { value: 'Yes', aiAnswered: true, target: document.getElementById('ash-yes')! }),
      row('Work mode', 'CONFIRMED', { value: 'Remote', aiAnswered: true, target: document.getElementById('mode')! }),
    ]);
    const chips = [...shadow.querySelectorAll<HTMLElement>('.aic')];
    expect(chips).toHaveLength(3);
    for (const chip of chips) {
      expect(chip.dataset.place).toBe('outside');
      expect(chip.dataset.fill, '选好了：圆片').toBe('filled');
    }
    const [radio, pair, select] = chips;
    // 单选：两项标签的外接框是 40..160 × 300..354，圆片在右边 +8、上下居中。
    expect([radio!.style.left, radio!.style.top]).toEqual(['168px', '327px']);
    // 是非按钮：两颗按钮的外接框是 40..208 × 400..436——圆片不压在选中的深色按钮上。
    expect([pair!.style.left, pair!.style.top]).toEqual(['216px', '418px']);
    expect([select!.style.left, select!.style.top]).toEqual(['348px', '478px']);
    const edges = [...shadow.querySelectorAll<HTMLElement>('.aim-edge')];
    expect(edges).toHaveLength(3);
    // 外面没有带边的框：边圈住全部选项；圆角左边照第一颗按钮、右边照最后一颗（Ashby 的是非按钮）。
    expect([edges[0]!.style.left, edges[0]!.style.top, edges[0]!.style.width, edges[0]!.style.height]).toEqual(['40px', '300px', '120px', '54px']);
    expect([edges[1]!.style.left, edges[1]!.style.width, edges[1]!.style.borderRadius]).toEqual(['40px', '168px', '10px']);
  });

  it('选项外面有一层带边的框正好包住它们（Workable 的 YES/NO）：边与圆片都量那一层', () => {
    document.body.innerHTML = `
      <div id="page"><fieldset id="grp" role="radiogroup" style="border:1px solid rgb(216, 215, 215);border-radius:8px">
        <div id="o-yes"><label id="l-yes"><input type="radio" name="x" id="x-yes"> YES</label></div>
        <div id="o-no"><label id="l-no"><input type="radio" name="x" id="x-no" checked> NO</label></div>
      </fieldset></div>`;
    boxed(document.getElementById('page')!, rect(0, 0, 1000, 2000));
    boxed(document.getElementById('grp')!, rect(394, 300, 124, 40));
    boxed(document.getElementById('o-yes')!, rect(399, 305, 53, 30));
    boxed(document.getElementById('o-no')!, rect(459, 305, 54, 30));
    boxed(document.getElementById('l-yes')!, rect(400, 306, 51, 28));
    boxed(document.getElementById('l-no')!, rect(460, 306, 52, 28));
    boxed(document.getElementById('x-yes')!, rect(400, 306, 13, 13));
    boxed(document.getElementById('x-no')!, rect(460, 306, 13, 13));
    const { handle, shadow } = mount(HUG_BORDER);
    settle(handle, [row('At least 3 years?', 'CONFIRMED', { value: 'NO', aiAnswered: true, target: document.getElementById('x-no')! })]);
    const edge = shadow.querySelector<HTMLElement>('.aim-edge')!;
    expect([edge.style.left, edge.style.top, edge.style.width, edge.style.height, edge.style.borderRadius]).toEqual(['394px', '300px', '124px', '40px', '8px']);
    const chip = shadow.querySelector<HTMLElement>('.aic')!;
    expect([chip.dataset.place, chip.style.left, chip.style.top]).toEqual(['outside', '526px', '320px']);
  });

  it('选择题右边放不下 22px 的圆片就不放（边照样在）', () => {
    document.body.innerHTML = `<div id="wide"><label id="a-l"><input type="radio" name="a" id="a1" checked> A</label><label id="b-l"><input type="radio" name="a" id="a2"> B</label></div>`;
    boxed(document.getElementById('a-l')!, rect(40, 300, 940, 24));
    boxed(document.getElementById('b-l')!, rect(40, 330, 940, 24));
    boxed(document.getElementById('wide')!, rect(0, 0, 1024, 2000));
    const { handle, shadow } = mount(HUG_BORDER);
    const target = document.getElementById('a1')!;
    settle(handle, [row('A or B?', 'CONFIRMED', { value: 'A', aiAnswered: true, target })]);
    const chip = shadow.querySelector<HTMLElement>('.aic')!;
    // 视口 1024 宽：圆片从 988 摆到 1010，放得下。
    expect(chip.style.display).toBe('inline-flex');
    boxed(document.getElementById('a-l')!, rect(40, 300, 975, 24));
    boxed(document.getElementById('b-l')!, rect(40, 330, 975, 24));
    window.dispatchEvent(new Event('resize'));
    expect(chip.style.display).toBe('none');
    expect(shadow.querySelector<HTMLElement>('.aim-edge')?.style.display).toBe('block');
  });

  it('用户自己改了那一栏：撤下标记；撤销这一轮：全部撤下', () => {
    const why = hostField('textarea');
    why.value = 'I build payment tools.';
    const kotlin = hostField('input', rect(40, 420, 400, 36));
    kotlin.value = '5';
    const { handle, shadow } = mount(HUG_BORDER);
    settle(handle, [
      row('Why us?', 'CONFIRMED', { value: 'I build payment tools.', aiAnswered: true, target: why }),
      row('Kotlin years', 'CONFIRMED', { value: '5', aiAnswered: true, target: kotlin }),
    ]);
    expect(shadow.querySelectorAll('.aim-edge')).toHaveLength(2);
    why.value = 'My own words';
    why.dispatchEvent(new Event('input', { bubbles: true }));
    expect(shadow.querySelectorAll('.aim-edge')).toHaveLength(1);
    expect(shadow.querySelectorAll('.aic')).toHaveLength(1);
    handle.beginPreparing();
    expect(shadow.querySelectorAll('.aim-edge, .aic')).toHaveLength(0);
  });
});

describe('「用 AI 写 / AI 改写」', () => {
  function withTools(generate: DockAiTools['generate'], quota: DockAiTools['quota'] = async () => ({ unlimited: false, remaining: 7 }), extra: Partial<AutofillDockHandlers> = {}) {
    const why = hostField('textarea');
    const mounted = mount(extra);
    settle(mounted.handle, [row('Why do you want to work here?', 'MANUAL', { needsUser: true, reason: 'USER_ONLY', target: why })]);
    mounted.handle.setAiTools({ targets: [why], generate, quota });
    const chip = mounted.shadow.querySelector<HTMLButtonElement>('button.aic')!;
    return { ...mounted, why, chip };
  }
  const flush = async () => { for (let i = 0; i < 4; i += 1) await Promise.resolve(); };

  it('悬停、键盘聚焦只往左长：露出「用 AI 写 / AI 改写」，帆船与 ArgoLand.AI 都不收（2026-09-24 测试台：从前字标收起、小片反而变窄）', () => {
    // happy-dom 没有 :hover；真指针（Playwright → CDP 鼠标）在测试台上量过宽度只长不缩、右边不动。
    // 这里钉住样式本身：悬停把动词展开到量好的宽，没有任何一条悬停规则把 ArgoLand.AI 收到 0。
    expect(AI_FIELD_CSS).toMatch(/button\.aic:hover \.aic-verb[^{]*\{[^}]*max-width:var\(--w,64px\);opacity:1;margin-right:4px/);
    expect(AI_FIELD_CSS).toMatch(/button\.aic:focus-visible \.aic-verb/);
    expect(AI_FIELD_CSS).not.toMatch(/:hover[^{]*\.aic-word[^{]*\{[^}]*max-width:0/);
    // 宽度 240ms 按浮层的缓动，文字透明度 160ms。
    expect(AI_FIELD_CSS).toMatch(/\.aic-t\{[^}]*transition:max-width \.24s var\(--argo-ease\),margin \.24s var\(--argo-ease\),opacity \.16s ease\}/);
    // 锚在右边与上下中线、往左长（translate(-100%,-50%)）；可以点、可以悬停（pointer-events:auto）。
    expect(AI_FIELD_CSS).toMatch(/\.aic\{[^}]*transform:translate\(-100%,-50%\)[^}]*pointer-events:auto/);
  });

  it('空着的长文本题：胶囊（帆船 + ArgoLand.AI）在框里右下角、让开滚动条，读屏念「用 AI 写这一题」', () => {
    const { chip } = withTools(vi.fn());
    expect(chip.dataset.fill).toBe('empty');
    expect(chip.querySelector('.aic-word')?.textContent).toBe('Career Companion');
    expect(chip.querySelector('.aic-verb')?.textContent).toBe('用 AI 写');
    expect(chip.getAttribute('aria-label')).toBe('用 AI 写这一题');
    expect(chip.getAttribute('aria-haspopup')).toBe('dialog');
    // 框的右边 440 − 7，下边 390 − 7 − 11（锚点是小片的右边与上下中线）。
    expect([chip.dataset.place, chip.style.left, chip.style.top]).toEqual(['inside', '433px', '372px']);
  });

  it('打了字：同一枚胶囊缩成圆片，从框里滑到底边上（240ms、浮层的缓动），改说「AI 改写」；清空又长回胶囊、滑回框里', () => {
    const why = hostField('textarea');
    // 有竖向滚动条：offsetWidth 比 clientWidth 多出 15px。
    Object.defineProperty(why, 'offsetWidth', { configurable: true, get: () => 400 });
    Object.defineProperty(why, 'clientWidth', { configurable: true, get: () => 385 });
    const { handle, shadow } = mount(HUG_BORDER);
    settle(handle, [row('Why do you want to work here?', 'MANUAL', { needsUser: true, reason: 'USER_ONLY', target: why })]);
    handle.setAiTools({ targets: [why], generate: vi.fn(), quota: async () => null });
    const chip = shadow.querySelector<HTMLButtonElement>('button.aic')!;
    expect([chip.dataset.fill, chip.dataset.place, chip.style.left, chip.style.top]).toEqual(['empty', 'inside', '418px', '372px']);
    const slide = vi.fn((_keyframes: Keyframe[], _options: KeyframeAnimationOptions) => null);
    Object.defineProperty(chip, 'animate', { configurable: true, value: slide });

    why.value = 'Draft';
    why.dispatchEvent(new Event('input', { bubbles: true }));
    expect(shadow.querySelector('button.aic'), '同一枚，不换节点（CSS 才能把胶囊缩成圆片）').toBe(chip);
    expect([chip.dataset.fill, chip.dataset.place, chip.style.left, chip.style.top]).toEqual(['filled', 'border', '424px', '390px']);
    expect(chip.getAttribute('aria-label')).toBe('用 AI 改写这一题');
    expect(chip.querySelector('.aic-verb')?.textContent).toBe('AI 改写');
    expect(slide).toHaveBeenCalledWith([{ translate: '-6px -18px' }, { translate: '0px 0px' }], { duration: 240, easing: EASE });

    why.value = '';
    why.dispatchEvent(new Event('input', { bubbles: true }));
    expect([chip.dataset.fill, chip.dataset.place, chip.style.left, chip.style.top]).toEqual(['empty', 'inside', '418px', '372px']);
    expect(slide).toHaveBeenCalledTimes(2);
    expect(slide.mock.calls[1]![0]).toEqual([{ translate: '6px 18px' }, { translate: '0px 0px' }]);
  });

  it('系统要求减少动态：直接换，不滑', () => {
    vi.spyOn(window, 'matchMedia').mockImplementation((query: string) => ({ matches: /reduce/.test(query), media: query }) as MediaQueryList);
    const { chip, why } = withTools(vi.fn(), undefined, HUG_BORDER);
    const slide = vi.fn((_keyframes: Keyframe[], _options: KeyframeAnimationOptions) => null);
    Object.defineProperty(chip, 'animate', { configurable: true, value: slide });
    why.value = 'Draft';
    why.dispatchEvent(new Event('input', { bubbles: true }));
    expect(chip.dataset.place).toBe('border');
    expect(slide).not.toHaveBeenCalled();
  });

  it('点一下长出卡片：要求、取消、生成、这个月还能用几次；焦点进输入框', async () => {
    const { chip, shadow } = withTools(vi.fn());
    click(chip);
    const card = openCardIn(shadow)!;
    expect(card.getAttribute('role')).toBe('dialog');
    expect(chip.getAttribute('aria-expanded')).toBe('true');
    const title = shadow.getElementById(card.getAttribute('aria-labelledby')!);
    expect(title?.textContent).toBe('用 AI 写这一题');
    const textarea = card.querySelector<HTMLTextAreaElement>('textarea')!;
    expect(textarea.placeholder).toBe('告诉我你想补充、修改或改进什么');
    expect(shadow.activeElement).toBe(textarea);
    expect(card.querySelector('[data-action="ai-cancel"]')?.textContent).toBe('取消');
    expect(card.querySelector('[data-action="ai-generate"]')?.textContent).toBe('生成');
    await flush();
    expect(card.querySelector('.aip-quota')?.textContent).toBe('本月还可以用 7 次');
  });

  it('卡片按排版高度摆：打开动画当中回来的次数重摆时，量到的外框只有小片那么高，卡片也不挪到小片上（2026-09-24 测试台）', async () => {
    const { chip, shadow } = withTools(vi.fn());
    // 宿主那一栏的盒子已经各自钉好；这里只改卡片与小片量到的外框。
    const original = HTMLElement.prototype.getBoundingClientRect;
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      // 从小片长出来的那几百毫秒：卡片的外框按变换缩着，只有 23px 高。
      if (this.classList.contains('aip')) return rect(0, 0, 312, 23);
      if (this.classList.contains('aic')) return rect(411, 361, 22, 22);
      return original.call(this);
    });
    vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(function (this: HTMLElement) {
      return this.classList.contains('aip') ? 160 : 0;
    });
    click(chip);
    await flush();
    // 卡片在小片上方：361 − 10 − 160（不是 361 − 10 − 23，那样就盖在小片上了）。
    expect(openCardIn(shadow)!.style.top).toBe('191px');
    expect(openCardIn(shadow)!.dataset.side).toBe('above');
  });

  it('会员不限次数：不写那一行', async () => {
    const { chip, shadow } = withTools(vi.fn(), async () => ({ unlimited: true, remaining: null }));
    click(chip);
    await flush();
    expect(openCardIn(shadow)!.querySelector('.aip-quota')?.textContent).toBe('');
  });

  it('按「生成」：那一下真实点击与要求原样交出去；写成了就收起卡片', async () => {
    let finish: (outcome: DockAiGenerateOutcome) => void = () => {};
    const generate = vi.fn((..._args: Parameters<DockAiTools['generate']>) => new Promise<DockAiGenerateOutcome>((resolve) => { finish = resolve; }));
    const { chip, why, shadow } = withTools(generate);
    click(chip);
    const card = openCardIn(shadow)!;
    card.querySelector<HTMLTextAreaElement>('textarea')!.value = '  Mention my payments work  ';
    const go = card.querySelector<HTMLButtonElement>('[data-action="ai-generate"]')!;
    go.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(generate, '页面伪造的点击不能生成').not.toHaveBeenCalled();
    click(go);
    expect(generate).toHaveBeenCalledTimes(1);
    const [target, instruction, event, root, wanted] = generate.mock.calls[0]!;
    expect(target).toBe(why);
    expect(instruction).toBe('Mention my payments work');
    expect(event.isTrusted).toBe(true);
    expect(root).toBe(shadow);
    expect(wanted()).toBe(true);
    // 生成中：输入框与按钮都停住；不要边，那一栏的小片上帆船一跳一跳。
    expect(card.querySelector<HTMLTextAreaElement>('textarea')!.disabled).toBe(true);
    expect(go.disabled).toBe(true);
    expect(go.textContent).toBe('生成中…');
    expect(shadow.querySelector('.aim-edge')).toBeNull();
    expect(chip.dataset.busy).toBe('true');
    expect(AI_FIELD_CSS).toContain(".aic[data-busy='true'] img{animation:aLinePulse 1.1s ease-in-out infinite}");
    finish({ kind: 'WRITTEN' });
    await flush();
    expect(openCardIn(shadow)).toBeNull();
    expect(shadow.querySelector('[data-toast]')?.textContent).toBe('已写进这一栏，提交前请核对');
  });

  it('资料不够、暂时用不了：卡片里一句人话；超时写好了没写进去：按钮换成「填入」，再点一下交出新的那一下', async () => {
    const confirm = vi.fn(async (): Promise<DockAiGenerateOutcome> => ({ kind: 'WRITTEN' }));
    const generate = vi.fn<DockAiTools['generate']>()
      .mockResolvedValueOnce({ kind: 'NOTHING_TO_WRITE' })
      .mockResolvedValueOnce({ kind: 'FAILED', reason: 'UNAVAILABLE' })
      .mockResolvedValueOnce({ kind: 'EXPIRED', confirm });
    const { chip, shadow } = withTools(generate);
    click(chip);
    const card = openCardIn(shadow)!;
    const go = () => card.querySelector<HTMLButtonElement>('[data-action="ai-generate"]')!;
    click(go());
    await flush();
    // 服务端答了空字符串（资料里依据不够）：照实说，什么都不写。
    expect(card.querySelector('.aip-msg')?.textContent).toBe('AI 在你的资料里没找到依据');
    click(go());
    await flush();
    expect(card.querySelector('.aip-msg')?.textContent).toBe('暂时用不了，稍后再试');
    click(go());
    await flush();
    expect(card.querySelector('.aip-msg')?.textContent).toBe('写好了，点「填入」把它写进这一栏');
    expect(go().textContent).toBe('填入');
    click(go());
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(confirm.mock.calls[0]).toHaveLength(2);
  });

  /** 恢复那一天在用户本地是几月几日（测试不依赖机器的时区）。 */
  const RESETS = '2026-10-01T00:00:00.000Z';
  const resetDay = () => { const date = new Date(RESETS); return `${date.getMonth() + 1} 月 ${date.getDate()} 日恢复`; };

  it('次数用完：卡片里说这个月用完了、哪天恢复，给「升级会员」（去门户的套餐页），没有能按的「生成」', async () => {
    const opened: string[] = [];
    const { chip, shadow } = withTools(vi.fn(), async () => ({ unlimited: false, remaining: 0, resetsAt: RESETS }), { onOpenPortal: (page) => opened.push(page) });
    click(chip);
    await flush();
    const card = openCardIn(shadow)!;
    expect(card.querySelector<HTMLElement>('.aip-used')?.style.display).toBe('flex');
    expect(card.querySelector('.aip-used span')?.textContent).toBe(`本月的 AI 次数用完了，${resetDay()}`);
    expect(card.querySelector<HTMLElement>('[data-action="ai-upgrade"]')?.style.display).toBe('');
    expect(card.querySelector<HTMLElement>('[data-action="ai-generate"]')?.style.display).toBe('none');
    click(card.querySelector('[data-action="ai-upgrade"]'));
    expect(opened).toEqual(['PRICING']);
  });

  it('生成时服务端说次数用完：卡片换成用完了的样子，再问一次次数好说哪天恢复', async () => {
    const quota = vi.fn<DockAiTools['quota']>()
      .mockResolvedValueOnce({ unlimited: false, remaining: 1, resetsAt: RESETS })
      .mockResolvedValueOnce({ unlimited: false, remaining: 0, resetsAt: RESETS });
    const { chip, shadow } = withTools(vi.fn(async (): Promise<DockAiGenerateOutcome> => ({ kind: 'USED_UP' })), quota);
    click(chip);
    await flush();
    const card = openCardIn(shadow)!;
    expect(card.querySelector('.aip-quota')?.textContent).toBe('本月还可以用 1 次');
    click(card.querySelector('[data-action="ai-generate"]'));
    await flush();
    expect(quota).toHaveBeenCalledTimes(2);
    expect(card.querySelector<HTMLElement>('.aip-used')?.style.display).toBe('flex');
    expect(card.querySelector('.aip-used span')?.textContent).toBe(`本月的 AI 次数用完了，${resetDay()}`);
    expect(card.querySelector<HTMLElement>('[data-action="ai-generate"]')?.style.display).toBe('none');
  });

  it('次数取不到时用完了照样说用完了（不写日期）；会员不摆「升级会员」', async () => {
    const usedUp = withTools(vi.fn(async (): Promise<DockAiGenerateOutcome> => ({ kind: 'USED_UP' })), async () => null);
    click(usedUp.chip);
    click(openCardIn(usedUp.shadow)!.querySelector('[data-action="ai-generate"]'));
    await flush();
    expect(openCardIn(usedUp.shadow)!.querySelector('.aip-used span')?.textContent).toBe('本月的 AI 次数用完了');
    document.body.innerHTML = '';
    const member = withTools(vi.fn(async (): Promise<DockAiGenerateOutcome> => ({ kind: 'USED_UP' })), async () => ({ unlimited: true, remaining: null, resetsAt: null }));
    click(member.chip);
    click(openCardIn(member.shadow)!.querySelector('[data-action="ai-generate"]'));
    await flush();
    expect(openCardIn(member.shadow)!.querySelector<HTMLElement>('[data-action="ai-upgrade"]')?.style.display).toBe('none');
  });

  it('Esc、取消、点在外面都关卡片；关上之后焦点回到小片；卡片关了才回来的结果不写（wanted 为假）', async () => {
    let finish: (outcome: DockAiGenerateOutcome) => void = () => {};
    const generate = vi.fn((..._args: Parameters<DockAiTools['generate']>) => new Promise<DockAiGenerateOutcome>((resolve) => { finish = resolve; }));
    const { chip, shadow } = withTools(generate);
    click(chip);
    openCardIn(shadow)!.querySelector('textarea')!.dispatchEvent(new TrustedKey('keydown', { key: 'Escape', bubbles: true, composed: true }));
    expect(openCardIn(shadow)).toBeNull();
    expect(chip.getAttribute('aria-expanded')).toBe('false');
    expect(shadow.activeElement).toBe(chip);

    click(chip);
    click(openCardIn(shadow)!.querySelector('[data-action="ai-cancel"]'));
    expect(openCardIn(shadow)).toBeNull();

    click(chip);
    click(openCardIn(shadow)!.querySelector('[data-action="ai-generate"]'));
    const wanted = generate.mock.calls[0]![4];
    document.body.dispatchEvent(new TrustedPointer('pointerdown', { bubbles: true, composed: true }));
    expect(openCardIn(shadow)).toBeNull();
    expect(wanted()).toBe(false);
    finish({ kind: 'FAILED', reason: 'CANCELLED' });
    await flush();
  });
});
