/**
 * 替他过数据同意页的那一下（2026-10-04，负责人 D7）：在规则声明的居住地下拉里选一项。
 *
 * Jobvite 的「Data Consent」页上，「Location of Residence and Language」的每一项是一份隐私条款。选中之后网站去取那一份：
 * 默认的那一份它当场自己提交、整页跳到申请表；别的把条款摆出来，下面一颗「Accept」——那一颗这一版不按，交还本人。
 *
 * 这一下能不能做，全在这里判：
 *  · 运行时包整体开着、`sign-on-behalf` 位开着（每次重读，远程关掉立刻停）；
 *  · 同意页此刻仍是解释器交出的那一页（`isCurrent()`：同一张表、同一个下拉）；
 *  · 票只从 `mintConsentGateAuthority` 铸（票上只有 `sign-on-behalf`），信任根是一次真实点击；在这一段同步里
 *    consume、用完 release；
 *  · 选的那一项是下拉里真有的一项、不是占位（value 为空）、没停用。
 * 写法与原生下拉同一套：只动 `selectedIndex`（经原型上的 setter），再按 `EVENT_PROFILES.select` 派 input/change，只经
 * 白名单里的派发口；写完当场读回。选哪一项（他资料里的居住国）由 dict/consentGate.ts 判，用户的同意由 worker 读。
 */

import type { ConsentGateReading, Result } from './contracts.ts';
import { checkActiveCapability, consumeAuthority, mintConsentGateAuthority, releaseAuthority, type GestureRoot } from './grant.ts';
import type { ApplyPolicy } from './policy.ts';
import { dispatchHostEvent, EVENT_PROFILES } from './write/allowlist.ts';

export type ConsentGateChoiceError =
  | 'POLICY_DISABLED'
  | 'CAPABILITY_DISABLED'
  | 'IDENTITY_CHANGED'
  | 'GESTURE_UNTRUSTED'
  | 'GESTURE_EXPIRED'
  | 'GRANT_CONSUMED'
  | 'DETACHED'
  | 'TARGET_NOT_WRITABLE'
  | 'WRITE_REVERTED';

export function chooseConsentGateResidence(input: Readonly<{
  reading: ConsentGateReading;
  /** 下拉里那一项的序号（`HTMLSelectElement.options` 的下标）。 */
  index: number;
  /** 一次真实点击的凭证（他按了我们的「自动填写」）。 */
  proof: GestureRoot;
  /** 此刻重读的写策略。 */
  policy: Pick<ApplyPolicy, 'enabled' | 'capabilities'>;
  now?: number;
}>): Result<void, ConsentGateChoiceError> {
  const { reading, index, policy } = input;
  if (!policy.enabled) return { ok: false, code: 'POLICY_DISABLED' };
  if (policy.capabilities['sign-on-behalf'] !== true) return { ok: false, code: 'CAPABILITY_DISABLED' };
  let current = false;
  try {
    current = reading.isCurrent();
  } catch {
    current = false;
  }
  if (!current) return { ok: false, code: 'IDENTITY_CHANGED' };
  const select = reading.residence;
  if (select === null) return { ok: false, code: 'TARGET_NOT_WRITABLE' };
  if (!select.isConnected) return { ok: false, code: 'DETACHED' };
  const option = Number.isInteger(index) && index >= 0 && index < select.options.length ? select.options[index] : undefined;
  if (option === undefined || option.value === '' || option.disabled || select.disabled) return { ok: false, code: 'TARGET_NOT_WRITABLE' };
  const now = input.now ?? Date.now();
  const minted = mintConsentGateAuthority({ proof: input.proof, now });
  if (!minted.ok) return minted;
  const consumed = consumeAuthority(minted.value, now);
  if (!consumed.ok) return consumed;
  try {
    const access = checkActiveCapability(consumed.value, 'sign-on-behalf', now);
    if (!access.ok) return access;
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'selectedIndex')?.set;
    if (setter === undefined) return { ok: false, code: 'TARGET_NOT_WRITABLE' };
    setter.call(select, index);
    for (const event of EVENT_PROFILES.select) dispatchHostEvent(select, event);
    return select.selectedIndex === index ? { ok: true, value: undefined } : { ok: false, code: 'WRITE_REVERTED' };
  } finally {
    releaseAuthority(consumed.value);
  }
}
