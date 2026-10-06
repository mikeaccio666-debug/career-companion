import { describe, expect, it } from 'vitest';
import { applicationAnswerTextKeyV1, normalizeApplicationQuestionTextV1, type RememberedAnswerV1 } from '@edaix/contracts';
import { answerCategoryOf, answerKeysFor, matchRememberedAnswers, memoryCandidates, rememberRequestsFor } from '../lib/answerMemoryReuse';

/**
 * 本页的题 ↔ 用户记住的答案（P1-6）。宁可不填，不可填错：
 * 控件类型要相符、选项要恰好对上一个、多选暂不复用；文本键优先于类别键。
 */
const q = (questionId: string, text: string, controlType: 'TEXT' | 'TEXTAREA' | 'SINGLE_CHOICE' | 'MULTI_CHOICE', options: string[] = []) =>
  ({ questionId, text, controlType, required: true, fieldName: '', options: options.map((t, i) => ({ optionId: `o${i}`, text: t })) });
const remembered = (answerKey: string, controlType: RememberedAnswerV1['controlType'], value: RememberedAnswerV1['value']): RememberedAnswerV1 =>
  ({ answerKey, categoryKey: answerKey.startsWith('cat:') ? answerKey.slice(4) : null, controlType, value, revision: '1', confirmedAt: '2026-09-21T00:00:00.000Z' });
const textKey = async (text: string) => (await applicationAnswerTextKeyV1(normalizeApplicationQuestionTextV1(text)!))!;

describe('类别', () => {
  it.each([
    ['Are you legally authorized to work in the United States?', 'work-authorization'],
    ['Will you now or in the future require sponsorship for employment visa status?', 'visa-sponsorship'],
    ['How did you hear about this job?', 'referral-source'],
    ['Are you willing to relocate?', 'relocation'],
    ['What are your salary expectations?', 'salary-expectation'],
    ['Why do you want to work here?', null],
  ])('%s → %s', (text, category) => {
    expect(answerCategoryOf(text)).toBe(category);
  });
  it('两把键：文本键总有，类别键只对目录里的题', async () => {
    const keys = await answerKeysFor(q('q1', 'Are you willing to relocate? *', 'SINGLE_CHOICE', ['Yes', 'No']));
    expect(keys.textKey).toMatch(/^txt:/);
    expect(keys.categoryKey).toBe('cat:relocation');
    expect((await answerKeysFor(q('q2', 'Why us?', 'TEXTAREA'))).categoryKey).toBeNull();
  });
});

describe('比对', () => {
  it('文本键命中 → 文本控件拿到那段话；类别键命中 → 选项控件落到恰好对上的那一项', async () => {
    const why = q('q1', 'Why do you want to work here?', 'TEXTAREA');
    const relocate = q('q2', 'Are you willing to relocate?', 'SINGLE_CHOICE', ['Yes', 'No']);
    const answers = [
      remembered(await textKey(why.text), 'TEXTAREA', { kind: 'TEXT', text: 'Because payments.' }),
      remembered('cat:relocation', 'SINGLE_CHOICE', { kind: 'CHOICES', optionTexts: ['yes'] }),
    ];
    const matches = await matchRememberedAnswers([why, relocate], answers);
    expect(matches).toEqual([
      { questionId: 'q1', value: 'Because payments.', answerKey: answers[0]!.answerKey },
      { questionId: 'q2', value: 'Yes', answerKey: 'cat:relocation' },
    ]);
  });
  it('文本键与类别键都中且值不同 → 文本优先', async () => {
    const relocate = q('q2', 'Are you willing to relocate?', 'SINGLE_CHOICE', ['Yes', 'No']);
    const answers = [
      remembered('cat:relocation', 'SINGLE_CHOICE', { kind: 'CHOICES', optionTexts: ['No'] }),
      remembered(await textKey(relocate.text), 'SINGLE_CHOICE', { kind: 'CHOICES', optionTexts: ['Yes'] }),
    ];
    expect((await matchRememberedAnswers([relocate], answers))[0]?.value).toBe('Yes');
  });
  it.each([
    ['控件类型不符：文本答案进选项控件', q('q', 'Are you willing to relocate?', 'SINGLE_CHOICE', ['Yes', 'No']), remembered('cat:relocation', 'TEXT', { kind: 'TEXT', text: 'Yes' })],
    ['选项对不上本页任何一项', q('q', 'Are you willing to relocate?', 'SINGLE_CHOICE', ['Sure', 'Nope']), remembered('cat:relocation', 'SINGLE_CHOICE', { kind: 'CHOICES', optionTexts: ['Yes'] })],
    ['多选暂不复用', q('q', 'Are you willing to relocate?', 'MULTI_CHOICE', ['Yes', 'No']), remembered('cat:relocation', 'MULTI_CHOICE', { kind: 'CHOICES', optionTexts: ['Yes'] })],
  ])('%s → 不填', async (_why, question, answer) => {
    expect(await matchRememberedAnswers([question], [answer])).toEqual([]);
  });
});

