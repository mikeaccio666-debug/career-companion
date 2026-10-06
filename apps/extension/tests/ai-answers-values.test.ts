import { describe, expect, it } from 'vitest';
import type { FullAiField } from '@edaix/contracts';

import { aiAnswerValues, isRevisable, type AiFieldKind, type AiLeftover } from '../lib/aiAnswers';

/**
 * AI 代答的答案怎么对回页面上的那一栏（2026-09-23）：对不上的一条不要——宁可空着让用户答，也不写一个不合
 * 那一栏的值。文本照长度上限、单行框压成一行；日期与数字框只收 ISO 日期、纯数字；单选与下拉恰好一个送出去
 * 过的选项；多选一行一个；组合框一行搜索词。只认送出去的题号，同一题只认第一条。夹具全是合成文字。
 */

function leftover(
  id: string,
  kind: AiFieldKind,
  extra: Partial<Pick<AiLeftover, 'maxLength' | 'reason'>> & { options?: string[]; label?: string; autocomplete?: string; attributes?: Record<string, string> } = {},
): AiLeftover {
  const options = (extra.options ?? []).map((text, index) => ({ optionId: `o${index}`, text }));
  const field: FullAiField = {
    id, kind, label: extra.label ?? `Question ${id}`, context: '', autocomplete: extra.autocomplete ?? '', required: false, hasValue: false,
    maxLength: extra.maxLength ?? null, options: options.map((option) => ({ id: option.optionId, label: option.text })),
    optionsComplete: kind !== 'combobox',
  };
  const attributes = extra.attributes ?? {};
  return {
    id,
    element: { getAttribute: (name: string) => attributes[name] ?? null } as unknown as Element,
    question: { questionId: id, text: field.label, controlType: 'TEXT', required: false, options, fieldName: '' },
    kind,
    reason: extra.reason ?? 'LOW_CONFIDENCE',
    maxLength: extra.maxLength ?? null,
    optionTexts: new Map(options.map((option) => [option.optionId, option.text])),
    field,
  };
}

const fill = (id: string, value: string | null, optionIds: string[] = []) => ({ id, value, optionIds });
const values = (fills: ReturnType<typeof fill>[], leftovers: AiLeftover[]) =>
  aiAnswerValues(fills, leftovers).map((answer) => [answer.leftover.id, answer.value]);

describe('答案对回那一栏', () => {
  it('文本：单行框压成一行；多行框保留换行；超过长度上限整条不要', () => {
    expect(values([fill('f0', ' Five\nyears ')], [leftover('f0', 'text')])).toEqual([['f0', 'Five years']]);
    expect(values([fill('f0', 'Line one\nLine two')], [leftover('f0', 'textarea')])).toEqual([['f0', 'Line one\nLine two']]);
    expect(values([fill('f0', 'x'.repeat(11))], [leftover('f0', 'textarea', { maxLength: 10 })])).toEqual([]);
    expect(values([fill('f0', '   ')], [leftover('f0', 'text')])).toEqual([]);
  });

  it('日期与数字框：只收 ISO 日期、纯数字', () => {
    expect(values([fill('f0', '2026-10-01'), fill('f1', 'next month')], [leftover('f0', 'date'), leftover('f1', 'date')])).toEqual([['f0', '2026-10-01']]);
    expect(values([fill('f0', '5'), fill('f1', 'five')], [leftover('f0', 'number'), leftover('f1', 'number')])).toEqual([['f0', '5']]);
  });

  it('单选与下拉：恰好一个送出去过的选项，映回那一项的原文；文字答案不收', () => {
    const radio = leftover('f0', 'radio', { options: ['Yes', 'No'] });
    expect(values([fill('f0', null, ['o1'])], [radio])).toEqual([['f0', 'No']]);
    expect(values([fill('f0', null, ['o0', 'o1'])], [radio])).toEqual([]);
    expect(values([fill('f0', 'Yes')], [radio])).toEqual([]);
    expect(values([fill('f0', null, ['o7'])], [radio])).toEqual([]);
    const select = leftover('f1', 'select', { options: ['Remote', 'Hybrid', 'On-site'] });
    expect(values([fill('f1', null, ['o2'])], [select])).toEqual([['f1', 'On-site']]);
  });

  it('多选：一行一个；有一个 id 认不出就整题不要', () => {
    const multi = leftover('f0', 'checkbox', { options: ['Kotlin', 'Swift', 'Go'] });
    expect(values([fill('f0', null, ['o0', 'o2'])], [multi])).toEqual([['f0', 'Kotlin\nGo']]);
    expect(values([fill('f0', null, ['o0', 'o9'])], [multi])).toEqual([]);
  });

  it('组合框：一行搜索词，不收选项', () => {
    expect(values([fill('f0', 'San Francisco')], [leftover('f0', 'combobox')])).toEqual([['f0', 'San Francisco']]);
    expect(values([fill('f0', null, ['o0'])], [leftover('f0', 'combobox')])).toEqual([]);
  });

  it('只认送出去的题号；同一题只认第一条', () => {
    expect(values([fill('f9', 'x'), fill('f0', 'first'), fill('f0', 'second')], [leftover('f0', 'text')])).toEqual([['f0', 'first']]);
  });
});

