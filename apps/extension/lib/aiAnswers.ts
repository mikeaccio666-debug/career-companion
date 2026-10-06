import { FULL_AI_LIMITS, fullAiManualField, type FullAiField, type FullAiLane } from '@edaix/contracts';
import type { ApplyErrorCode, ApplyFieldDescriptor, ApplyFormDescriptor, ApplyPlan } from '@edaix/apply-kernel/contracts';
import type { AuditView } from '@edaix/apply-kernel/audit';
import type { QuestionAnswer } from '@edaix/apply-kernel/engine';
import type { GestureRoot, TrustedGestureProof } from '@edaix/apply-kernel/grant';
import { describeQuestion, questionIdentity, type QuestionDescription } from '@edaix/apply-kernel/questions';
import { AI_TIMING_MAX_MARKS, parseDockAiStreamMessage, type AiAnswersRefusal, type AiFill, type AiTimingMark } from './aiAnswersIntent';
import { hostFieldHasValue } from './dock/hostField';
import type { KernelAiWrite, KernelFillAudit } from './kernelFiller';
import { questionClaimKeyFor } from './questionClaimKey';

/**
 * AI 代答（2026-09-23 负责人决定）的内容脚本那一半：挑题、组请求、把答案对回页面上的那一栏。
 *
 * ## 挑哪些题
 *
 * 第一遍计划跳过、原因是「我们用资料答不了」的那几类——没认出（LOW_CONFIDENCE）、开放题（USER_ONLY）、
 * 选择题没数据（CHOICE_NO_DATA）、随岗位而定（JOB_DEPENDENT；其中工作授权、签证那几类服务端自己拒，这里
 * 按契约的同一个判据先挡掉，题面根本不上行）——而且页面上还空着。只能本人答的（MANUAL_ONLY）、他人信息
 * （OTHER_PERSON）、蜜罐、代填条款与签名、密码、文件，一概不送。
 *
 * ## 送什么
 *
 * 不透明题号（`f0`…）、题面、选项（`o0`…）、旁边的说明文字（占位提示与 aria-describedby 指向的那几句）、
 * autocomplete、必填与长度上限。**不送选择器、不送页面上的现值**（送的都是空栏）。
 *
 * ## 答案怎么回到页面
 *
 * 只认这一次送出去的题号；文本题照长度上限、单行框压成一行；选择题只认送出去的选项 id，映回那一项的原文，
 * 交给内核的答案计划（`buildAnswerPlan`），与记住的答案走同一条写入、核对、撤销的路。
 */

/** 这几类跳过说的是「资料里答不了」，AI 可以试着按资料起草。 */
export const AI_ANSWER_SKIP_REASONS: ReadonlySet<ApplyErrorCode> = new Set<ApplyErrorCode>([
  'LOW_CONFIDENCE', 'USER_ONLY', 'CHOICE_NO_DATA', 'JOB_DEPENDENT',
]);

export type AiFieldKind = FullAiField['kind'];

/** 送出去的一道题，以及把答案对回来要用的东西（只在内容脚本里）。 */
export interface AiLeftover {
  readonly id: string;
  readonly element: Element;
  readonly question: QuestionDescription;
  readonly kind: AiFieldKind;
  /** 第一遍计划为什么跳过它（开放题是 USER_ONLY）。 */
  readonly reason: ApplyErrorCode;
  readonly maxLength: number | null;
  /** 选项 id → 页面上那一项的原文（完整，不截断）。 */
  readonly optionTexts: ReadonlyMap<string, string>;
  readonly field: FullAiField;
}

/** 摆「用 AI 写」的那几类跳过原因：我们没认出、或本来就是开放题（与送给 AI 的原因同一批里的这两类）。 */
const REVISABLE_REASONS: ReadonlySet<ApplyErrorCode> = new Set<ApplyErrorCode>(['LOW_CONFIDENCE', 'USER_ONLY']);
const CONTACT_INPUT_TYPES: ReadonlySet<string> = new Set(['email', 'tel', 'url']);
/** autocomplete 里说「这是联系方式」的那几个词（HTML 规范的自动填充词）。 */
const CONTACT_AUTOCOMPLETE = /\b(?:name|given-name|additional-name|family-name|nickname|honorific-(?:prefix|suffix)|email|tel(?:-[a-z-]+)?|url|street-address|address-line[123]|address-level[1-4]|postal-code|country(?:-name)?|username)\b/;
/** 题面短、说的又是联系方式的：姓名、邮箱、电话、网址与个人主页、地址。 */
const CONTACT_LABEL = /\b(?:(?:first|last|full|middle|given|family|legal|preferred|sur)[\s-]*name|name|e-?mail(?:\s+address)?|phone(?:\s+number)?|mobile(?:\s+number)?|telephone|cell(?:\s+phone)?|url|urls|link|website|web\s*site|homepage|linkedin|github|gitlab|twitter|portfolio|address|street|city|zip(?:\s*code)?|postal(?:\s+code)?|country)\b|姓名|名字|邮箱|电话|手机|网址|链接|地址/i;

