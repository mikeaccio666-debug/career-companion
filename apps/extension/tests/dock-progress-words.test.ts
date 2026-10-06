// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';

import { mountAutofillDock, type AutofillDockFieldRow, type AutofillDockHandlers } from '../lib/autofillDock';

/**
 * 进度卡说此刻在做什么（2026-09-28 负责人：「正在读表单」「正在匹配选项」「正在等 AI」「正在填工作经历 2/3」
 * 「正在为这个岗位写求职信」），底下一行实时的数：已填 · AI 写的 · 需要你 · 按规定不代填。不编百分比。
 *
 * 夹具全是合成文字。
 */
afterEach(() => {
  document.body.innerHTML = '';
  vi.useRealTimers();
});

const text = (node: Element | null | undefined) => (node?.textContent ?? '').replace(/\s+/g, ' ').trim();
const row = (label: string, state: AutofillDockFieldRow['state'], extra: Partial<AutofillDockFieldRow> = {}): AutofillDockFieldRow => ({
  label, required: true, done: state === 'CONFIRMED', state, ...extra,
});

function mount(extra: Partial<AutofillDockHandlers> = {}) {
  const handle = mountAutofillDock({ kind: 'READY' }, {
    onAutofill: () => {},
    onOpenEntry: () => {},
    onStop: () => {},
    vendorLabel: 'Greenhouse',
    jobCard: () => ({ title: 'Product Designer', company: 'Example Co' }),
    ...extra,
  }, document);
  handle.openPanel();
  const root = handle.sceneRoot()!;
  const status = () => text(root.querySelector('.act-label'));
  const tally = () => [...root.querySelectorAll<HTMLElement>('.tally-item')].map((node) => [text(node), node.dataset.zero]);
  return { handle, root, status, tally };
}

/** 途中的一份：前几栏结算了，`writing` 那一栏正在写，后面的还没轮到。 */
const midway = (rows: readonly AutofillDockFieldRow[]) =>
  ({ runId: 'gesture-1', requiredQuestions: rows.length, requiredCompleted: rows.filter((one) => one.done).length, rows }) as never;

