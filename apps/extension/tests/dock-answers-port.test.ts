import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { AuditView } from '@edaix/apply-kernel/audit';
import type { QuestionDescription } from '@edaix/apply-kernel/questions';

import { createDockAnswers, dockAnswerRefusal, dockQuestionOf } from '../lib/dockAnswers';
import type { KernelFillAudit } from '../lib/kernelFiller';

/**
 * 「需要你」在浮层里当场答（2026-09-28）——内容脚本那一侧的口子。
 *
 * 钉住：这一轮不算数了就不给答；单选给页面上的选项原文、多选不当场答；那一下点击**同步**交给内核的补答那条路（派发一结束
 * 就取不到证了）；写成了把写上之后的单子交给浮层；浮层说值得记的才交去记（总开关由记的那一侧管）；没写成的原因只分四种。
 * 最后钉住内容脚本真的把它接给了浮层——这个仓栽过好几次「写好了、单测全绿、没有调用方」。
 */
const question = (controlType: QuestionDescription['controlType'], options: readonly string[] = []): QuestionDescription => ({
  questionId: 'c7', text: 'School', controlType, required: true, fieldName: 'school',
  options: options.map((text, index) => ({ optionId: `o${index}`, text })),
});
const VIEW = { rows: [] } as unknown as AuditView;

function audit(found: QuestionDescription | null, results: Awaited<ReturnType<KernelFillAudit['answer']>>) {
  const answer = vi.fn((_event: Event, _root: ShadowRoot, _answers: readonly { questionId: string; value: string }[]) => Promise.resolve(results));
  return {
    answer,
    recheck: vi.fn(() => VIEW),
    prefills: new Map<string, string>(),
    questionAt: vi.fn((_element: Element) => found),
  };
}

describe('浮层当场答的口子', () => {
  it('单选给页面上的选项原文；多选不当场答；文本题分一行、一段', () => {
    expect(dockQuestionOf(question('SINGLE_CHOICE', ['Stanford University', 'UC Berkeley Extension']), null))
      .toEqual({ kind: 'choice', options: ['Stanford University', 'UC Berkeley Extension'], suggested: null });
    expect(dockQuestionOf(question('SINGLE_CHOICE', ['Yes', 'No']), 'Yes')?.suggested, '计划期挑好的那一项').toBe('Yes');
    expect(dockQuestionOf(question('SINGLE_CHOICE', ['Yes', 'No']), 'Maybe')?.suggested, '不在选项里的建议不算').toBeNull();
    expect(dockQuestionOf(question('MULTI_CHOICE', ['A', 'B']), null)).toBeNull();
    expect(dockQuestionOf(question('TEXT'), null)).toEqual({ kind: 'text', options: [], suggested: null });
    expect(dockQuestionOf(question('TEXTAREA'), null)?.kind).toBe('long');
  });

  it('这一轮不算数了：不给答，也不交去写', async () => {
    const fake = audit(question('TEXT'), []);
    const answers = createDockAnswers({ audit: fake, current: () => false, onAnswered: vi.fn(), remember: vi.fn(async () => {}) })!;
    const target = {} as Element;
    expect(answers.question(target)).toBeNull();
    await expect(answers.answer(target, 'x', new Event('click'), {} as ShadowRoot, false)).resolves.toEqual({ ok: false, reason: 'ENDED' });
    expect(fake.answer).not.toHaveBeenCalled();
  });

  it('那一下点击同步交给补答那条路；写成了换单子；值得记的才交去记', async () => {
    const fake = audit(question('SINGLE_CHOICE', ['Stanford University']), [{ key: 'question:c7', label: 'School', ok: true }]);
    const onAnswered = vi.fn();
    const remember = vi.fn(async () => {});
    const answers = createDockAnswers({ audit: fake, current: () => true, onAnswered, remember })!;
    const event = new Event('click');
    const root = {} as ShadowRoot;
    const pending = answers.answer({} as Element, 'Stanford University', event, root, true);
    expect(fake.answer, '同步：还没 await 就已经交出去了').toHaveBeenCalledWith(event, root, [{ questionId: 'c7', value: 'Stanford University' }]);
    await expect(pending).resolves.toEqual({ ok: true });
    expect(onAnswered).toHaveBeenCalledWith(VIEW);
    expect(remember).toHaveBeenCalledWith(expect.objectContaining({ questionId: 'c7' }), 'Stanford University');
    await answers.answer({} as Element, 'Stanford University', event, root, false);
    expect(remember, '看岗位的那一类不记').toHaveBeenCalledTimes(1);
  });

  it('没写成：原因只分四种，不写单子、不记', async () => {
    for (const [code, reason] of [['GESTURE_FOREIGN', 'UNTRUSTED'], ['ABORTED', 'ENDED'], ['NOT_EMPTY', 'CHANGED'], ['NO_VALUE', 'REFUSED']] as const) {
      const fake = audit(question('TEXT'), [{ key: 'question:c7', label: 'School', ok: false, reason: code }]);
      const onAnswered = vi.fn();
      const remember = vi.fn(async () => {});
      const answers = createDockAnswers({ audit: fake, current: () => true, onAnswered, remember })!;
      await expect(answers.answer({} as Element, 'x', new Event('click'), {} as ShadowRoot, true)).resolves.toEqual({ ok: false, reason });
      expect(onAnswered).not.toHaveBeenCalled();
      expect(remember).not.toHaveBeenCalled();
    }
    expect(dockAnswerRefusal(null)).toBe('REFUSED');
  });

  it('内容脚本把它接给了浮层（手势路的审计单子带着它）', () => {
    const source = readFileSync(resolve(__dirname, '../entrypoints/apply.content.ts'), 'utf8');
    expect(source).toContain('const answers = createDockAnswers({');
    expect(source).toContain('...(answers === undefined ? {} : { answers }),');
    expect(source).toContain('remember: rememberQuietly,');
    // 总开关关着就不记（没设过算开着，由 worker 的缺省管：answer-memory-provider.test.ts）。
    expect(source).toMatch(/const rememberQuietly = async[\s\S]{0,200}settings\?\.enabled !== true\) return;/);
    // 第一次记住：浮层说一句，记下说过的那一版；同一页只说一次。
    expect(source).toMatch(/memoryNoticeShown \|\| settings\.disclosureVersion === ANSWER_MEMORY_NOTICE_VERSION\) return;\s+memoryNoticeShown = true;\s+dockHandle\?\.noteRemembered\(\);/);
    // 账户菜单里的开关接给了浮层。
    expect(source).toContain('...(gestureFace ? { answerMemory: memorySwitch } : {}),');
  });
});