/**
 * 事实类的联系方式栏（姓名、邮箱、电话、网址、地址）：这一类不该让 AI 写。判据只看这一栏自己说了什么——输入类型、
 * autocomplete、以及短题面里的联系方式词（长的开放题里偶尔出现「name」不算）。
 */
function isContactField(leftover: AiLeftover): boolean {
  const element = leftover.element;
  const type = (element.getAttribute('type') ?? '').toLowerCase();
  const mode = (element.getAttribute('inputmode') ?? '').toLowerCase();
  if (CONTACT_INPUT_TYPES.has(type) || CONTACT_INPUT_TYPES.has(mode)) return true;
  if (CONTACT_AUTOCOMPLETE.test(leftover.field.autocomplete.toLowerCase())) return true;
  const words = leftover.field.label.split(/\s+/).filter(Boolean).length;
  return words <= 6 && CONTACT_LABEL.test(leftover.field.label);
}

/**
 * 浮层可以在旁边摆「用 AI 写 / AI 改写」的那几栏（2026-09-24 负责人；同日测试台复核后放宽）：我们答不了的开放题——
 * 没认出（LOW_CONFIDENCE）或本来就是开放题（USER_ONLY）——不论是多行框还是单行框（Ashby 把长答案做成单行的
 * `<input type=text>`）；事实类的联系方式栏（姓名、邮箱、电话、网址、地址）不摆。改写的后端只收文本题。
 */
export function isRevisable(leftover: AiLeftover): boolean {
  return (leftover.kind === 'textarea' || leftover.kind === 'text') &&
    REVISABLE_REASONS.has(leftover.reason) &&
    !isContactField(leftover);
}

/** 一道题的答案，已经对回页面上的那一栏：文本，或选项原文（多选一行一个）。 */
export interface AiAnswerValue {
  readonly leftover: AiLeftover;
  readonly value: string;
}

/** 流上的一批答案（worker 已按契约与门槛筛过）：`noEvidence` 送出去、AI 在资料里没找到依据的题号。 */
export type AiAnswersBatch = Readonly<{ lane: FullAiLane | string; fills: readonly AiFill[]; noEvidence: readonly string[] }>;

/**
 * 流怎么结束的：`unanswered` 是一个答案都没拿到的题号（那一道失败了、流断了、或一行不合格就不再读）；或者整轮
 * 被拒（付费墙、次数用完、要登录、开关关着、暂时用不了）——被拒只会发生在一批答案都还没到的时候。
 */
export type AiAnswersEnd =
  | Readonly<{ ok: true; unanswered: readonly string[] }>
  | Readonly<{ ok: false; code: AiAnswersRefusal }>;

/** 流上的事按到达的先后交到这里：响应头（`opened`）、一批批答案，最后恰好一次 `end`。 */
export interface AiAnswersSink {
  readonly opened: () => void;
  readonly answers: (batch: AiAnswersBatch) => void;
  readonly end: (end: AiAnswersEnd) => void;
}

/**
 * 内容脚本这一侧的长连接接收器（2026-09-24）：worker 的消息逐条解码（`parseDockAiStreamMessage`）后交给 `sink`。
 * 不合格的一条、连接断了、超时了（`cut`）：不再读，已经写上的留着，还没拿到结果的题当没答上；一条答案都没到就是
 * 「暂时用不了」。`end` 之后什么都不再交。`close` 是调用方自己不要了：不再交任何东西（`end` 由调用方自己给）。
 */
export interface AiStreamReceiver {
  readonly message: (raw: unknown) => void;
  readonly cut: () => void;
  readonly close: () => void;
  readonly finished: () => boolean;
}

