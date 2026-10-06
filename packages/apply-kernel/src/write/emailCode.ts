/**
 * 把用户本人在我方浮层里输入或粘贴的验证码写进网站的验证码格（2026-10-04，负责人：验证码第 1 步）。
 *
 * 验证码照旧由用户本人完成（RULE-GLOBAL-HUMAN-AUTHORIZATION）：码是他去自己的邮箱里看到、亲手输进我们浮层的；插件不读
 * 邮件、不从资料、答案记忆、AI 或任何别处取码，填写计划也照旧不碰验证码格（`sensitiveProposal.ts` 的 OTP_OR_2FA、
 * `dict/guards.ts`）。这里只做「他输的这一串 → 规则声明的那一格或那几格」这一件事，写完也不提交：下一步（再按一次提交，
 * 或按网站上的验证钮）照旧由他按（RULE-EXT-NEVER-SUBMIT）。
 *
 * 写法与文本框同一套（原型上的 value setter，再按 `EVENT_PROFILES.text` 发 input/change/blur/focusout，只经白名单里的派发
 * 口），差别全在准入：
 *  · 票是那一下点击铸的（`mintAuthorityFromGesture`，`set-text`），此刻活着；调用方交来的写策略整体开着、`set-text` 开着；
 *  · 那一串整理之后位数与字符都对（`normalizeEmailCode`），不对就一格都不碰；
 *  · 元素就是规则解释器此刻认出的那一格或那几格（`isCurrent()`），每一格再核一遍：连着、不是禁用或只读、是文本框；
 *  · 写完当场读回：读回的不是写进去的就报 `WRITE_REVERTED`（已经写上的不清空——他在网站上看得见、改得了）。
 *
 * 值只在这一层用一次：不进返回值、不进任何回报与日志（RULE-GLOBAL-DATA-L1）。
 */

import type { EmailCodePrompt } from '../contracts.ts';
import { checkActiveCapability, type HostWriteAuthority, type WriteCapability } from '../grant.ts';
import { normalizeEmailCode } from '../rules/emailVerification.ts';
import { dispatchHostEvent, EVENT_PROFILES } from './allowlist.ts';

export { normalizeEmailCode } from '../rules/emailVerification.ts';

/** 这一写只看策略里这两样；与别的写入原语交来的是同一个投影。 */
interface EmailCodeWritePolicy {
  readonly enabled: boolean;
  readonly capabilities: Readonly<Record<WriteCapability, boolean>>;
}

/**
 * 这一写的结果。码只在内容脚本与浮层之间说「为什么没写上」，不落到任何一栏、回执、遥测或诊断上，所以不进
 * `ApplyErrorCode`（那是跨边界的契约）。
 */
export type EmailCodeWriteResult = Readonly<{ ok: true }> | Readonly<{ ok: false; code: EmailCodeWriteError }>;

export type EmailCodeWriteError =
  | 'POLICY_DISABLED'
  | 'CAPABILITY_DISABLED'
  | 'GESTURE_UNTRUSTED'
  | 'GESTURE_EXPIRED'
  /** 他输的那一串位数或字符对不上网站要的验证码。 */
  | 'CODE_FORMAT'
  /** 网站此刻不在要验证码了，或者那几格换了。 */
  | 'PROMPT_GONE'
  | 'TARGET_NOT_WRITABLE'
  | 'WRITE_REVERTED';

const CODE_INPUT_TYPES: ReadonlySet<string> = new Set(['', 'text', 'tel', 'number']);

function writable(input: HTMLInputElement): boolean {
  if (!input.isConnected || input.localName !== 'input' || input.disabled || input.readOnly) return false;
  return CODE_INPUT_TYPES.has((input.getAttribute('type') ?? '').trim().toLowerCase());
}

function nativeInputValueSetter(element: HTMLInputElement): ((value: string) => void) | null {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  return setter === undefined ? null : (value: string) => setter.call(element, value);
}

export function writeEmailCode(input: Readonly<{
  prompt: EmailCodePrompt;
  /** 他在浮层里输入或粘贴的那一串（原样交进来，这里整理）。 */
  code: string;
  authority: HostWriteAuthority;
  policy: EmailCodeWritePolicy;
}>): EmailCodeWriteResult {
  const { prompt, authority, policy } = input;
  if (!policy.enabled) return { ok: false, code: 'POLICY_DISABLED' };
  if (!policy.capabilities['set-text']) return { ok: false, code: 'CAPABILITY_DISABLED' };
  const access = checkActiveCapability(authority, 'set-text');
  if (!access.ok) return { ok: false, code: access.code };
  const code = normalizeEmailCode(input.code, prompt.length, prompt.charset);
  if (code === null) return { ok: false, code: 'CODE_FORMAT' };
  let current = false;
  try {
    current = prompt.isCurrent();
  } catch {
    current = false;
  }
  if (!current) return { ok: false, code: 'PROMPT_GONE' };
  const targets = prompt.inputs;
  // 一格收整串，或每格一个字符（解释器已经保证格数是这两种之一）。
  const pieces = targets.length === 1 ? [code] : targets.length === code.length ? [...code] : null;
  if (pieces === null || !targets.every(writable)) return { ok: false, code: 'TARGET_NOT_WRITABLE' };
  for (const [index, target] of targets.entries()) {
    // 宿主在上一格的 input 里可能重画了这一格：不在了就不写，读回会照实报。
    if (!writable(target)) return { ok: false, code: 'TARGET_NOT_WRITABLE' };
    const setter = nativeInputValueSetter(target);
    if (setter === null) return { ok: false, code: 'TARGET_NOT_WRITABLE' };
    setter(pieces[index]!);
    for (const event of EVENT_PROFILES.text) dispatchHostEvent(target, event);
  }
  return targets.every((target, index) => target.value === pieces[index])
    ? { ok: true }
    : { ok: false, code: 'WRITE_REVERTED' };
}