describe('面板候选与记住', () => {
  it('命中的题档为「来自你的记忆，请确认」，没命中的档为「请你填写」', () => {
    const why = q('q1', 'Why us?', 'TEXTAREA');
    const relocate = q('q2', 'Are you willing to relocate?', 'SINGLE_CHOICE', ['Yes', 'No']);
    const candidates = memoryCandidates([why, relocate], [{ questionId: 'q2', value: 'Yes', answerKey: 'cat:relocation' }]);
    expect(candidates[0]).toMatchObject({ questionId: 'q1', disposition: 'NEEDS_USER_INPUT', answer: null });
    expect(candidates[1]).toMatchObject({ questionId: 'q2', disposition: 'USER_CONFIRMATION_REQUIRED', answer: { kind: 'CHOICES', optionIds: ['o0'] } });
  });
  it('记住：文本键必记，类别键命中的也记一份；空答案不记', async () => {
    const relocate = q('q2', 'Are you willing to relocate?', 'SINGLE_CHOICE', ['Yes', 'No']);
    const requests = await rememberRequestsFor(relocate, 'Yes');
    expect(requests.map((r) => r.answerKey.slice(0, 4))).toEqual(['txt:', 'cat:']);
    expect(requests[0]).toMatchObject({ schemaVersion: 1, controlType: 'SINGLE_CHOICE', value: { kind: 'CHOICES', optionTexts: ['Yes'] } });
    expect(await rememberRequestsFor(q('q3', 'Why us?', 'TEXTAREA'), '   ')).toEqual([]);
  });
});

describe('能不能联系雇主或推荐人：只按资料答，不进记忆（2026-09-28）', () => {
  it('不记，也不从记忆里带出——记忆复用不看运行时包的 sign-on-behalf，记下来就绕过了它', async () => {
    const current = q('q1', 'May we contact your current employer?', 'SINGLE_CHOICE', ['Yes', 'No']);
    const references = q('q2', 'May we contact your references?', 'SINGLE_CHOICE', ['Yes', 'No']);
    expect(await rememberRequestsFor(current, 'Yes')).toEqual([]);
    expect(await rememberRequestsFor(references, 'No')).toEqual([]);
    const answers = [
      remembered(await textKey(current.text), 'SINGLE_CHOICE', { kind: 'CHOICES', optionTexts: ['Yes'] }),
      remembered(await textKey(references.text), 'SINGLE_CHOICE', { kind: 'CHOICES', optionTexts: ['No'] }),
    ];
    expect(await matchRememberedAnswers([current, references], answers)).toEqual([]);
    // 别的题照旧。
    const relocate = q('q3', 'Are you willing to relocate?', 'SINGLE_CHOICE', ['Yes', 'No']);
    expect(await rememberRequestsFor(relocate, 'Yes')).not.toEqual([]);
  });
});
