/**
 * 邮箱验证的解释（2026-10-04，负责人：验证码第 1 步——网站把验证码发到申请人的邮箱，他在我方浮层里输或粘贴，插件写进
 * 网站的那一格）。
 *
 * 规则（`emailVerification`，见 schema.ts 的 `EmailVerificationRule`）只说「网站要验证码时页面长什么样」：提示的容器、
 * 那一格或那几格、几位、什么字符、发到哪个邮箱写在哪、网站在哪儿说验证码不对或过期了。这里把它解释成 selector-free 的
 * 活元素与一次同步复核，交给扩展——扩展从不接触选择器（RULE-GLOBAL-DOM-RULE-BOUNDARY）。
 *
 * 全部 fail closed：容器不止一个、那几格的数目不对、某一格不是文本框（密码框、隐藏框、邮箱框都不是验证码格）、被禁用或
 * 只读、看不见，都答「认不出」——浮层照旧说「去网站上输入验证码」，而认错一格的后果是把验证码写进别的栏。
 *
 * 这里只读 DOM、不写、不点、不碰布局（RULE-KERNEL-DETERMINISTIC-BOUNDARY）：看不看得见由调用方量好交进来。规则里没有
 * 授权：写不写由用户在我方浮层里的那一下真实点击与运行时包的写策略决定（`write/emailCode.ts`）。
 */

import type { EmailCodeError, EmailCodePrompt, EmailCodePromptRule, EmailVerificationRule } from '../contracts.ts';

/** 验证码格能是什么样的 `<input>`：文本、电话、数字键盘，或没写 type。密码、邮箱、隐藏框一律不是。 */
const CODE_INPUT_TYPES: ReadonlySet<string> = new Set(['', 'text', 'tel', 'number']);
/** 网站那一句原话在浮层上最多显示多长。 */
const ERROR_TEXT_LIMIT = 160;
/** 像邮箱的那一段（网站可能打了码：`a••••@g••••.com` 也照登）。只用来给他看发到了哪个收件箱。 */
const EMAIL_SHAPE = /[^\s@<>()"',;:]{1,64}@[^\s@<>()"',;:]{1,190}\.[^\s@<>()"',;:.]{2,24}/u;
/** 他粘贴进来的验证码里允许夹着的分隔：空白与各种横线（邮件里常写成「AB12 CD34」「123-456」）。 */
const CODE_SEPARATORS = /[\s\u2010-\u2015\u2212-]/gu;
const CODE_CHARSETS: Readonly<Record<EmailCodePromptRule['charset'], RegExp>> = {
  digits: /^[0-9]+$/u,
  alphanumeric: /^[A-Za-z0-9]+$/u,
};

/**
 * 把他输入或粘贴的那一串整理成网站要的验证码：全角转半角（中文输入法打出来的数字）、去掉空白与横线；位数或字符对不上
 * 就是 null（不猜、不截、不改大小写）。
 */
export function normalizeEmailCode(raw: string, length: number, charset: EmailCodePromptRule['charset']): string | null {
  if (typeof raw !== 'string') return null;
  const code = raw.normalize('NFKC').replace(CODE_SEPARATORS, '');
  if (code.length !== length) return null;
  return CODE_CHARSETS[charset].test(code) ? code : null;
}

function inputType(element: Element): string {
  return (element.getAttribute('type') ?? '').trim().toLowerCase();
}

function textOf(element: Element): string {
  return (element.textContent ?? '').replace(/\s+/gu, ' ').trim();
}

function safeShown(isVisible: (element: Element) => boolean, element: Element): boolean {
  try {
    return isVisible(element) === true;
  } catch {
    return false;
  }
}

function all(scope: ParentNode, selector: string): Element[] | null {
  try {
    return Array.from(scope.querySelectorAll(selector));
  } catch {
    // 坏选择器是坏规则，不是「可以猜一下」。
    return null;
  }
}

/** 容器里规则声明的那一格或那几格；数目、类型、可写、看得见，任何一样不对就是 null。 */
function bindInputs(
  container: Element,
  rule: EmailCodePromptRule,
  isVisible: (element: Element) => boolean,
): HTMLInputElement[] | null {
  const found = all(container, rule.inputs);
  if (found === null || found.length === 0) return null;
  if (found.length !== 1 && found.length !== rule.length) return null;
  // 不止一格就是每格一个字符（上面已经要求格数等于位数）。
  const perChar = found.length > 1;
  for (const element of found) {
    if (element.localName !== 'input' || !CODE_INPUT_TYPES.has(inputType(element))) return null;
    const input = element as HTMLInputElement;
    if (input.disabled || input.readOnly || !safeShown(isVisible, input)) return null;
    // 一格收整串：网站限的长度装得下这么多位；每格一个字符：至少装得下一个。
    const room = input.maxLength;
    if (room !== -1 && room < (perChar ? 1 : rule.length)) return null;
  }
  return found as HTMLInputElement[];
}

