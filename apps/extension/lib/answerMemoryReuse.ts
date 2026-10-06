import type { QuestionDescription } from '@edaix/apply-kernel/questions';
import { employerContactSubject } from '@edaix/apply-kernel/signOnBehalf';
import { workAuthorizationQuestionKind } from '@edaix/apply-kernel/workAuthorization';
import {
  applicationAnswerCategoryKeyV1,
  applicationAnswerTextKeyV1,
  normalizeApplicationQuestionTextV1,
  type ApplicationAnswerCategory,
  type ApplicationQuestionCandidateV1,
  type ApplicationAnswerControlType,
  type PutApplicationAnswerRequestV1,
  type RememberedAnswerV1,
} from '@edaix/contracts';

/**
 * 内容脚本侧：本页的题 ↔ 用户记住的答案（P1-6）。
 *
 * 「同一道题」由契约算：归一化题干的摘要（`txt:…`），或跨厂商复现、措辞发散到文本
 * 必然失手的那几个语义类（`cat:…`）。两条都中且值不同时**文本优先**——文本键更具体。
 *
 * 比对全在本地：题干与选项不上行。只有用户在面板里亲手确认并勾了「记住」的答案
 * 才会以 PUT 交给第一方 API。
 *
 * 复用的三条底线（宁可不填，不可填错）：
 * · 控件类型要相符：文本答案只进文本控件，选项答案只进选项控件；
 * · 选项答案必须**恰好**对上本页的一个选项文案（归一化后相等），对不上就不填；
 * · 多选控件暂不复用（一条记忆对多个勾选框，写入器今天只写一个值）。
 */
/**
 * 能不能联系他的雇主或推荐人（2026-09-28）：只按资料里那一问答（RULE-GLOBAL-HUMAN-AUTHORIZATION 例外二，还要运行时包放行
 * `sign-on-behalf`），不进答案记忆、也不从记忆里带出——记忆复用不看那个开关，记下来就绕过了它。浮层里当场答的这一题记进资料。
 */
function answeredFromProfileOnly(question: QuestionDescription): boolean {
  return employerContactSubject(question.text) !== null;
}

export interface AnswerKeys {
  readonly textKey: string | null;
  readonly categoryKey: string | null;
}

/** 题目属于哪一个跨厂商语义类；不在目录里的一律 null（那是文本键的活）。 */
export function answerCategoryOf(text: string): ApplicationAnswerCategory | null {
  const kind = workAuthorizationQuestionKind(text);
  if (kind === 'REQUIRES_SPONSORSHIP') return 'visa-sponsorship';
  if (kind === 'AUTHORIZED_TO_WORK') return 'work-authorization';
  if (/\bhow\s+(?:did|do)\s+you\s+(?:hear|find\s+out|learn)\s+about\b|\bhow\s+did\s+you\s+find\s+(?:us|this)\b|你从哪|从哪里(?:听说|得知)/iu.test(text)) return 'referral-source';
  if (/\brelocat(?:e|ion|ing)\b|是否愿意搬迁|愿意搬迁/iu.test(text)) return 'relocation';
  if (/\b(?:expected|desired|target|requested)\s+(?:annual\s+|base\s+)?(?:salary|compensation|pay)\b|\b(?:salary|compensation|pay)\s+(?:expectation|requirement)s?\b|期望薪[资酬]|薪资期望/iu.test(text)) return 'salary-expectation';
  return null;
}

export async function answerKeysFor(question: QuestionDescription): Promise<AnswerKeys> {
  const normalized = normalizeApplicationQuestionTextV1(question.text);
  const textKey = normalized === null ? null : await applicationAnswerTextKeyV1(normalized);
  const category = answerCategoryOf(question.text);
  return Object.freeze({ textKey, categoryKey: category === null ? null : applicationAnswerCategoryKeyV1(category) });
}

const normalizeOption = (text: string): string => text.normalize('NFKC').replace(/\s+/gu, ' ').trim().toLowerCase();

