// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';

import { mountAutofillDock, type AutofillDockFieldRow, type AutofillDockHandlers } from '../lib/autofillDock';
import type { DockAnswers, DockAnswerOutcome, DockAiTools } from '../lib/dock/types';

/**
 * 「需要你」按他要做的事分组，而且在浮层里就能办完（2026-09-28 负责人：用户要做的越少越好，像苹果的产品一样安静、清楚、顺）。
 *
 *  · 选一个：选项对不上、说不准的选择题——摆页面上最接近他资料的真实选项（最多三个），点一下就经内核写上；「更多选项」去那一栏。
 *  · 写一段：没填的开放题——「AI 帮我写」一下写进去（单栏 AI 那一条路）。
 *  · 资料里没有：当场问一次（小输入框或几个选项），写上网页；记进答案记忆（总开关管着，不另问）。
 *  · 你来决定：按规定留给他本人的——「去这一栏」。
 *  · 去网页上看一眼：别的没填上的——「去这一栏」。
 *  每一行一个明摆着的动作；页面上办好了，那一行就离开列表。
 *
 * 夹具全是合成文字（虚构的 Alex Chen）。
 */
class TrustedClick extends MouseEvent { get isTrusted() { return true; } }
class TrustedKey extends KeyboardEvent { get isTrusted() { return true; } }