/** 每一条提示的结局正则只编译一次（规则对象是冻结的、解析一次用很久）。 */
const OUTCOME_REGEXES = new WeakMap<EmailCodePromptRule, readonly Readonly<{ kind: EmailCodeError; text: RegExp }>[]>();

function outcomesOf(rule: EmailCodePromptRule): readonly Readonly<{ kind: EmailCodeError; text: RegExp }>[] {
  let compiled = OUTCOME_REGEXES.get(rule);
  if (compiled === undefined) {
    compiled = rule.outcomes.map((outcome) => ({ kind: outcome.kind, text: new RegExp(outcome.text.source, outcome.text.flags ?? '') }));
    OUTCOME_REGEXES.set(rule, compiled);
  }
  return compiled;
}

function readError(page: ParentNode, rule: EmailCodePromptRule, isVisible: (element: Element) => boolean): EmailCodePrompt['error'] {
  if (rule.errors === null) return null;
  for (const node of all(page, rule.errors) ?? []) {
    if (!safeShown(isVisible, node)) continue;
    const text = textOf(node);
    if (text === '') continue;
    const kind: EmailCodeError = outcomesOf(rule).find((outcome) => outcome.text.test(text))?.kind ?? 'unrecognized';
    return Object.freeze({ kind, text: text.slice(0, ERROR_TEXT_LIMIT), node });
  }
  return null;
}

function readRecipient(container: Element, rule: EmailCodePromptRule): string | null {
  if (rule.recipient === null) return null;
  for (const node of all(container, rule.recipient) ?? []) {
    const match = EMAIL_SHAPE.exec(textOf(node));
    if (match !== null) return match[0];
  }
  return null;
}

/**
 * 此刻网站是不是在要邮件里的验证码：按规则声明的顺序看每一种提示，容器不在、或在但收着就看下一种；在、而且看得见，
 * 那几格却对不上，就说不清（null），不往后猜别的提示。认出来了交回那几格、几位、什么字符、下一步、发到哪个邮箱、网站此刻
 * 说了什么、那几格填满没有，以及一次同步复核。
 *
 * 不挂在适配器上：只有浮层那一路（内容脚本的 verificationCodePage）叫它，浮层挂不出来的构建里它随之被删掉。
 */
export function resolveEmailCodePrompt(
  rule: EmailVerificationRule,
  page: ParentNode,
  isVisible: (element: Element) => boolean,
): EmailCodePrompt | null {
  for (const prompt of rule.codePrompts) {
    const containers = all(page, prompt.container);
    if (containers === null || containers.length > 1) return null;
    const container = containers[0];
    // 容器不在、或在但收着：网站此刻没在要验证码，看下一种。
    if (container === undefined || !safeShown(isVisible, container)) continue;
    const inputs = bindInputs(container, prompt, isVisible);
    // 网站在要验证码，那几格却对不上：说不清，不往后猜别的提示。
    if (inputs === null) return null;
    const values = inputs.map((input) => input.value);
    const typed = inputs.length === 1 ? values[0] ?? '' : values.every((value) => value.length === 1) ? values.join('') : '';
    const filled = typed !== '' && normalizeEmailCode(typed, prompt.length, prompt.charset) === typed;
    const isCurrent = (): boolean => {
      try {
        const again = all(page, prompt.container);
        if (again === null || again.length !== 1 || again[0] !== container || !container.isConnected) return false;
        if (!safeShown(isVisible, container)) return false;
        const rebound = bindInputs(container, prompt, isVisible);
        return rebound !== null && rebound.length === inputs.length && rebound.every((input, index) => input === inputs[index]);
      } catch {
        return false;
      }
    };
    return Object.freeze({
      inputs: Object.freeze([...inputs]),
      length: prompt.length,
      charset: prompt.charset,
      next: prompt.next,
      recipient: readRecipient(container, prompt),
      error: readError(page, prompt, isVisible),
      filled,
      isCurrent,
    });
  }
  return null;
}
