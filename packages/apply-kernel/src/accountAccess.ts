/**
 * 替用户在账号墙上动手的那几下（2026-09-28，负责人：像 Jobright 那样替用户注册、登录 Workday／iCIMS）。
 *
 * 三个动作，各自一张票、各自一段同步：写那几格（`fillAccountFields`）、勾注册条款（`tickAccountTerms`）、按规则声明的
 * 一颗（`pressAccountControl`：「用邮箱登录」、切到登录／注册、提交）。拆开是为了让网站在两下之间把刚写的值收进它自己的
 * 状态、把「Next」从禁用变成可按（iCIMS 要先勾「I accept」）——等多久、按什么次序，由扩展的编排决定；每一下能不能做，
 * 全在这里判：
 *
 *  · 账号墙这一步此刻仍是解释器交出的那一步（`isCurrent()`：容器、标志、每一格每一颗都是同一个节点）；
 *  · 票只从 `mintAccountAccessAuthority` 铸（票上只有 `account-access`），信任根是一次真实点击或那一下点击开出的一轮里
 *    「这一页」的凭证；在这一段同步里 consume、用完 release，出了这一段就用不了；
 *  · 写入原语与点击原语各自再读一次策略里的 `account-access` 位（`write/accountCredential.ts`、`click/primitives.ts`）。
 *
 * 用户的同意不在这里：worker 在交出密码之前读他同意过的那一版文案（两把钥匙缺一把，扩展就拿不到密码，也就走不到这里）。
 * 这里不等、不轮询、不碰布局；看不看得见由调用方量好交进来。
 */

import type { AccountControlRole, AccountWallStep, ApplyErrorCode, Result } from './contracts.ts';
import {
  consumeAuthority,
  mintAccountAccessAuthority,
  releaseAuthority,
  type GestureRoot,
  type HostWriteAuthority,
} from './grant.ts';
import type { ApplyPolicy } from './policy.ts';
import { activateAccountControl } from './click/primitives.ts';
import { writeAccountField } from './write/accountCredential.ts';

export type AccountActionError = Extract<ApplyErrorCode,
  | 'IDENTITY_CHANGED'
  | 'GESTURE_UNTRUSTED'
  | 'GESTURE_EXPIRED'
  | 'GRANT_CONSUMED'
  | 'POLICY_DISABLED'
  | 'CAPABILITY_DISABLED'
  | 'DETACHED'
  | 'TARGET_NOT_WRITABLE'
  | 'WRITE_REVERTED'
  | 'CLICK_DENIED'
  | 'ABORTED'>;

interface AccountActionBase {
  readonly step: AccountWallStep;
  /** 一次真实点击的凭证，或那一下点击开出的一轮里「这一页」的凭证。 */
  readonly proof: GestureRoot;
  /** 此刻重读的写策略（与填写同一条路解出来的 fillPolicy）。 */
  readonly policy: ApplyPolicy;
  readonly now?: number;
}

/** 在这一步仍然是那一步时，铸一张账号票、consume，交给 `act` 在同一段同步里用完，最后 release。 */
function withAccountAuthority<T>(
  input: AccountActionBase,
  act: (authority: HostWriteAuthority) => Result<T, AccountActionError>,
): Result<T, AccountActionError> {
  let current = false;
  try {
    current = input.step.isCurrent();
  } catch {
    current = false;
  }
  if (!current) return { ok: false, code: 'IDENTITY_CHANGED' };
  const now = input.now ?? Date.now();
  const minted = mintAccountAccessAuthority({ proof: input.proof, now });
  if (!minted.ok) return minted;
  const consumed = consumeAuthority(minted.value, now);
  if (!consumed.ok) return consumed;
  try {
    return act(consumed.value);
  } finally {
    releaseAuthority(consumed.value);
  }
}

/**
 * 写这一步的那几格：邮箱；登录与注册还有密码；注册页声明了「再输一次」就再写一遍同一个密码。
 * 「先报邮箱」那一步（iCIMS）只写邮箱。「选怎么登录」那一步没有格可写。任何一格写不上，后面的不再写。
 */
export function fillAccountFields(input: AccountActionBase & Readonly<{ email: string; password: string }>): Result<void, AccountActionError> {
  const { step } = input;
  if (step.kind === 'choice') return { ok: false, code: 'TARGET_NOT_WRITABLE' };
  return withAccountAuthority(input, (authority) => {
    const email = step.fields.email;
    if (email === undefined) return { ok: false, code: 'TARGET_NOT_WRITABLE' };
    const writes: Array<readonly [HTMLInputElement, 'email' | 'password' | 'verifyPassword', string]> = [[email, 'email', input.email]];
    if (step.kind === 'signIn' || step.kind === 'createAccount') {
      const password = step.fields.password;
      if (password === undefined) return { ok: false, code: 'TARGET_NOT_WRITABLE' };
      writes.push([password, 'password', input.password]);
      const verify = step.fields.verifyPassword;
      if (step.kind === 'createAccount' && verify !== undefined) writes.push([verify, 'verifyPassword', input.password]);
    }
    for (const [element, role, value] of writes) {
      const written = writeAccountField({ element, role, value, authority, policy: input.policy });
      if (!written.ok) return written;
    }
    return { ok: true, value: undefined };
  });
}

/**
 * 勾注册条款（规则声明了才有）：已经勾着就不动；没有这一格就是 `NONE`。勾完读回，没勾上报 `WRITE_REVERTED`。
 * 条款的字里掺了注册之外的授权（营销、短信、背景调查……），点击策略会拒——那一格交还本人。
 */
export function tickAccountTerms(
  input: AccountActionBase & Readonly<{ isVisible: (element: Element) => boolean }>,
): Result<'TICKED' | 'ALREADY' | 'NONE', AccountActionError> {
  const terms = input.step.controls.terms;
  if (terms === undefined) return { ok: true, value: 'NONE' };
  if ((terms as HTMLInputElement).checked === true) return { ok: true, value: 'ALREADY' };
  return withAccountAuthority(input, (authority) => {
    const pressed = activateAccountControl({
      element: terms,
      role: 'terms',
      root: input.step.root,
      authority,
      policy: input.policy,
      isLikelyOffscreen: !safeVisible(input.isVisible, terms),
    });
    if (!pressed.ok) return pressed;
    return (terms as HTMLInputElement).checked === true ? { ok: true, value: 'TICKED' } : { ok: false, code: 'WRITE_REVERTED' };
  });
}

/** 按这一步里规则声明的一颗：「用邮箱登录」、切到登录／注册、或提交。这一步没声明这一颗就是 `TARGET_NOT_WRITABLE`。 */
export function pressAccountControl(
  input: AccountActionBase & Readonly<{ role: Exclude<AccountControlRole, 'terms'>; isVisible: (element: Element) => boolean }>,
): Result<void, AccountActionError> {
  const element = input.step.controls[input.role];
  if (element === undefined) return { ok: false, code: 'TARGET_NOT_WRITABLE' };
  return withAccountAuthority(input, (authority) => activateAccountControl({
    element,
    role: input.role,
    root: input.step.root,
    authority,
    policy: input.policy,
    isLikelyOffscreen: !safeVisible(input.isVisible, element),
  }));
}

function safeVisible(isVisible: (element: Element) => boolean, element: Element): boolean {
  try {
    return isVisible(element) === true;
  } catch {
    return false;
  }
}