describe('「可以联系你现在的雇主吗」：答一次记进资料（2026-09-28）', () => {
  const employer: QuestionDescription = {
    questionId: 'c9', text: 'May we contact your current employer?', controlType: 'SINGLE_CHOICE', required: true, fieldName: 'contact',
    options: [{ optionId: 'o0', text: 'Yes' }, { optionId: 'o1', text: 'No' }],
  };
  const ok = [{ key: 'question:c9', label: 'Contact', ok: true }] as Awaited<ReturnType<KernelFillAudit['answer']>>;

  it('资料里还没答：告诉浮层页面上「可以」「不可以」各是哪一项；资料里答过（没给存的口子）就是一道普通的题', () => {
    const save = vi.fn(async () => true);
    const open = createDockAnswers({ audit: audit(employer, ok), current: () => true, onAnswered: vi.fn(), remember: vi.fn(async () => {}), employerContact: { save } })!;
    expect(open.question({} as Element)).toEqual({ kind: 'choice', options: ['Yes', 'No'], suggested: null, employerContact: { yes: 'Yes', no: 'No' } });
    const answered = createDockAnswers({ audit: audit(employer, ok), current: () => true, onAnswered: vi.fn(), remember: vi.fn(async () => {}) })!;
    expect(answered.question({} as Element)?.employerContact).toBeUndefined();
    // 以前的雇主、推荐人不是资料里那一问。
    const references = createDockAnswers({
      audit: audit({ ...employer, text: 'May we contact your references?' }, ok), current: () => true, onAnswered: vi.fn(), remember: vi.fn(async () => {}), employerContact: { save },
    })!;
    expect(references.question({} as Element)?.employerContact).toBeUndefined();
  });

  it('点了「不可以」：交给补答那条路写上那一项，记进资料（不进答案记忆），说存上了', async () => {
    const save = vi.fn(async () => true);
    const remember = vi.fn(async () => {});
    const fake = audit(employer, ok);
    const answers = createDockAnswers({ audit: fake, current: () => true, onAnswered: vi.fn(), remember, employerContact: { save } })!;
    const event = new Event('click');
    await expect(answers.answer({} as Element, 'No', event, {} as ShadowRoot, true)).resolves.toEqual({ ok: true, profile: 'SAVED' });
    expect(fake.answer).toHaveBeenCalledWith(event, {}, [{ questionId: 'c9', value: 'No' }]);
    expect(save).toHaveBeenCalledWith('NO');
    expect(remember, '不进答案记忆').not.toHaveBeenCalled();
  });

  it('存不上（服务端还不认这一项、没登录……）：照样算写上了，说没记进资料', async () => {
    for (const save of [vi.fn(async () => false), vi.fn(async () => { throw new Error('offline'); })]) {
      const answers = createDockAnswers({ audit: audit(employer, ok), current: () => true, onAnswered: vi.fn(), remember: vi.fn(async () => {}), employerContact: { save } })!;
      await expect(answers.answer({} as Element, 'Yes', new Event('click'), {} as ShadowRoot, false)).resolves.toEqual({ ok: true, profile: 'NOT_SAVED' });
      expect(save).toHaveBeenCalledWith('YES');
    }
  });

  it('内容脚本接上了：资料里没答才给；存的是 preferences.contactCurrentEmployer，走资料保存那条路', () => {
    const source = readFileSync(resolve(__dirname, '../entrypoints/apply.content.ts'), 'utf8');
    expect(source).toContain("...(profileReply.employerContact === undefined ? { employerContact: { save: saveEmployerContact } } : {}),");
    expect(source).toMatch(/const saveEmployerContact = async[\s\S]{0,400}directory\.profileV2\(\)[\s\S]{0,400}'preferences\.contactCurrentEmployer': answer === 'YES'[\s\S]{0,200}directory\.saveProfileV2\(patch\)/);
  });
});
