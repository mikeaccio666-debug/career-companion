/**
 * 勾选一个复选框，使宿主框架相信是用户本人勾的。
 *
 * 唯一的 `checked` 写入原语。只服务于 `PD-2026-08-18-IRONCLAD-5-SPLIT` 的
 * 乙档「信息属实」声明——**不是**通用复选框写入能力。
 *
 * ## 为什么不能直接 `element.checked = true`
 *
 * 与 `setValue.ts` 同一个坑：React 在元素实例上装了自己的 `checked` setter
 * 并维护一份私有 tracker。走实例 setter 会同时更新 DOM 与 tracker，
 * 于是随后派发的 `change` 被判为 no-op，React 把**旧值**重新渲染回来。
 * 走**原型上的原生 setter** 才能写 DOM 而让 tracker 变陈旧，
 * 事件才被读成真正的用户改动。
 *
 * ## 写入前重读宿主 DOM（这一段是本文件存在的第二个理由）
 *
 * 用户是在**确认条上看到某一段原文**之后放行的。从那一刻到真正写入之间，
 * 宿主页面可能已经改了措辞（重渲染、A/B、多步表单换页）。
 * 所以写入前必须通过 kernel 品牌的 ScanRoot **就地重读 label**，
 * 与放行时的本地原文不等即拒写。调用方不能注入 reader 或 digest。
 *
 * 这不是防篡改（我们不在对抗宿主），是防**张冠李戴**：
 * 用户看的是甲声明，勾上的却成了乙声明。
 *
 * ## 边界
 *
 * 只写 `checked`，只发 `input` / `change`。不碰属性、样式、类、节点结构，
 * 不派发 `click`（`click` 会触发宿主的 label 联动与表单提交路径）。
 * 铁律 4 原文允许的四项里，这是最后一项被用上的。
 */

import { checkActiveCapability, type HostWriteAuthority } from '../grant';
import { revalidateAttestationCandidate, type AttestationCandidate } from '../attest';
import { dispatchHostEvent } from './allowlist';

/**
 * 本模块自己的结果类型，**刻意不用共享的 `Result`**：那个类型把错误码约束到
 * `APPLY_ERROR_CODES` 闭集，而这几个码是写入原语的内部失败形态，
 * 不该出现在给用户看的原因码表里（那张表是 UI 文案的全量映射源）。
 */
export type SetCheckedResult =
  | { readonly ok: true; readonly value: SetCheckedOk }
  | { readonly ok: false; readonly error: SetCheckedError };

export type SetCheckedError =
  /** 授权里没有 set-attestation——包内策略默认就是关的（C3 放行闸）。 */
  | 'CAPABILITY_DISABLED'
  /** 目标不是复选框。乙档只勾 checkbox，radio 是单选语义、不在本版范围。 */
  | 'NOT_A_CHECKBOX'
  /** 元素已经离开文档——多步表单换页后最常见。 */
  | 'DETACHED'
  /** 页面上的声明文案与用户放行时看到的不一致，拒写。 */
  | 'ATTESTATION_TEXT_CHANGED'
  /** 候选不是由可信 ScanRoot 产生，或目标身份/分类已变。 */
  | 'ATTESTATION_CANDIDATE_INVALID'
  /**
   * 写完读回发现没生效。
   *
   * 审查实测（2026-08-19）：宿主页若覆盖了原型上的 `checked` 访问器，
   * `Object.getOwnPropertyDescriptor(proto,'checked').set` 拿到的就是
   * **宿主自己的 setter**——调用它等于把写入交给宿主代码，
   * 而它可以什么都不做。原实现返回 `ok:true / changed:true`，
   * **DOM 根本没变**，回执与 undo journal 会记下一个从未发生过的状态。
   *
   * 本仓其他写入原语都不是这样：`runner.ts` 有完整读回校验，
   * `dict/controls.ts:33` 还记着 2026-08-01 Greenhouse 的实测教训——
   * 「落早了**把一次什么都没填的写入报成成功**」。
   */
  | 'WRITE_REVERTED';

export interface SetCheckedInput {
  readonly candidate: AttestationCandidate;
  readonly authority: HostWriteAuthority;
}

export interface SetCheckedOk {
  /** 本次是否真的改动了宿主（已经勾上时为 false）。 */
  readonly changed: boolean;
  /** 写入前的原值，供 undo。 */
  readonly previousChecked: boolean;
}

/**
 * 这个元素自己那一类的原型级 `checked` setter。
 *
 * 每次调用现取而不在模块级缓存：跨源 iframe 里我们可能跑在与本模块求值时
 * 不同的 realm 上，缓存下来的 setter 会写到另一个 realm 的原型。
 * 与 `setValue.ts` 的 `nativeValueSetter` 同一条理由。
 */
function nativeCheckedSetter(element: HTMLInputElement): ((value: boolean) => void) | null {
  // ⚠️ 取**固定的 `HTMLInputElement.prototype`**，不用 `getPrototypeOf(element)`。
  //
  // 审查实测（2026-08-19）：走 `getPrototypeOf` 时，宿主页若覆盖了原型上的
  // `checked` 访问器，我们拿到的就是**宿主自己的 setter**——调用它等于
  // 把写入交给宿主代码，而它可以什么都不做（实测：返回 ok:true 而 DOM 未变）。
  //
  // 这与 `setValue.ts:41` 的策略一致。原注释说两者「同一条理由」，
  // 但代码当时走的是不同路径——注释与代码不符，一并改正。
  const descriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'checked');
  const setter = descriptor?.set;
  return setter ? (value: boolean) => setter.call(element, value) : null;
}

/**
 * 勾上一个「信息属实」声明。
 *
 * 只往 `true` 写——本原语没有取消勾选的语义。用户不想勾的，
 * 在确认条上取消勾选即可，那条根本不会走到这里（见 `attest.ts`）。
 * 撤销由 journal 负责，走的是它自己的路径。
 */
export function setAttestationChecked(input: SetCheckedInput): SetCheckedResult {
  const { candidate, authority } = input;

  const capability = checkActiveCapability(authority, 'set-attestation');
  if (!capability.ok) return { ok: false, error: 'CAPABILITY_DISABLED' };

  const validated = revalidateAttestationCandidate(candidate);
  if (!validated.ok) return { ok: false, error: validated.error };
  const { element } = validated;

  const previousChecked = element.checked;
  if (previousChecked) return { ok: true, value: { changed: false, previousChecked } };

  const setChecked = nativeCheckedSetter(element);
  // `HTMLInputElement.prototype` 上的 `checked` 描述符在浏览器与 happy-dom 里
  // 恒存在，所以这一步实际不可达。留着是因为 `descriptor?.set` 的类型是可选的，
  // 而**编造一个不可达的错误码去汇报**比直接兜底更糟——这里选择兜底成
  // WRITE_REVERTED（读回一定会失败），语义正确且不新增无法触发的码。
  if (setChecked) {
    setChecked(true);
    dispatchHostEvent(element, 'input');
    dispatchHostEvent(element, 'change');
  }

  // 读回校验：写完必须真的变了。见 WRITE_REVERTED 的注释——
  // 没有这一步，宿主覆盖原型时我们会把一次什么都没做的写入报成成功。
  if (!element.checked) return { ok: false, error: 'WRITE_REVERTED' };

  return { ok: true, value: { changed: true, previousChecked } };
}