export function createAiStreamReceiver(fields: readonly FullAiField[], sink: AiAnswersSink): AiStreamReceiver {
  let finished = false;
  const heard = new Set<string>();
  const finish = (end: AiAnswersEnd): void => {
    if (finished) return;
    finished = true;
    sink.end(end);
  };
  const cut = (): void => {
    if (heard.size === 0) finish({ ok: false, code: 'UNAVAILABLE' });
    else finish({ ok: true, unanswered: fields.map((field) => field.id).filter((id) => !heard.has(id)) });
  };
  return Object.freeze({
    message: (raw: unknown): void => {
      if (finished) return;
      const message = parseDockAiStreamMessage(raw);
      if (message === null) {
        cut();
        return;
      }
      switch (message.kind) {
        case 'AI_STREAM_OPEN':
          sink.opened();
          return;
        case 'AI_STREAM_ANSWERS':
          for (const fill of message.fills) heard.add(fill.id);
          for (const id of message.noEvidence) heard.add(id);
          sink.answers({ lane: message.lane, fills: message.fills, noEvidence: message.noEvidence });
          return;
        case 'AI_STREAM_END':
          finish({ ok: true, unanswered: message.unanswered });
          return;
        case 'REFUSED':
          if (heard.size === 0) finish({ ok: false, code: message.code });
          else cut();
          return;
      }
    },
    cut,
    close: (): void => { finished = true; },
    finished: (): boolean => finished,
  });
}

/** 内核这一侧向调用方要答案的口子（手势路由内容脚本经 worker 的长连接去问）。 */
export interface KernelAiAnswersPort {
  /**
   * 问一次（一次点击一条流）；答案经 `sink` 按到达的先后回来，`end` 恰好一次。交回「不要了」：关掉那条流（之后
   * 什么都不再交）。不许抛——出了错就是 `end({ ok: false, code: 'UNAVAILABLE' })`。
   */
  readonly request: (fields: readonly FullAiField[], sink: AiAnswersSink) => () => void;
  /** 这一轮还算不算数（没开新的一轮、没翻页、没撤销、开关没关）。写之前与写的途中都会问。 */
  readonly stillCurrent?: () => boolean;
}

/** 契约只收可打印字符（制表、换行除外）；页面上的文字先洗一遍、压空白、截到上限。 */
function clean(text: string, max: number): string {
  return text.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max).trim();
}

function kindOf(field: ApplyFieldDescriptor, question: QuestionDescription): AiFieldKind | null {
  switch (field.kind) {
    case 'text': {
      const type = (field.element.getAttribute('type') ?? 'text').toLowerCase();
      return type === 'date' ? 'date' : type === 'number' ? 'number' : 'text';
    }
    case 'textarea':
      return 'textarea';
    case 'select':
      return 'select';
    case 'combobox':
      return 'combobox';
    case 'choice':
      return question.controlType === 'MULTI_CHOICE' ? 'checkbox' : 'radio';
    default:
      return null;
  }
}

/** 页面上这一栏还空着吗（与浮层判「有没有值」同一套读法；选择题看整组）。 */
function isEmpty(field: ApplyFieldDescriptor): boolean {
  switch (field.kind) {
    case 'text':
    case 'textarea':
      return field.element.value.trim() === '';
    case 'select':
    case 'combobox':
      return !hostFieldHasValue(field.element);
    case 'choice':
      return field.choice.control === 'proxy'
        ? field.choice.options.every((option) => !hostFieldHasValue(option.element))
        : field.choice.options.every((option) => !option.element.checked);
    default:
      return false;
  }
}

/** 旁边的说明文字：占位提示，与 aria-describedby 指向的那几句（「两三句话」「最多 500 字」一类）。 */
function contextOf(element: Element): string {
  const parts = [element.getAttribute('placeholder') ?? ''];
  for (const id of (element.getAttribute('aria-describedby') ?? '').split(/\s+/).filter(Boolean)) {
    parts.push(element.ownerDocument.getElementById(id)?.textContent ?? '');
  }
  return clean(parts.map((part) => clean(part, 600)).filter((part) => part !== '').join(' · '), 600);
}

function maxLengthOf(element: Element): number | null {
  const max = (element as Partial<HTMLInputElement>).maxLength;
  return typeof max === 'number' && Number.isInteger(max) && max > 0 && max <= 1_000_000 ? max : null;
}

