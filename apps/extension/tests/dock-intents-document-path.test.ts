import { describe, expect, it } from 'vitest';

import { createDockAddJobIntent, parseDockAddJobIntent } from '../lib/dockAddJobIntent';
import { createDockAnswerMemoryIntent, parseDockAnswerMemoryIntent } from '../lib/answerMemoryIntent';
import { createDockApplyMaterialsIntent, parseDockApplyMaterialsIntent } from '../lib/applyMaterialsIntent';
import { createDockFillIntent, parseDockFillIntent } from '../lib/dockFillIntent';
import { createDockQuestionDraftIntent, parseDockQuestionDraftIntent } from '../lib/questionDraftIntent';
import { createDockAiAnswersIntent, parseDockAiAnswersIntent } from '../lib/aiAnswersIntent';
import { createDockResumeAttachmentIntent, parseDockResumeAttachmentIntent } from '../lib/resumeAttachmentIntent';

/**
 * 会过发信人核对的 dock 消息（六种，2026-09-23 起加上 AI 代答共七种），都要收得下 `documentPathname`（单页应用改过地址时，文档加载时的路径）。
 *
 * 收下的条件与 pathname 同一套规则；不合法整条作废；与当前路径相同就不带（worker 只在不同的时候看它）。
 * 精确键集照旧：除了这一个可选键，多一个字段仍然整条拒收。
 */

const ORIGIN = 'https://nvidia.wd5.myworkdayjobs.com';
const NOW = '/en-US/NVIDIAExternalCareerSite/job/US-CA-Remote/X_JR2024816/apply';
const LOADED = `${NOW}/applyManually`;

const CASES: ReadonlyArray<readonly [string, () => Record<string, unknown> | null, (value: unknown) => unknown]> = [
  ['apply-materials', () => createDockApplyMaterialsIntent(ORIGIN, NOW, 'DISCOVERY_AUTHORITY') as never, parseDockApplyMaterialsIntent],
  ['fill', () => createDockFillIntent(ORIGIN, NOW) as never, parseDockFillIntent],
  ['add-job', () => createDockAddJobIntent(ORIGIN, NOW) as never, parseDockAddJobIntent],
  ['resume-attachment', () => createDockResumeAttachmentIntent(ORIGIN, NOW, 'PLAN') as never, parseDockResumeAttachmentIntent],
  ['answer-memory', () => createDockAnswerMemoryIntent(ORIGIN, NOW, 'LIST') as never, parseDockAnswerMemoryIntent],
  ['question-draft', () => createDockQuestionDraftIntent(ORIGIN, NOW, { company: 'Acme', title: 'Analyst', location: null },
    [{ questionId: 'q1', text: 'Why Acme?', maxLength: null }]) as never, parseDockQuestionDraftIntent],
  // 2026-09-23：AI 代答（题面与选项上行，同一套发信人核对）。
  ['ai-answers', () => createDockAiAnswersIntent(ORIGIN, NOW, { step: 'PLAN', title: 'Analyst', fields: [{
    id: 'f0', kind: 'textarea', label: 'Why Acme?', context: '', autocomplete: '', required: true, hasValue: false,
    maxLength: null, options: [], optionsComplete: false,
  }] }) as never, parseDockAiAnswersIntent],
];

describe.each(CASES)('%s', (_name, create, parse) => {
  const base = () => {
    const intent = create();
    expect(intent, '合法消息都造不出来——这条测试就没在测什么').not.toBeNull();
    return { ...intent! };
  };

  it('带着文档加载时的路径 → 收下，并原样带到解析结果里', () => {
    expect(parse({ ...base(), documentPathname: LOADED })).toMatchObject({ pathname: NOW, documentPathname: LOADED });
  });

  it('与当前路径相同 → 收下，但结果里不带（worker 只在不同的时候看它）', () => {
    const parsed = parse({ ...base(), documentPathname: NOW }) as Record<string, unknown> | null;
    expect(parsed).not.toBeNull();
    expect(parsed).not.toHaveProperty('documentPathname');
  });

  it.each([
    ['不是字符串', 42],
    ['不以 / 开头', 'apply'],
    ['带查询串', `${LOADED}?source=LinkedIn`],
  ])('文档路径%s → 整条作废', (_why, value) => {
    expect(parse({ ...base(), documentPathname: value })).toBeNull();
  });

  it('精确键集照旧：别的多余字段仍然整条拒收', () => {
    expect(parse({ ...base(), documentPathname: LOADED, extra: 1 })).toBeNull();
  });
});
