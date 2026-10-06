import type { AuditView } from '@edaix/apply-kernel/audit';
import type { ApplyErrorCode } from '@edaix/apply-kernel/contracts';
import type { QuestionDescription } from '@edaix/apply-kernel/questions';
import { employerContactAnswer, employerContactSubject, type EmployerContactAnswer } from '@edaix/apply-kernel/signOnBehalf';
import type { DockAnswerOutcome, DockAnswers, DockQuestion } from './dock/types';
import type { KernelFillAudit } from './kernelFiller';

/**
 * 「需要你」在浮层里当场答（2026-09-28 负责人：用户要做的越少越好）——内容脚本这一侧。
 *
 * 浮层按元素问「这一栏能不能当场答、有哪些选项」；他点一个选项、或填一句按「填入」，那一下点击原样交给内核的补答那条路
 * （`KernelFillAudit.answer`：点击当下铸票、这一轮的信封、同一本撤销日志、写后回读）。这里不写任何东西、不认任何一家的 DOM：
 * 题目是内核按扫描描述的，选项原文只在本地（浮层摆出来），不上行。写成了换成写上之后的那一份单子；这一题值得记（浮层说的）
 * 就交给 `remember`——答案记忆的总开关由它管，不另问。
 */
export interface DockAnswersInput {
  readonly audit: Pick<KernelFillAudit, 'answer' | 'recheck' | 'prefills' | 'questionAt'>;
  /** 这一轮还算数：没开新的一轮、没翻页、没撤销、没按「停止」。 */
  readonly current: () => boolean;
  /** 写上了：把写上之后的那一份单子交给浮层（与复查同一条路）。 */
  readonly onAnswered: (view: AuditView) => void;
  /** 值得记的那一题写上了：记进答案记忆（总开关关着就不记）。 */
  readonly remember: (question: QuestionDescription, value: string) => Promise<void>;
  /**
   * 「可以联系你现在的雇主吗」这一轮读到的资料里还没答（2026-09-28）：这一题当场答了，就把他的回答记进资料
   * （`preferences.contactCurrentEmployer`，走资料编辑器保存的同一条路），以后按资料自动答（RULE-GLOBAL-HUMAN-AUTHORIZATION
   * 例外二）。不给 = 资料里答过，或这一页存不了资料：照旧当一道普通的「资料里没有」。存成了返回 true。
   */
  readonly employerContact?: Readonly<{ save: (answer: EmployerContactAnswer) => Promise<boolean> }>;
}

/**
 * 问的是能不能联系他现在的雇主（只问这一件事），页面上恰好一项是「可以」、恰好一项是「不可以」：各是哪一项。判据是内核
 * 代填那一套（`dict/signOnBehalf.ts`），与按资料自动答时挑的是同一项。以前的雇主、推荐人那一类不在这里（资料里那一问
 * 问的是现在的雇主）。
 */
export function employerContactChoices(question: QuestionDescription): Readonly<{ yes: string; no: string }> | null {
  if (question.controlType !== 'SINGLE_CHOICE' || employerContactSubject(question.text) !== 'CURRENT') return null;
  const options = question.options.map((option) => option.text);
  const yes = employerContactAnswer(question.text, options, 'YES');
  const no = employerContactAnswer(question.text, options, 'NO');
  return yes === null || no === null ? null : Object.freeze({ yes: options[yes.index]!, no: options[no.index]! });
}

/** 内核的题目描述 → 浮层能当场答的样子：单选给页面上的选项原文；多选题不当场答（去那一栏）。 */
export function dockQuestionOf(question: QuestionDescription, suggested: string | null): DockQuestion | null {
  if (question.controlType === 'MULTI_CHOICE') return null;
  if (question.controlType === 'SINGLE_CHOICE') {
    const options = question.options.map((option) => option.text);
    return options.length === 0 ? null : { kind: 'choice', options, suggested: suggested !== null && options.includes(suggested) ? suggested : null };
  }
  return { kind: question.controlType === 'TEXTAREA' ? 'long' : 'text', options: [], suggested: null };
}

/** 没写成的稳定原因 → 浮层说的那一句（它只分四种：点击不算数、这一轮结束了、那一栏有内容了、别的）。 */
export function dockAnswerRefusal(reason: ApplyErrorCode | null): Extract<DockAnswerOutcome, { ok: false }>['reason'] {
  switch (reason) {
    case 'GESTURE_UNTRUSTED':
    case 'GESTURE_FOREIGN':
      return 'UNTRUSTED';
    case 'ABORTED':
    case 'LEASE_INVALID':
    case 'LEASE_EXPIRED':
    case 'IDENTITY_CHANGED':
    case 'GESTURE_EXPIRED':
    case 'DETACHED':
      return 'ENDED';
    case 'NOT_EMPTY':
      return 'CHANGED';
    default:
      return 'REFUSED';
  }
}

export function createDockAnswers(input: DockAnswersInput): DockAnswers | undefined {
  const questionAt = input.audit.questionAt;
  if (questionAt === undefined) return undefined;
  return Object.freeze({
    question: (target: Element): DockQuestion | null => {
      if (!input.current()) return null;
      const question = questionAt(target);
      if (question === null) return null;
      const described = dockQuestionOf(question, input.audit.prefills.get(question.questionId) ?? null);
      const employer = input.employerContact === undefined ? null : employerContactChoices(question);
      return described === null || employer === null ? described : { ...described, employerContact: employer };
    },
    answer: (target: Element, value: string, event: Event, shadowRoot: ShadowRoot, remember: boolean): Promise<DockAnswerOutcome> => {
      const question = questionAt(target);
      if (question === null || !input.current()) return Promise.resolve({ ok: false, reason: 'ENDED' });
      // 能不能联系现在的雇主：他点的是哪一向（只认页面上那两项）。
      const employer = input.employerContact === undefined ? null : employerContactChoices(question);
      const direction: EmployerContactAnswer | null = employer === null ? null
        : value === employer.yes ? 'YES' : value === employer.no ? 'NO' : null;
      let pending: ReturnType<KernelFillAudit['answer']>;
      try {
        // 同步交出去：`answer` 在这一下派发当中取证、铸票，之后才等。
        pending = input.audit.answer(event, shadowRoot, [{ questionId: question.questionId, value }]);
      } catch {
        return Promise.resolve({ ok: false, reason: 'REFUSED' });
      }
      return pending.then((results): DockAnswerOutcome | Promise<DockAnswerOutcome> => {
        const result = results.find((one) => one.key === `question:${question.questionId}`);
        if (result === undefined) return { ok: false, reason: 'REFUSED' };
        if (!result.ok) return { ok: false, reason: dockAnswerRefusal(result.reason) };
        if (input.current()) input.onAnswered(input.audit.recheck());
        // 能不能联系雇主：记进资料（不进答案记忆），浮层据此说一句存上了没有。
        if (direction !== null && input.employerContact !== undefined) {
          return input.employerContact.save(direction).then(
            (saved): DockAnswerOutcome => ({ ok: true, profile: saved ? 'SAVED' : 'NOT_SAVED' }),
            (): DockAnswerOutcome => ({ ok: true, profile: 'NOT_SAVED' }),
          );
        }
        // 记不上不打扰他（记忆那一侧在 worker 里已经记下稳定码 ANSWER_MEMORY_PUT_*）。
        if (remember) void input.remember(question, value).catch(() => undefined);
        return { ok: true };
      }, (): DockAnswerOutcome => ({ ok: false, reason: 'REFUSED' }));
    },
  });
}