afterEach(() => {
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

const click = (node: Element | null | undefined) => node?.dispatchEvent(new TrustedClick('click', { bubbles: true, composed: true }));
const text = (node: Element | null | undefined) => node?.textContent ?? null;

function field<K extends 'input' | 'select' | 'textarea'>(tag: K, id: string, options: readonly string[] = []): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.id = id;
  if (node instanceof HTMLSelectElement) {
    for (const [label, value] of [['Select...', ''], ...options.map((option) => [option, option])] as const) {
      const option = document.createElement('option');
      option.textContent = label;
      option.value = value;
      node.append(option);
    }
  }
  document.body.append(node);
  return node;
}

function page() {
  return {
    first: field('input', 'first'),
    school: field('select', 'school', ['Stanford University', 'University of California, Berkeley', 'UC Berkeley Extension', 'University of Washington', 'Other']),
    why: field('textarea', 'why'),
    start: field('input', 'start'),
    hear: field('select', 'hear', ['LinkedIn', 'Company website', 'Referral', 'Other']),
    hispanic: field('select', 'hispanic', ['Yes', 'No', 'Decline to self-identify']),
    phone: field('input', 'phone'),
  };
}

function rowsFor(p: ReturnType<typeof page>): AutofillDockFieldRow[] {
  return [
    { label: 'First Name', required: true, done: true, state: 'CONFIRMED', value: 'Alex', target: p.first, planned: true },
    { label: 'School', required: true, done: false, state: 'FAILED', reason: 'NO_OPTION_MATCH', hint: 'UC Berkeley', target: p.school, planned: true },
    { label: 'Why Acme?', required: true, done: false, state: 'MANUAL', needsUser: true, reason: 'USER_ONLY', target: p.why, planned: true },
    { label: 'Earliest start date', required: true, done: false, state: 'MANUAL', needsUser: true, reason: 'NO_VALUE', target: p.start, planned: true },
    { label: 'How did you hear about us?', required: true, done: false, state: 'MANUAL', needsUser: true, reason: 'CHOICE_NO_DATA', target: p.hear, planned: true },
    { label: 'Are you Hispanic/Latino?', required: true, done: false, state: 'MANUAL', needsUser: true, reason: 'MANUAL_ONLY', target: p.hispanic, planned: true },
    { label: 'Phone', required: true, done: false, state: 'FAILED', reason: 'HOST_REJECTED', target: p.phone, planned: true },
  ];
}

/** 调用方那一侧的桩：选择题交页面上的真实选项，文本框交题型；写成了把那一栏换成「他答的」再交回来。 */
function answersFor(onAnswer: (target: Element, value: string, remember: boolean) => DockAnswerOutcome = () => ({ ok: true })) {
  const calls: Array<{ target: Element; value: string; trusted: boolean; remember: boolean }> = [];
  const answers: DockAnswers = {
    question: (target) => {
      if (target instanceof HTMLSelectElement) return { kind: 'choice', options: [...target.options].filter((option) => option.value !== '').map((option) => option.text), suggested: null };
      if (target instanceof HTMLTextAreaElement) return { kind: 'long', options: [], suggested: null };
      if (target instanceof HTMLInputElement) return { kind: 'text', options: [], suggested: null };
      return null;
    },
    answer: (target, value, event, _shadow, remember) => {
      calls.push({ target, value, trusted: event.isTrusted, remember });
      return Promise.resolve(onAnswer(target, value, remember));
    },
  };
  return { answers, calls };
}

function mount(extra: Partial<AutofillDockHandlers> = {}) {
  const handle = mountAutofillDock({ kind: 'UNAVAILABLE', reason: 'NO_MISSION' }, { onAutofill: () => {}, onOpenEntry: () => {}, ...extra }, document);
  handle.openPanel();
  const shadow = handle.sceneRoot()!.getRootNode() as ShadowRoot;
  return { handle, shadow };
}

function settle(handle: ReturnType<typeof mount>['handle'], rows: readonly AutofillDockFieldRow[], answers?: DockAnswers) {
  handle.beginPreparing();
  handle.beginRun({ runId: 'gesture-1', requiredQuestions: rows.length, requiredCompleted: rows.filter((one) => one.done).length, rows, phase: 'SETTLED' } as never);
  handle.showAudit?.({ rows: [{}] } as never, { canUndo: () => false, ...(answers === undefined ? {} : { answers }) } as never);
}

const groupOf = (shadow: ShadowRoot, kind: string) => shadow.querySelector<HTMLElement>(`[data-need-group="${kind}"]`);
const rowIn = (shadow: ShadowRoot, label: string) =>
  [...shadow.querySelectorAll<HTMLElement>('[data-need-row]')].find((node) => node.querySelector('.need-q')?.textContent === label) ?? null;

describe('「需要你」按要做的事分组', () => {
  it('五组依次排好，每一行说一句能照着做的话（行上没有编号：网页上不再有要对上的标记）', () => {
    const p = page();
    const { handle, shadow } = mount();
    settle(handle, rowsFor(p), answersFor().answers);
    const groups = [...shadow.querySelectorAll<HTMLElement>('[data-need-group]')].filter((node) => node.style.display !== 'none');
    expect(groups.map((node) => node.dataset.needGroup)).toEqual(['choose', 'write', 'missing', 'decide', 'check']);
    expect(text(groupOf(shadow, 'choose')?.querySelector('.grp-head span'))).toBe('选一个');
    expect(text(groupOf(shadow, 'write')?.querySelector('.grp-head span'))).toBe('写一段');
    expect(text(groupOf(shadow, 'missing')?.querySelector('.grp-head span'))).toBe('资料里没有');
    expect(text(groupOf(shadow, 'decide')?.querySelector('.grp-head span'))).toBe('你来决定');
    const order = [...shadow.querySelectorAll<HTMLElement>('[data-need-row]')].map((node) => text(node.querySelector('.need-q')));
    expect(order).toEqual(['School', 'Why Acme?', 'Earliest start date', 'How did you hear about us?', 'Are you Hispanic/Latino?', 'Phone']);
    expect(shadow.querySelectorAll('[data-need-row] .need-no')).toHaveLength(0);
    expect(text(rowIn(shadow, 'School')?.querySelector('.need-why'))).toContain('UC Berkeley');
  });

  it('选一个：摆页面上最接近他资料的真实选项（最多三个），点一下原样交出那一下真点击；「更多选项」去那一栏', () => {
    const p = page();
    const { answers, calls } = answersFor();
    const { handle, shadow } = mount();
    settle(handle, rowsFor(p), answers);
    const school = rowIn(shadow, 'School')!;
    const chips = [...school.querySelectorAll<HTMLElement>('[data-chip]')].map((chip) => chip.textContent);
    expect(chips.length).toBeLessThanOrEqual(3);
    expect(chips.slice(0, 2).sort()).toEqual(['UC Berkeley Extension', 'University of California, Berkeley']);
    expect(chips, '差得远的不摆').not.toContain('Stanford University');
    // 页面派发的点击什么都不做。
    school.querySelector<HTMLElement>('[data-chip]')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(calls).toHaveLength(0);
    const berkeley = [...school.querySelectorAll<HTMLElement>('[data-chip]')].find((chip) => chip.textContent === 'University of California, Berkeley');
    click(berkeley);
    expect(calls).toEqual([{ target: p.school, value: 'University of California, Berkeley', trusted: true, remember: false }]);
    const focus = vi.spyOn(p.school, 'focus');
    click(school.querySelector('[data-action="need-more"]'));
    expect(focus).toHaveBeenCalled();
  });

  it('写好了：那一行离开列表，总结的数跟着少', async () => {
    const p = page();
    const rows = rowsFor(p);
    const { handle, shadow } = mount();
    const { answers } = answersFor((target, value) => {
      (target as HTMLSelectElement).value = value;
      handle.update({ runId: 'gesture-1', requiredQuestions: rows.length, requiredCompleted: 2, phase: 'SETTLED', rows: rows.map((one) => one.target === target
        ? { ...one, done: true, state: 'CONFIRMED', reason: null, value, userAnswered: true } : one) } as never);
      return { ok: true };
    });
    settle(handle, rows, answers);
    expect(text(shadow.querySelector('.sum-title'))).toBe('还有 6 项需要你');
    click([...rowIn(shadow, 'School')!.querySelectorAll('[data-chip]')].find((chip) => chip.textContent === 'University of California, Berkeley'));
    await Promise.resolve();
    await Promise.resolve();
    expect(rowIn(shadow, 'School')).toBeNull();
    expect(text(shadow.querySelector('[data-need-row] .need-q')), '下一行顶上来').toBe('Why Acme?');
    expect(text(shadow.querySelector('.sum-title'))).toBe('还有 5 项需要你');
    expect(groupOf(shadow, 'choose')?.dataset.open, '这一组空了：整组收起').toBe('false');
  });

  it('资料里没有（一行字）：填一句按「填入」或回车，交出去时说要记住；几个选项的题直接摆选项', async () => {
    const p = page();
    const { answers, calls } = answersFor();
    const { handle, shadow } = mount();
    settle(handle, rowsFor(p), answers);
    const start = rowIn(shadow, 'Earliest start date')!;
    const input = start.querySelector<HTMLInputElement>('.need-input')!;
    expect(input).not.toBeNull();
    input.value = 'In two weeks';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    click(start.querySelector('[data-action="need-fill"]'));
    expect(calls.at(-1)).toEqual({ target: p.start, value: 'In two weeks', trusted: true, remember: true });
    // 写的那一会儿「填入」不可用；写完了（这里那一栏还空着，所以那一行还在）才能再交一次。
    expect(start.querySelector<HTMLButtonElement>('[data-action="need-fill"]')?.disabled).toBe(true);
    await Promise.resolve();
    await Promise.resolve();
    input.value = 'Next month';
    input.dispatchEvent(new TrustedKey('keydown', { key: 'Enter', bubbles: true, composed: true }));
    expect(calls.at(-1)).toMatchObject({ value: 'Next month', remember: true });
    const hear = rowIn(shadow, 'How did you hear about us?')!;
    expect([...hear.querySelectorAll('[data-chip]')].map((chip) => chip.textContent)).toEqual(['LinkedIn', 'Company website', 'Referral', 'Other']);
    click(hear.querySelector('[data-chip]'));
    expect(calls.at(-1)).toMatchObject({ target: p.hear, value: 'LinkedIn', remember: true });
  });

  it('写一段：「AI 帮我写」走单栏 AI 那一条路；没有 AI 可用时只摆「去这一栏」', () => {
    const p = page();
    const generate = vi.fn((_target: Element, _instruction: string) => Promise.resolve({ kind: 'WRITTEN' } as const));
    const { handle, shadow } = mount();
    settle(handle, rowsFor(p), answersFor().answers);
    const why = () => rowIn(shadow, 'Why Acme?')!;
    expect(why().querySelector('[data-action="need-ai"]')).toBeNull();
    expect(why().querySelector('[data-action="need-go"]')).not.toBeNull();
    handle.setAiTools({ targets: [p.why], generate, quota: async () => null } as DockAiTools);
    click(why().querySelector('[data-action="need-ai"]'));
    expect(generate).toHaveBeenCalledTimes(1);
    expect(generate.mock.calls[0]?.[0]).toBe(p.why);
    expect(generate.mock.calls[0]?.[1]).toBe('');
  });

  it('你来决定、去网页上看一眼：只有「去这一栏」——滚过去、把光标放进那一栏', () => {
    const p = page();
    const { handle, shadow } = mount();
    settle(handle, rowsFor(p), answersFor().answers);
    const focus = vi.spyOn(p.hispanic, 'focus');
    const decide = rowIn(shadow, 'Are you Hispanic/Latino?')!;
    expect(decide.querySelector('[data-chip]'), '按规定留给本人的不给当场答').toBeNull();
    click(decide.querySelector('[data-action="need-go"]'));
    expect(focus).toHaveBeenCalled();
    expect(rowIn(shadow, 'Phone')?.querySelector('[data-action="need-go"]')).not.toBeNull();
  });

  it('资料里没有、选项又多（没有线索可挑）：浮层里一个下拉，选好按「填入」', () => {
    const p = page();
    const source = field('select', 'source', ['LinkedIn', 'Indeed', 'Glassdoor', 'Company website', 'Referral', 'Career fair', 'Other']);
    const { answers, calls } = answersFor();
    const { handle, shadow } = mount();
    settle(handle, [...rowsFor(p), { label: 'Where did you find us?', required: true, done: false, state: 'MANUAL', needsUser: true, reason: 'CHOICE_NO_DATA', target: source, planned: true }], answers);
    const item = rowIn(shadow, 'Where did you find us?')!;
    expect(item.querySelector('[data-chip]'), '没有线索就不猜几个摆出来').toBeNull();
    const select = item.querySelector<HTMLSelectElement>('.need-select')!;
    expect([...select.options].map((option) => option.textContent)).toEqual(['选一个…', 'LinkedIn', 'Indeed', 'Glassdoor', 'Company website', 'Referral', 'Career fair', 'Other']);
    const fill = item.querySelector<HTMLButtonElement>('[data-action="need-fill"]')!;
    expect(fill.disabled, '还没选').toBe(true);
    select.value = 'Referral';
    select.dispatchEvent(new Event('change', { bubbles: true }));
    expect(fill.disabled).toBe(false);
    click(fill);
    expect(calls.at(-1)).toEqual({ target: source, value: 'Referral', trusted: true, remember: true });
  });

  it('窄屏（面板盖住整页）：去那一栏之前先收起面板，网页露出来', () => {
    const p = page();
    const width = window.innerWidth;
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 600 });
    try {
      const { handle } = mount();
      settle(handle, rowsFor(p), answersFor().answers);
      const focus = vi.spyOn(p.school, 'focus');
      click(handle.primaryButton());
      expect(handle.isOpen()).toBe(false);
      expect(focus).toHaveBeenCalled();
    } finally {
      Object.defineProperty(window, 'innerWidth', { configurable: true, value: width });
    }
  });

  it('mission 那条路没接当场答：每一行都退回「去这一栏」', () => {
    const p = page();
    const { handle, shadow } = mount();
    settle(handle, rowsFor(p));
    expect(shadow.querySelector('[data-chip]')).toBeNull();
    expect(shadow.querySelector('.need-input')).toBeNull();
    expect(rowIn(shadow, 'School')?.querySelector('[data-action="need-go"]')).not.toBeNull();
  });
});