/** 一条记忆对这道题能不能落地；落得地的话，写进控件的值是什么。 */
function reusableValue(question: QuestionDescription, answer: RememberedAnswerV1): string | null {
  const textual = question.controlType === 'TEXT' || question.controlType === 'TEXTAREA';
  if (textual) {
    return answer.value.kind === 'TEXT' && answer.value.text.trim() !== '' ? answer.value.text : null;
  }
  if (question.controlType !== 'SINGLE_CHOICE' || answer.value.kind !== 'CHOICES') return null;
  if (answer.value.optionTexts.length !== 1) return null;
  const wanted = normalizeOption(answer.value.optionTexts[0]!);
  const matches = question.options.filter((option) => normalizeOption(option.text) === wanted);
  return matches.length === 1 ? matches[0]!.text : null;
}

export interface RememberedMatch {
  readonly questionId: string;
  readonly value: string;
  /** 命中的是哪一把键——面板与诊断说得出「为什么填了这个」。 */
  readonly answerKey: string;
}

export async function matchRememberedAnswers(
  questions: readonly QuestionDescription[],
  answers: readonly RememberedAnswerV1[],
): Promise<readonly RememberedMatch[]> {
  if (questions.length === 0 || answers.length === 0) return [];
  const byKey = new Map(answers.map((answer) => [answer.answerKey, answer]));
  const matches: RememberedMatch[] = [];
  for (const question of questions) {
    if (answeredFromProfileOnly(question)) continue;
    const keys = await answerKeysFor(question);
    for (const key of [keys.textKey, keys.categoryKey]) {
      if (key === null) continue;
      const answer = byKey.get(key);
      if (answer === undefined) continue;
      const value = reusableValue(question, answer);
      if (value === null) continue;
      matches.push(Object.freeze({ questionId: question.questionId, value, answerKey: key }));
      break;
    }
  }
  return Object.freeze(matches);
}

/**
 * 面板要的候选形状：命中的题带着记忆值、档为「来自你的记忆，请确认」；没命中的题
 * 档为「没有依据，请你填写」——面板照样给一个空控件，答完可以顺手记住。
 */
export function memoryCandidates(
  questions: readonly QuestionDescription[],
  matches: readonly RememberedMatch[],
): readonly ApplicationQuestionCandidateV1[] {
  const byQuestion = new Map(matches.map((match) => [match.questionId, match]));
  return questions.map((question) => {
    const match = byQuestion.get(question.questionId);
    if (match === undefined) {
      return Object.freeze({ questionId: question.questionId, disposition: 'NEEDS_USER_INPUT' as const, reasonCode: 'QUESTION_NO_EVIDENCE' as never, answer: null, confidence: 'NONE' as const, provenance: [] });
    }
    const answer = question.controlType === 'SINGLE_CHOICE' || question.controlType === 'MULTI_CHOICE'
      ? { kind: 'CHOICES' as const, optionIds: question.options.filter((option) => option.text === match.value).map((option) => option.optionId) }
      : { kind: 'TEXT' as const, text: match.value };
    return Object.freeze({
      questionId: question.questionId,
      disposition: 'USER_CONFIRMATION_REQUIRED' as const,
      reasonCode: 'QUESTION_CONFIRMED_ANSWER' as never,
      answer,
      confidence: 'HIGH' as const,
      provenance: [Object.freeze({ evidenceId: match.answerKey, source: 'CONFIRMED_ANSWER' as never, sourceId: match.answerKey, sourceRevision: '0' })],
    });
  });
}

/** 用户在面板里确认过的答案 → 要记住的那一条（或几条：文本键必记，类别键命中也记一份）。 */
export async function rememberRequestsFor(
  question: QuestionDescription,
  value: string,
): Promise<readonly PutApplicationAnswerRequestV1[]> {
  if (answeredFromProfileOnly(question)) return [];
  const controlType: ApplicationAnswerControlType = question.controlType;
  const answer = controlType === 'SINGLE_CHOICE' || controlType === 'MULTI_CHOICE'
    ? { kind: 'CHOICES' as const, optionTexts: value.split('\n').map((item) => item.trim()).filter(Boolean) }
    : { kind: 'TEXT' as const, text: value };
  if (answer.kind === 'CHOICES' && (answer.optionTexts.length === 0 || (controlType === 'SINGLE_CHOICE' && answer.optionTexts.length !== 1))) return [];
  if (answer.kind === 'TEXT' && answer.text.trim() === '') return [];
  const keys = await answerKeysFor(question);
  return [keys.textKey, keys.categoryKey]
    .filter((key): key is string => key !== null)
    .map((answerKey) => Object.freeze({ schemaVersion: 1 as const, answerKey, controlType, value: answer }));
}
