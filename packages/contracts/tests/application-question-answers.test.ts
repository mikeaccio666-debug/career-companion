import { describe, expect, it } from 'vitest';

import {
  APPLICATION_ANSWER_CATEGORIES,
  applicationAnswerCategoryKeyV1,
  applicationAnswerTextKeyV1,
  applicationQuestionIdentityPreimage,
  normalizeApplicationQuestionTextV1,
  parseApplicationAnswerKeyV1,
  parseApplicationAnswerValueV1,
  parsePutApplicationAnswerRequestV1,
} from '../src/index.ts';

/**
 * 答案记忆的 wire（argoland applicationQuestionAnswers.ts，逐字镜像）。本仓是消费者：
 * 「同一道题怎么被认出来」必须两边算出同一个键，否则记了也从不复用、而且任何一侧
 * 都不报错。这里钉归一化、键的形状、以及 put 请求的收/拒。
 */
describe('题干归一化：只吸收排版差异', () => {
  it('大小写、空白、必填/选填标记折掉，别的一个字不动', () => {
    expect(normalizeApplicationQuestionTextV1('  Why do you   want to work HERE? *')).toBe('why do you want to work here?');
    expect(normalizeApplicationQuestionTextV1('Desired salary (required)')).toBe('desired salary');
    expect(normalizeApplicationQuestionTextV1('期望薪资（必填）')).toBe('期望薪资');
    expect(normalizeApplicationQuestionTextV1("Ｆｕｌｌ width")).toBe('full width');
  });

  it('不做词干化：两道语义不同的题不能并成一个键', () => {
    expect(normalizeApplicationQuestionTextV1('Are you willing to relocate?'))
      .not.toBe(normalizeApplicationQuestionTextV1('Have you relocated before?'));
  });

  it('空、超长、带控制字符的一律 null', () => {
    expect(normalizeApplicationQuestionTextV1('   *  ')).toBeNull();
    expect(normalizeApplicationQuestionTextV1('a' + String.fromCharCode(0) + 'b')).toBeNull();
    expect(normalizeApplicationQuestionTextV1('x'.repeat(8_001))).toBeNull();
  });

  // 插件侧 claim key 的原像用的是同一套 clean()：两边必须逐字节一致。
  it('与 applicationQuestionIdentityPreimage 的归一化逐字节一致', () => {
    const text = '  Are you legally authorized to work in the U.S.?  *';
    const preimage = JSON.parse(applicationQuestionIdentityPreimage({ text, controlType: 'TEXT', optionTexts: [] })) as [string];
    expect(preimage[0]).toBe(normalizeApplicationQuestionTextV1(text));
  });
});

describe('键', () => {
  it('文本键稳定、带前缀、64 位十六进制', async () => {
    const normalized = normalizeApplicationQuestionTextV1('Why do you want to work here?')!;
    const key = await applicationAnswerTextKeyV1(normalized);
    expect(key).toMatch(/^txt:[0-9a-f]{64}$/);
    expect(await applicationAnswerTextKeyV1(normalized)).toBe(key);
    expect(parseApplicationAnswerKeyV1(key)).toEqual({ kind: 'TEXT', digest: key!.slice(4) });
  });

  it('类别键只认目录里的五类', () => {
    expect(APPLICATION_ANSWER_CATEGORIES).toEqual(['work-authorization', 'visa-sponsorship', 'referral-source', 'relocation', 'salary-expectation']);
    expect(parseApplicationAnswerKeyV1(applicationAnswerCategoryKeyV1('relocation'))).toEqual({ kind: 'CATEGORY', category: 'relocation' });
    expect(parseApplicationAnswerKeyV1('cat:country')).toBeNull();
    expect(parseApplicationAnswerKeyV1('txt:short')).toBeNull();
  });
});

describe('put 请求：键要解析得出，取值要与控件类型相符', () => {
  const put = (over: Record<string, unknown> = {}) => ({
    schemaVersion: 1, answerKey: 'cat:relocation', controlType: 'SINGLE_CHOICE', value: { kind: 'CHOICES', optionTexts: ['Yes'] }, ...over,
  });
  it('单选一个选项、文本一段话，都收', () => {
    expect(parsePutApplicationAnswerRequestV1(put())).toEqual(put());
    expect(parsePutApplicationAnswerRequestV1(put({ controlType: 'TEXTAREA', value: { kind: 'TEXT', text: 'Because.' } }))).not.toBeNull();
  });
  it.each([
    ['单选给了两个选项', { value: { kind: 'CHOICES', optionTexts: ['Yes', 'No'] } }],
    ['文本控件给了选项', { controlType: 'TEXT' }],
    ['选项文本重复', { controlType: 'MULTI_CHOICE', value: { kind: 'CHOICES', optionTexts: ['A', 'A'] } }],
    ['键不成形', { answerKey: 'cat:nope' }],
    ['多一个字段', { extra: 1 }],
    ['空白答案', { controlType: 'TEXT', value: { kind: 'TEXT', text: '   ' } }],
  ])('%s → 拒', (_why, over) => {
    expect(parsePutApplicationAnswerRequestV1(put(over))).toBeNull();
  });
  it('取值解析单独可用', () => {
    expect(parseApplicationAnswerValueV1({ kind: 'TEXT', text: 'x' }, 'TEXT')).toEqual({ kind: 'TEXT', text: 'x' });
    expect(parseApplicationAnswerValueV1({ kind: 'TEXT', text: 'x' }, 'SINGLE_CHOICE')).toBeNull();
  });
});