/** 请求的字节数留一点余量给 requestId、页面与外层键。 */
const REQUEST_BYTE_BUDGET = FULL_AI_LIMITS.bytes - 4_000;

/**
 * 第一遍计划里值得交给 AI 的题（最多 120 道、总字节在契约上限之内），连同要送出去的那一份。
 * 同步：挑题只读页面，不等任何东西，填写照常立刻开始。
 */
export function selectAiLeftovers(plan: ApplyPlan, descriptor: ApplyFormDescriptor): AiLeftover[] {
  const leftovers: AiLeftover[] = [];
  const encoder = new TextEncoder();
  let bytes = 0;
  for (const skip of plan.skipped) {
    if (leftovers.length >= FULL_AI_LIMITS.fields) break;
    if (!AI_ANSWER_SKIP_REASONS.has(skip.reason)) continue;
    const field = descriptor.fields[skip.order];
    if (field === undefined || field.element !== skip.element) continue;
    const question = describeQuestion(field, `q${skip.order}`);
    if (question === null) continue;
    const kind = kindOf(field, question);
    if (kind === null) continue;
    const element = field.element;
    if ((element.getAttribute('type') ?? '').toLowerCase() === 'password') continue;
    const label = clean(question.text, 600);
    if (label === '') continue;
    const options = question.options.slice(0, FULL_AI_LIMITS.options)
      .map((option) => ({ id: option.optionId, label: clean(option.text, 300) }))
      .filter((option) => option.label !== '');
    // 单个勾选框多半是一句声明或同意：服务端也不让 AI 勾，这里干脆不送。
    if (kind === 'checkbox' && options.length < 2) continue;
    if ((kind === 'radio' || kind === 'select') && options.length === 0) continue;
    const context = contextOf(element);
    const autocomplete = clean(element.getAttribute('autocomplete') ?? '', 80);
    // 只能本人答的（工作授权、签证、EEO、年龄、同意、营销、签名、密码、验证码……）：与服务端同一个判据。
    if (fullAiManualField({ label, context, autocomplete, options })) continue;
    if (!isEmpty(field)) continue;
    const id = `f${leftovers.length}`;
    const request: FullAiField = {
      id,
      kind,
      label,
      context,
      autocomplete,
      required: field.required,
      hasValue: false,
      maxLength: maxLengthOf(element),
      options,
      optionsComplete: kind !== 'combobox' && options.length === question.options.length,
    };
    const size = encoder.encode(JSON.stringify(request)).byteLength + 1;
    if (bytes + size > REQUEST_BYTE_BUDGET) break;
    bytes += size;
    leftovers.push(Object.freeze({
      id,
      element,
      question,
      kind,
      reason: skip.reason,
      maxLength: request.maxLength,
      optionTexts: new Map(question.options.map((option) => [option.optionId, option.text])),
      field: Object.freeze(request),
    }));
  }
  return leftovers;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const NUMBER = /^-?\d+(?:\.\d+)?$/;

/**
 * 答案对回页面上的那一栏；对不上的一条不要（宁可空着让用户答，也不写一个不合那一栏的值）。
 *  · 文本题：不收选项；单行框压成一行；长度不超过那一栏的上限。
 *  · 日期、数字框：只收 ISO 日期、纯数字。
 *  · 单选、下拉：恰好一个送出去过的选项 id。多选：至少一个，逐个都是送出去过的，一行一个。
 *  · 组合框：一行搜索词（没有送选项，写入期只选真实菜单里完全对得上的那一项）。
 */
export function aiAnswerValues(fills: readonly AiFill[], leftovers: readonly AiLeftover[]): AiAnswerValue[] {
  const byId = new Map(leftovers.map((leftover) => [leftover.id, leftover]));
  const seen = new Set<string>();
  const answers: AiAnswerValue[] = [];
  for (const fill of fills) {
    const leftover = byId.get(fill.id);
    if (leftover === undefined || seen.has(fill.id)) continue;
    const value = valueFor(leftover, fill);
    if (value === null) continue;
    seen.add(fill.id);
    answers.push(Object.freeze({ leftover, value }));
  }
  return answers;
}

function valueFor(leftover: AiLeftover, fill: AiFill): string | null {
  const fits = (value: string): string | null =>
    value !== '' && value.length <= (leftover.maxLength ?? FULL_AI_LIMITS.value) ? value : null;
  const choices = (): string[] | null => {
    const ids = [...new Set(fill.optionIds)];
    const texts = ids.map((id) => leftover.optionTexts.get(id));
    return ids.length === fill.optionIds.length && texts.every((text): text is string => typeof text === 'string') ? texts : null;
  };
  switch (leftover.kind) {
    case 'text':
    case 'combobox':
      if (fill.optionIds.length > 0 || fill.value === null) return null;
      return fits(fill.value.replace(/\s+/g, ' ').trim());
    case 'textarea':
      if (fill.optionIds.length > 0 || fill.value === null) return null;
      return fits(fill.value.trim());
    case 'date':
    case 'number': {
      if (fill.optionIds.length > 0 || fill.value === null) return null;
      const value = fill.value.trim();
      return (leftover.kind === 'date' ? ISO_DATE : NUMBER).test(value) ? fits(value) : null;
    }
    case 'select':
    case 'radio': {
      const texts = choices();
      return texts !== null && texts.length === 1 ? texts[0]! : null;
    }
    case 'checkbox': {
      const texts = choices();
      return texts !== null && texts.length > 0 ? texts.join('\n') : null;
    }
    default:
      return null;
  }
}

/**
 * 自动代答这一轮的结局（流结束之后）。除了被拒，都带上 `noEvidence`：送出去、AI 在资料里没找到依据的那几栏；
 * 与 `unanswered`：这一轮一个答案都没拿到的那几栏（那一道失败了、流断了）。都是第一遍扫描里的节点——浮层照实说
 * 原因，不再说「我们没认出这道题」。
 */
export type KernelAiAnswersOutcome =
  /** 没有能写的答案，或者这一轮已经作废。 */
  | Readonly<{ kind: 'NONE'; noEvidence: readonly Element[]; unanswered: readonly Element[] }>
  | Readonly<{ kind: 'REFUSED'; code: AiAnswersRefusal }>
  /** 点击后 30 秒之内到的，都用同一张凭证写了（按到达的先后一批一批写）。 */
  | Readonly<{ kind: 'APPLIED'; view: AuditView; written: number; noEvidence: readonly Element[]; unanswered: readonly Element[] }>
  /**
   * 有到晚了的：那几题一个字没写。要用户在浮层里再点一下（新的一张凭证，由调用方在点击当下取），只能用一次。
   * 早到、已经写上的留在页面上（`written`）。
   */
  | Readonly<{
    kind: 'READY';
    count: number;
    written: number;
    apply: (proof: TrustedGestureProof) => Promise<KernelAiWrite>;
    noEvidence: readonly Element[];
    unanswered: readonly Element[];
  }>;

/** 流还在走的时候，每到一批（写过之后）交给浮层的样子。 */
export interface KernelAiProgress {
  /** 最近一次写上之后的整张单子；还没写上过是 null。 */
  readonly view: AuditView | null;
  /** 到现在为止写上了几栏。 */
  readonly written: number;
  /** 送出去、还没有任何结果的题数。 */
  readonly pending: number;
  /**
   * 那几题在单子上的那几栏（第一遍扫描里的节点，与 `KernelAiHandle.targets` 同一批）：浮层据此只把它们画成
   * 「正在写」，写上的、AI 看过没找到依据的回到各自的样子。
   */
  readonly drafting: readonly Element[];
  readonly noEvidence: readonly Element[];
}

export interface KernelAiHandle {
  /** 送出去问了几道题。 */
  readonly asked: number;
  /**
   * 送出去的那几栏（第一遍扫描里的节点，与单子上那几行是同一批；只在本地）。AI 在起草时浮层据此不把它们列进
   * 「需要你」——它们还没有结论（2026-09-24）。
   */
  readonly targets: readonly Element[];
  readonly outcome: Promise<KernelAiAnswersOutcome>;
  /**
   * 旁边可以摆「用 AI 写 / AI 改写」的那几栏（2026-09-24 负责人）：送出去的题里的长文本题，连同送给改写端点的
   * 那份题目描述（不透明题号、题面、说明文字，没有选择器、没有现值）。
   */
  readonly revisable: readonly Readonly<{ element: Element; field: FullAiField }>[];
  /**
   * 用户在卡片里按「生成」、服务端写回一段文字之后：用那一下点击的凭证（调用方在点击当下取）写进这一栏。
   * `expected` 是按「生成」那一刻这一栏里的内容——写之前它变了就不写；原来就有内容的（改写）才允许替换，
   * 替换前的内容进撤销日志。
   */
  readonly write: (element: Element, value: string, proof: GestureRoot, expected: string) => Promise<KernelAiWrite>;
}

/**
 * 写入口说「这一轮已经不许写了」的那几种（中止、租约到期、页面换了、那一下点击不算数）：之后到的一批都不再写，
 * 也不改成按钮。别的拒绝只关那一批。
 */
const ROUND_OVER: ReadonlySet<ApplyErrorCode> = new Set<ApplyErrorCode>(['ABORTED', 'LEASE_INVALID', 'IDENTITY_CHANGED', 'GESTURE_UNTRUSTED']);

/** 这一轮的几个时刻要从点击起算，毫秒取整、不为负。 */
const MAX_TIMING_MS = 600_000;

/**
 * 一轮手势填写里的 AI 代答（只在手势路上用，所以整段放在这里，不进 mission 那条路共用的填写模块）：
 *
 *  1. `onPlanned`（内核在第一遍开写之前同步调用）：挑题、开一条流（一次点击只开一条），不等它。
 *  2. `attach(audit, onProgress)`（规则那几遍写完、单子交出来之后）：流上每到一批，就趁点击凭证还在 30 秒之内经内核
 *     写上（`writeAiAnswers`，与记住的答案同一条路；先到的先写，选择题不等开放题）；过了 30 秒到的一个字不写，
 *     结局里交回一个按钮。另给浮层「用 AI 写 / AI 改写」要的两样：可以写的长文本题，以及用那一下点击的凭证写一段文字。
 *  3. `cancel`（这一轮作废，或用户按了「停止」）：关掉那条流，之后到的什么都不写。
 *
 * 30 秒的点击凭证遇上一条流（2026-09-24 定的口径）：凭证还在时到的那几批，逐批用它写上；从第一次因凭证过期
 * （`GESTURE_EXPIRED`）写不成起，这一批与之后到的都不写、攒着，等流结束，结局是 `READY`——浮层摆「填入 AI 答案」，
 * 用户再点一下（新的凭证，只能用一次）才写这几题；早到、已经写上的留在页面上（`written`，收尾时算进「填好了」）。
 * 流还开着时进度卡一直在（#107），所以那颗按钮在流结束（`done`、断流、超时）之后才出现，不在途中另换一张脸。
 * 写入口说这一轮已经不许写了（`ROUND_OVER`：中止——包括按「停止」——、租约到期、页面换了、点击不算数）：之后到的
 * 都不写，也不改成按钮；别的拒绝只关那一批。
 *
 * 规则那几遍从不等它：流挂着不回、口子抛了、被拒了，规则填的照样填、单子照样交。
 * 计时（`onTiming`，流结束时一次）：从点击起算的请求发出、响应头、第一批选择题、第一批开放题、每次写入、晚到、结束，
 * 只有毫秒与个数。
 */
export function createAiAnswersSession(input: Readonly<{
  port: KernelAiAnswersPort;
  /** 那一下点击的凭证；连填（2026-09-28）翻到的那几页是那一轮发给这一页的凭证（活到这一轮的时限，AI 晚到也写得上）。 */
  gesture: GestureRoot;
  onTiming?: (marks: readonly AiTimingMark[]) => void;
  now?: () => number;
}>): Readonly<{
  onPlanned: (plan: ApplyPlan, descriptor: ApplyFormDescriptor) => void;
  attach: (audit: KernelFillAudit, onProgress?: (progress: KernelAiProgress) => void) => KernelAiHandle | undefined;
  cancel: () => void;
}> {
  const now = input.now ?? Date.now;
  let leftovers: readonly AiLeftover[] = [];
  let requested = false;
  let cancelled = false;
  let closeStream: (() => void) | null = null;
  /** 流上到了、还没被 `attach` 那一边取走的事（按到达的先后）。 */
  type StreamItem = Readonly<{ kind: 'batch'; batch: AiAnswersBatch }> | Readonly<{ kind: 'end'; end: AiAnswersEnd }>;
  const inbox: StreamItem[] = [];
  let wake: (() => void) | null = null;
  let ended = false;
  const deliver = (item: StreamItem): void => {
    if (ended) return;
    if (item.kind === 'end') ended = true;
    inbox.push(item);
    const waiting = wake;
    wake = null;
    waiting?.();
  };
  const next = async (): Promise<StreamItem> => {
    while (inbox.length === 0) await new Promise<void>((resolve) => { wake = resolve; });
    return inbox.shift()!;
  };
  const marks: AiTimingMark[] = [];
  const sinceClick = (): number => Math.min(MAX_TIMING_MS, Math.max(0, Math.round(now() - input.gesture.capturedAt)));
  const mark = (at: 'SENT' | 'OPEN' | 'FAST' | 'LONG' | 'DONE'): void => { marks.push(Object.freeze({ at, ms: sinceClick() })); };
  const counted = (at: 'WRITE' | 'READY', count: number): void => { marks.push(Object.freeze({ at, ms: sinceClick(), count })); };
  let timingSent = false;
  const sendTiming = (): void => {
    if (timingSent || marks.length === 0) return;
    timingSent = true;
    try {
      input.onTiming?.(Object.freeze(marks.slice(0, AI_TIMING_MAX_MARKS)));
    } catch {
      // 计时只是诊断：交不出去不影响写入。
    }
  };
  const unavailable: AiAnswersEnd = { ok: false, code: 'UNAVAILABLE' };
  const claimKeys = new Map<AiLeftover, Promise<string>>();
  const claimKeyOf = (leftover: AiLeftover): Promise<string> => {
    let key = claimKeys.get(leftover);
    if (key === undefined) {
      key = questionClaimKeyFor(questionIdentity(leftover.question));
      claimKeys.set(leftover, key);
    }
    return key;
  };
  /** 答案 → 内核的答案计划（题号是 claim key，与记住的答案同一个名字）。算不出 key 的那一条不要。 */
  const questionAnswers = async (values: readonly AiAnswerValue[]): Promise<QuestionAnswer[]> => {
    const answers: QuestionAnswer[] = [];
    for (const value of values) {
      let claimKey: string;
      try {
        claimKey = await claimKeyOf(value.leftover);
      } catch {
        continue;
      }
      answers.push({ questionId: claimKey.slice('question:'.length), element: value.leftover.element, value: value.value });
    }
    return answers;
  };
  const cancel = (): void => {
    if (cancelled) return;
    cancelled = true;
    const close = closeStream;
    closeStream = null;
    try {
      close?.();
    } catch {
      // 那条流已经断了：本来就不会再有东西来。
    }
    deliver({ kind: 'end', end: { ok: true, unanswered: [] } });
  };
  return Object.freeze({
    onPlanned: (plan: ApplyPlan, descriptor: ApplyFormDescriptor): void => {
      // 一次点击只问一次：同一轮里再有计划（加行、第二遍）也不再开流。
      if (requested || cancelled) return;
      requested = true;
      try {
        leftovers = selectAiLeftovers(plan, descriptor);
        if (leftovers.length === 0) return;
        let firstFast = true;
        let firstLong = true;
        mark('SENT');
        closeStream = input.port.request(leftovers.map((leftover) => leftover.field), {
          opened: () => { if (!ended) mark('OPEN'); },
          answers: (batch) => {
            if (ended) return;
            if (batch.lane === 'fast' && firstFast) { firstFast = false; mark('FAST'); }
            if (batch.lane === 'long' && firstLong) { firstLong = false; mark('LONG'); }
            deliver({ kind: 'batch', batch });
          },
          end: (end) => {
            if (ended) return;
            mark('DONE');
            deliver({ kind: 'end', end });
          },
        });
      } catch {
        // 挑题或开流自己出了错：这一轮就当没有 AI 答案（选出了题就记成「暂时用不了」），规则照常填。
        if (leftovers.length > 0) deliver({ kind: 'end', end: unavailable });
        else leftovers = [];
      }
    },
    cancel,
    attach: (audit: KernelFillAudit, onProgress?: (progress: KernelAiProgress) => void): KernelAiHandle | undefined => {
      const write = audit.writeAiAnswers;
      if (!requested || leftovers.length === 0) return undefined;
      if (write === undefined) {
        // 这张单子写不了 AI 答案：那条流不必再开着。
        cancel();
        return undefined;
      }
      const sent = leftovers;
      const byId = new Map(sent.map((leftover) => [leftover.id, leftover]));
      const elementsOf = (ids: Iterable<string>): Element[] => {
        const out: Element[] = [];
        for (const id of ids) {
          const leftover = byId.get(id);
          if (leftover !== undefined && !out.includes(leftover.element)) out.push(leftover.element);
        }
        return out;
      };
      const consume = async (): Promise<KernelAiAnswersOutcome> => {
        let written = 0;
        let view: AuditView | null = null;
        const late: QuestionAnswer[] = [];
        /** 这一轮已经不许再写（中止、租约到期、页面换了、作废）：之后到的一概不写。 */
        let stopped = false;
        const noEvidence = new Set<string>();
        const heard = new Set<string>();
        for (;;) {
          const item = await next();
          if (item.kind === 'end') {
            const end = item.end;
            const lateCount = late.length;
            if (lateCount > 0 && !stopped && !cancelled) counted('READY', lateCount);
            sendTiming();
            if (!end.ok && written === 0 && lateCount === 0) return { kind: 'REFUSED', code: end.code };
            const evidence = Object.freeze(elementsOf(noEvidence));
            const unanswered = Object.freeze(elementsOf(end.ok ? end.unanswered : sent.map((one) => one.id).filter((id) => !heard.has(id))));
            if (lateCount > 0 && !stopped && !cancelled) {
              let offered = true;
              return {
                kind: 'READY',
                count: lateCount,
                written,
                noEvidence: evidence,
                unanswered,
                apply: (proof) => {
                  if (!offered) return Promise.resolve({ ok: false, code: 'GRANT_CONSUMED' });
                  offered = false;
                  return write(late, proof, { fillEmptyOnly: true });
                },
              };
            }
            return written > 0 && view !== null
              ? { kind: 'APPLIED', view, written, noEvidence: evidence, unanswered }
              : { kind: 'NONE', noEvidence: evidence, unanswered };
          }
          const { batch } = item;
          for (const fill of batch.fills) heard.add(fill.id);
          for (const id of batch.noEvidence) {
            heard.add(id);
            noEvidence.add(id);
          }
          const answers = stopped || cancelled ? [] : await questionAnswers(aiAnswerValues(batch.fills, sent));
          if (answers.length > 0) {
            if (late.length > 0) late.push(...answers);
            else {
              const attempt = await write(answers, input.gesture, { fillEmptyOnly: true });
              if (attempt.ok) {
                written += attempt.written;
                if (attempt.written > 0) view = attempt.view;
                counted('WRITE', attempt.written);
              } else if (attempt.code === 'GESTURE_EXPIRED') late.push(...answers);
              // 这一轮已经不许写了：之后到的也不写（一次点击不能重开已停止的一轮）。别的拒绝只关这一批（那几题此刻
              // 写不进去：选项认不出、那一栏不见了……），之后到的照写。
              else if (ROUND_OVER.has(attempt.code)) stopped = true;
            }
          }
          if (!cancelled) {
            try {
              const drafting = sent.filter((one) => !heard.has(one.id));
              onProgress?.(Object.freeze({
                view,
                written,
                pending: drafting.length,
                drafting: Object.freeze(elementsOf(drafting.map((one) => one.id))),
                noEvidence: Object.freeze(elementsOf(noEvidence)),
              }));
            } catch {
              // 浮层画不出来不影响写入与结局。
            }
          }
        }
      };
      const revisable = sent.filter(isRevisable);
      return Object.freeze({
        asked: sent.length,
        targets: Object.freeze(sent.map((leftover) => leftover.element)),
        outcome: consume().catch((): KernelAiAnswersOutcome => ({ kind: 'NONE', noEvidence: [], unanswered: [] })),
        revisable: revisable.map((leftover) => Object.freeze({ element: leftover.element, field: leftover.field })),
        write: async (element: Element, value: string, proof: GestureRoot, expected: string): Promise<KernelAiWrite> => {
          const leftover = revisable.find((one) => one.element === element);
          if (leftover === undefined) return { ok: false, code: 'LEASE_INVALID' };
          const answers = await questionAnswers(aiAnswerValues([{ id: leftover.id, value, optionIds: [] }], [leftover]));
          if (answers.length === 0) return { ok: false, code: 'VALUE_COERCED' };
          return write(answers, proof, { fillEmptyOnly: expected.trim() === '', unchangedFrom: expected });
        },
      });
    },
  });
}