describe('进度卡说此刻在做什么', () => {
  it('读表单、对照资料：下面写是为哪一份申请', () => {
    const { handle, root, status } = mount();
    handle.beginPreparing();
    handle.setStep('SCANNING');
    expect(status()).toBe('正在读表单');
    expect(text(root.querySelector('.ticker-q'))).toBe('Product Designer');
    expect(text(root.querySelector('.ticker-v'))).toBe('Example Co · Greenhouse');
    handle.setStep('PLANNING');
    expect(status()).toBe('正在对照你的资料');
  });

  it('写一道选择题是「正在匹配选项」；写一段经历是「正在填工作经历 2/3」；别的是「正在填写」', () => {
    vi.useFakeTimers();
    const select = document.createElement('select');
    const radio = document.createElement('input');
    radio.type = 'radio';
    const plain = document.createElement('input');
    document.body.append(select, radio, plain);
    const { handle, root, status } = mount();
    handle.beginPreparing();
    handle.beginRun(midway([row('First Name', 'CONFIRMED', { value: 'Sample' }), row('Country', 'WRITING', { target: select })]));
    expect(status()).toBe('正在匹配选项');
    // 当前那一项每一项至少停 350ms（真实的页一栏只要几十毫秒）：用假时钟走过去。
    vi.advanceTimersByTime(400);
    expect(text(root.querySelector('.ticker-q'))).toBe('Country');
    handle.update(midway([row('First Name', 'CONFIRMED'), row('Country', 'CONFIRMED'), row('Authorized?', 'WRITING', { target: radio })]));
    expect(status()).toBe('正在匹配选项');
    handle.update(midway([row('First Name', 'CONFIRMED'), row('Company', 'WRITING', { collection: { kind: 'experience', number: 2, total: 3 } })]));
    expect(status()).toBe('正在填工作经历 2/3');
    handle.update(midway([row('First Name', 'CONFIRMED'), row('School', 'WRITING', { collection: { kind: 'education', number: 1, total: 1 } })]));
    expect(status()).toBe('正在填教育经历 1/1');
    handle.update(midway([row('First Name', 'CONFIRMED'), row('Phone', 'WRITING', { target: plain })]));
    expect(status()).toBe('正在填写');
    expect(text(root.querySelector('.act-count'))).toBe('2 / 2');
  });

  it('等 AI、写求职信：各说各的', () => {
    const { handle, root, status } = mount();
    handle.beginPreparing();
    handle.beginRun(midway([row('First Name', 'CONFIRMED')]));
    handle.setAiAnswers({ kind: 'DRAFTING', count: 2, targets: [] });
    handle.setStep('AI_DRAFTING');
    expect(status()).toBe('正在等 AI');
    expect(text(root.querySelector('.ticker-q'))).toBe('AI 正在按你的资料填写 2 道题…');
    handle.setAiAnswers({ kind: 'IDLE' });
    handle.setCoverLetter({ kind: 'WRITING', targets: [] });
    expect(status()).toBe('正在写求职信');
    expect(text(root.querySelector('.ticker-q'))).toBe('正在为这个岗位写求职信…');
  });

  it('实时的数：已填 · AI 写的 · 需要你 · 按规定不代填；是 0 的那几样淡一点；不编百分比', () => {
    const why = document.createElement('textarea');
    document.body.append(why);
    const { handle, root, tally } = mount();
    handle.beginPreparing();
    expect(tally().map(([words]) => words), '还在读表时不写数').toEqual(['', '', '', '']);
    handle.beginRun(midway([
      row('First Name', 'CONFIRMED', { value: 'Sample' }),
      row('Email', 'CONFIRMED', { value: 'sample@example.test' }),
      row('Why us?', 'CONFIRMED', { value: 'Because.', aiAnswered: true }),
      row('Portfolio', 'MANUAL', { needsUser: true, reason: 'USER_ONLY', target: why }),
      row('Are you Hispanic/Latino?', 'MANUAL', { needsUser: true, reason: 'MANUAL_ONLY' }),
      row('Phone', 'WRITING'),
    ]));
    expect(tally()).toEqual([['已填 2', 'false'], ['AI 写的 1', 'false'], ['需要你 1', 'false'], ['按规定不代填 1', 'false']]);
    handle.update(midway([row('First Name', 'CONFIRMED'), row('Phone', 'WRITING')]));
    expect(tally()).toEqual([['已填 1', 'false'], ['AI 写的 0', 'true'], ['需要你 0', 'true'], ['按规定不代填 0', 'true']]);
    expect(text(root.querySelector('.act')) + text(root.querySelector('.legend'))).not.toMatch(/%/);
    expect(handle.summaryText()).toBe('必填 1/2');
  });

  it('英文界面', () => {
    const select = document.createElement('select');
    document.body.append(select);
    const { handle, status, tally } = mount({ locale: 'en' });
    handle.beginPreparing();
    expect(status()).toBe('Reading the form');
    handle.beginRun(midway([row('First Name', 'CONFIRMED'), row('Country', 'WRITING', { target: select })]));
    expect(status()).toBe('Matching options');
    handle.update(midway([row('First Name', 'CONFIRMED'), row('Company', 'WRITING', { collection: { kind: 'experience', number: 2, total: 3 } })]));
    expect(status()).toBe('Filling work experience 2/3');
    expect(tally().map(([words]) => words)).toEqual(['1 filled', '0 by AI', '0 need you', '0 left to you']);
    handle.setAiAnswers({ kind: 'DRAFTING', count: 2, targets: [] });
    handle.setStep('AI_DRAFTING');
    expect(status()).toBe('Waiting for AI');
  });
});