describe('「可以联系你现在的雇主吗」：资料里没有那一组，两颗「可以」「不可以」（2026-09-28）', () => {
  function employerPage() {
    const contact = field('select', 'contact', ['Yes', 'No']);
    const rows: AutofillDockFieldRow[] = [
      { label: 'First Name', required: true, done: true, state: 'CONFIRMED', value: 'Alex', target: field('input', 'first'), planned: true },
      { label: 'May we contact your current employer?', required: true, done: false, state: 'MANUAL', needsUser: true, reason: 'LOW_CONFIDENCE', target: contact, planned: true },
    ];
    return { contact, rows };
  }
  /** 调用方说：资料里还没答这一问，页面上「Yes」是可以、「No」是不可以。 */
  function employerAnswers(outcome: DockAnswerOutcome) {
    const calls: Array<{ value: string; remember: boolean }> = [];
    const answers: DockAnswers = {
      question: () => ({ kind: 'choice', options: ['Yes', 'No'], suggested: null, employerContact: { yes: 'Yes', no: 'No' } }),
      answer: (_target, value, _event, _shadow, remember) => { calls.push({ value, remember }); return Promise.resolve(outcome); },
    };
    return { answers, calls };
  }

  it('摆在「资料里没有」：按钮上写「可以」「不可以」，下面一句说答一次就记进资料', () => {
    const { rows } = employerPage();
    const { answers } = employerAnswers({ ok: true, profile: 'SAVED' });
    const { handle, shadow } = mount();
    settle(handle, rows, answers);
    const row = rowIn(shadow, 'May we contact your current employer?')!;
    expect(row.dataset.kind).toBe('missing');
    expect([...row.querySelectorAll('[data-chip]')].map((chip) => chip.textContent)).toEqual(['可以', '不可以']);
    expect(row.querySelector('[data-action="need-more"]'), '只有两种回答：不摆「更多选项」').toBeNull();
    expect(text(row.querySelector('.need-why'))).toBe('答一次，记进你的资料，以后自动答');
  });

  it('点「不可以」：交出去的是页面上那一项（不进答案记忆）；存进了资料就说一句', async () => {
    const { rows } = employerPage();
    const { answers, calls } = employerAnswers({ ok: true, profile: 'SAVED' });
    const { handle, shadow } = mount();
    settle(handle, rows, answers);
    click([...rowIn(shadow, 'May we contact your current employer?')!.querySelectorAll('[data-chip]')].find((chip) => chip.textContent === '不可以'));
    expect(calls).toEqual([{ value: 'No', remember: false }]);
    await Promise.resolve();
    await Promise.resolve();
    expect(text(shadow.querySelector('[data-toast]'))).toBe('已记进你的资料，以后自动答');
  });

  it('存不上：照实说「下次还会问你」', async () => {
    const { rows } = employerPage();
    const { answers } = employerAnswers({ ok: true, profile: 'NOT_SAVED' });
    const { handle, shadow } = mount();
    settle(handle, rows, answers);
    click(rowIn(shadow, 'May we contact your current employer?')!.querySelector('[data-chip]'));
    await Promise.resolve();
    await Promise.resolve();
    expect(text(shadow.querySelector('[data-toast]'))).toBe('已填上。这次没能记进资料，下次还会问你');
  });
});
