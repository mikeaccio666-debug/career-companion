/**
 * 账号墙上的那几格（2026-09-28）：往规则声明的邮箱栏、密码栏、再输一次密码栏写用户自己的邮箱与这台电脑上保存的密码。
 *
 * 写法与文本框同一套（原型上的 value setter，再按 `EVENT_PROFILES.text` 发 input/change/blur/focusout，只经白名单里的
 * 派发口），差别全在准入：
 *
 *  · 票必须是 `account-access` 专用票、此刻活着（grant.ts 的 `mintAccountAccessAuthority` 铸，同步的那一段里 consume 过）；
 *  · 调用方交来的策略整体开着、`account-access` 位开着——每一格都重读，远程关掉立刻停；
 *  · 元素就是规则解释器交出的账号墙这一步里那个角色的那一格（调用方交元素之前先问 `isCurrent()`）；这里再核一遍形状：
 *    两个密码栏必须是 `type=password`，邮箱栏必须是可见的文本框（不是密码框、不是隐藏框）；禁用、只读的不写；
 *  · 写完当场读回：读回的不是写进去的就报 `WRITE_REVERTED`，调用方不再往下按提交。
 *
 * 值只在这一层用一次：不进返回值、不进任何回报与日志（密码是 Data-L1 之上的东西，RULE-GLOBAL-DATA-L1）。
 */

import type { AccountFieldRole, Result } from '../contracts.ts';
import { checkActiveCapability, type HostWriteAuthority, type WriteCapability } from '../grant.ts';
import { dispatchHostEvent, EVENT_PROFILES } from './allowlist.ts';

/** 这一写只看策略里这两样；与点击原语交来的是同一个投影。 */
interface AccountWritePolicy {
  readonly enabled: boolean;
  readonly capabilities: Readonly<Record<WriteCapability, boolean>>;
}

/** 邮箱与密码的长度上限：邮箱按 RFC 5321 的 254；密码 128（我们生成的 16 位，用户自己设的至多 64）。 */
const MAX_LENGTH: Readonly<Record<AccountFieldRole, number>> = { email: 254, password: 128, verifyPassword: 128 };

export type AccountFieldWriteError =
  | 'POLICY_DISABLED'
  | 'CAPABILITY_DISABLED'
  | 'GESTURE_UNTRUSTED'
  | 'GESTURE_EXPIRED'
  | 'DETACHED'
  | 'TARGET_NOT_WRITABLE'
  | 'WRITE_REVERTED';

function nativeInputValueSetter(element: HTMLInputElement): ((value: string) => void) | null {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  return setter === undefined ? null : (value: string) => setter.call(element, value);
}

/** 形状对不对得上这个角色（与解释器 `accountWall.ts` 的 `fieldFits` 同一把尺，写之前再量一次）。 */
function fits(role: AccountFieldRole, element: HTMLInputElement): boolean {
  if (element.localName !== 'input') return false;
  const type = (element.getAttribute('type') ?? '').trim().toLowerCase();
  return role === 'email' ? type === '' || type === 'text' || type === 'email' : type === 'password';
}

export function writeAccountField(input: Readonly<{
  element: HTMLInputElement;
  role: AccountFieldRole;
  value: string;
  authority: HostWriteAuthority;
  policy: AccountWritePolicy;
}>): Result<void, AccountFieldWriteError> {
  const { element, role, value, authority, policy } = input;
  if (!policy.enabled) return { ok: false, code: 'POLICY_DISABLED' };
  if (!policy.capabilities['account-access']) return { ok: false, code: 'CAPABILITY_DISABLED' };
  const access = checkActiveCapability(authority, 'account-access');
  if (!access.ok) return access;
  if (!element.isConnected) return { ok: false, code: 'DETACHED' };
  if (!fits(role, element) || element.disabled || element.readOnly) return { ok: false, code: 'TARGET_NOT_WRITABLE' };
  if (value === '' || value.length > MAX_LENGTH[role]) return { ok: false, code: 'TARGET_NOT_WRITABLE' };
  const setter = nativeInputValueSetter(element);
  if (setter === null) return { ok: false, code: 'TARGET_NOT_WRITABLE' };
  setter(value);
  for (const event of EVENT_PROFILES.text) dispatchHostEvent(element, event);
  return element.value === value ? { ok: true, value: undefined } : { ok: false, code: 'WRITE_REVERTED' };
}