describe('「用 AI 写 / AI 改写」摆在哪几栏', () => {
  it('我们答不了的开放题（没认出、开放题），多行框与单行框都摆；随岗位而定、选择题没数据的不摆', () => {
    expect(isRevisable(leftover('f0', 'textarea', { reason: 'USER_ONLY' }))).toBe(true);
    expect(isRevisable(leftover('f0', 'textarea', { reason: 'LOW_CONFIDENCE' }))).toBe(true);
    // 2026-09-24 测试台：Ashby 把长答案做成单行框（「Have you contributed to a mobile app(s)… Please describe.」）。
    const ashby = 'Have you contributed to a mobile app(s) that is live in the App Store? Please describe.';
    expect(isRevisable(leftover('f0', 'text', { reason: 'LOW_CONFIDENCE', label: ashby }))).toBe(true);
    expect(isRevisable(leftover('f0', 'text', { reason: 'USER_ONLY' }))).toBe(true);
    expect(isRevisable(leftover('f0', 'textarea', { reason: 'JOB_DEPENDENT' }))).toBe(false);
    expect(isRevisable(leftover('f0', 'text', { reason: 'CHOICE_NO_DATA' }))).toBe(false);
    for (const kind of ['radio', 'checkbox', 'select', 'combobox', 'date', 'number'] as const) {
      expect(isRevisable(leftover('f0', kind, { reason: 'USER_ONLY' })), kind).toBe(false);
    }
  });

  it('事实类的联系方式栏不摆：姓名、邮箱、电话、网址、地址', () => {
    const text = (extra: Parameters<typeof leftover>[2]) => isRevisable(leftover('f0', 'text', { reason: 'LOW_CONFIDENCE', ...extra }));
    for (const label of ['Preferred name', 'Email address', 'Phone number', 'LinkedIn Profile', 'Personal website URL', 'GitHub', 'Street address', 'Zip code']) {
      expect(text({ label }), label).toBe(false);
    }
    expect(text({ label: 'Contact', attributes: { type: 'email' } })).toBe(false);
    expect(text({ label: 'Reach me at', attributes: { inputmode: 'tel' } })).toBe(false);
    expect(text({ label: 'Details', autocomplete: 'section-a url' })).toBe(false);
    // 长的开放题里出现 name、link 这类词不算联系方式栏。
    expect(text({ label: 'Tell us the name of a product you admire and what you would change about it' })).toBe(true);
    expect(text({ label: 'Anything else?', autocomplete: 'off' })).toBe(true);
  });
});
