import { describe, expect, it } from 'vitest';
import { createDockQuestionDraftIntent, parseDockQuestionDraftIntent, parseDockQuestionDraftReply } from '../lib/questionDraftIntent';

/**
 * AI 起草开放题（P3-13）：这条消息只说在哪一页、岗位是什么、要起草哪几题；requestId 与凭据都在 worker。
 */
const PAGE = ['https://boards.greenhouse.io', '/example/jobs/1/application'] as const;
const JOB = { company: 'Acme, Inc.', title: 'Analyst', location: null };
const QUESTIONS = [{ questionId: 'q1', text: 'Why Acme?', maxLength: null }];

describe('dock/question-draft-intent', () => {
  it('形状对就收；岗位与题目按契约解析', () => {
    const intent = createDockQuestionDraftIntent(...PAGE, JOB, QUESTIONS);
    expect(intent).toMatchObject({ kind: 'dock/question-draft-intent', origin: PAGE[0], pathname: PAGE[1], job: JOB, questions: QUESTIONS });
  });

  it.each([
    ['多一个键', (i: Record<string, unknown>) => ({ ...i, extra: 1 })],
    ['岗位多一个键', (i: Record<string, unknown>) => ({ ...i, job: { ...JOB, salary: '1' } })],
    ['题目超过上限', (i: Record<string, unknown>) => ({ ...i, questions: Array.from({ length: 13 }, (_, n) => ({ questionId: `q${n}`, text: 't', maxLength: null })) })],
    ['题目 maxLength 太小', (i: Record<string, unknown>) => ({ ...i, questions: [{ questionId: 'q1', text: 't', maxLength: 5 }] })],
    ['不是这条消息', (i: Record<string, unknown>) => ({ ...i, kind: 'dock/answer-memory-intent' })],
  ])('%s → 拒', (_why, mutate) => {
    const intent = createDockQuestionDraftIntent(...PAGE, JOB, QUESTIONS)!;
    expect(parseDockQuestionDraftIntent(mutate({ ...intent }))).toBeNull();
  });

  it('答复：草稿逐条按上限校验；拒绝只认闭集的码', () => {
    expect(parseDockQuestionDraftReply({ kind: 'QUESTION_DRAFTS', drafts: [{ questionId: 'q1', text: 'Because…' }] }))
      .toEqual({ kind: 'QUESTION_DRAFTS', drafts: [{ questionId: 'q1', text: 'Because…' }] });
    expect(parseDockQuestionDraftReply({ kind: 'QUESTION_DRAFTS', drafts: [{ questionId: 'q1', text: '   ' }] })).toBeNull();
    expect(parseDockQuestionDraftReply({ kind: 'QUESTION_DRAFTS', drafts: [{ questionId: 'q1', text: 'x'.repeat(8001) }] })).toBeNull();
    expect(parseDockQuestionDraftReply({ kind: 'REFUSED', code: 'QUOTA_EXCEEDED' })).toEqual({ kind: 'REFUSED', code: 'QUOTA_EXCEEDED' });
    expect(parseDockQuestionDraftReply({ kind: 'REFUSED', code: 'WHATEVER' })).toBeNull();
  });
});
