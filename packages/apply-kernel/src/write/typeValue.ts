/**
 * 逐字符写入原语（typed write）。
 *
 * ## 为什么需要它
 *
 * 2026-08-23 在真实 Workable 申请页实测（50-证据库 §F.6-s）：那一页经历行的控件
 * **只接受逐字符增量输入**。整串写入——原生 setter + 完整事件信封 + React
 * `_valueTracker` 重置，三种都试过——会被宿主的表单状态拒收，而 `element.value`
 * **留着我们写进去的值**。
 *
 * 判据不是猜的：同一个 `title` 栏整串写入后点保存报「This is a required field.」；
 * 一个字符不改、只逐字符重敲一遍，错误当场消失。
 *
 * **这是本仓最危险的失效形态**：C6 回读判决读的正是 `element.value`，它恰好是对的
 * ⇒ 判成功 ⇒ 面板显绿，而宿主认为这一栏是空的。
 *
 * ## 承重不变量 T1
 *
 *     返回 `ok:false` **当且仅当一次宿主 mutation 都没发生**
 *     （既没调过原型 value setter，也没派过任何事件）。
 *
 * `runner.ts` 的「写入原语失败 ⇒ 无条件 `journal.abandon`」是为**同步整串**写入
 * 设计的：那时失败只可能发生在 setter 之前，所以「失败 ⇔ 没写过」自动成立。
 * T1 让它继续字面成立，因此 runner 的失败分支**一行都不用改**。
 *
 * 推论：**「宿主把我们打的字改写/拒收」不返回失败**——那时事件已经派出去了，
 * 只能返回 `ok:true` 带上实际读到的值，由 C6 去判。把它做成失败会让 runner
 * abandon 掉一张其实已经动过宿主的票，用户就撤不回来了。
 *
 * ## 三条硬约束（各配变异探针）
 *
 *  · **永不改用 `document.execCommand` 或 CDP 注入真事件**：`isTrusted` 变真 ⇒
 *    `watchTrustedUserEdits` 把我们打的每个字符判成用户编辑 ⇒ 静默 abandon 却仍
 *    报成功。而 happy-dom 里合成事件的 `isTrusted` 恒为 `undefined`，
 *    **所有单测照样绿**——这条只能靠注释与探针守。
 *  · **永不调 `element.focus()`**：真实焦点转移会让浏览器对**上一栏**派一个
 *    `isTrusted` 的 change，落进上一栏仍然挂着的编辑闩锁。
 *  · **永不写 `selectionStart` / `setSelectionRange`**：它们不在
 *    `ALLOWED_WRITE_PROPS` 里（铁律 3）；而且实测原生 setter 已经把光标放到末尾，
 *    追加打字不需要动它。
 *
 * ## 同步，不跨宏任务
 *
 * `click/combobox.ts` 自陈是决策 17 之后**唯一**跨宏任务的写入路径；而
 * `watchTrustedUserEdits` 要到 `writeEntry` 返回之后才安装——中途让出等于开一个
 * 真人编辑无人看守的窗口。逐字符循环因此是同步的。
 */

import { checkActiveCapability, type HostWriteAuthority } from '../grant';
import { dispatchHostEvent, TYPED_TAIL_EVENTS } from './allowlist';
import type { Result } from '../contracts';
import type { WriteTicket } from '../undo';

export type TextWriteMode = 'setValue' | 'typed';

/**
 * 单栏字符上限。超了在**第一次 mutation 之前**拒绝（T1），整轮继续。
 *
 * 256 不是性能数字，是「一个申请表字段合理长度」的上界：公司名、职位、学校
 * 都远小于它；超过它的多半是求职信正文那类，而那类本来就不该走逐字符。
 */
export const MAX_TYPED_CHARS_PER_FIELD = 256;

/**
 * 一张授权总共能敲几个字符。**失控刹车，不是性能预算**——取法与自陈照抄
 * `click/primitives.ts` 的 `MAX_HOST_CLICKS_PER_AUTHORITY`：编排层走岔时，
 * 单栏上限一次都不拦。
 *
 * 4096 = 16 栏 × 256，正常运行永远够不到。
 */
export const MAX_TYPED_CHARS_PER_AUTHORITY = 4_096;

const typedByAuthority = new WeakMap<object, number>();

export interface TypedWriteInput {
  readonly element: HTMLInputElement | HTMLTextAreaElement;
  /** 真正逐个敲进去的字符。 */
  readonly keystrokes: string;
  readonly authority: HostWriteAuthority;
  /** 撤销日志已经记下原值的证明。 */
  readonly ticket: WriteTicket;
}

export type TypedWriteError =
  | 'GESTURE_UNTRUSTED'
  | 'GESTURE_EXPIRED'
  | 'CAPABILITY_DISABLED'
  /** 取不到原型 setter（与 `setValue.ts` 同源同码）。 */
  | 'WRITE_REVERTED'
  /** 超单栏字符上限：宁可不写，绝不写半截。 */
  | 'TARGET_NOT_WRITABLE'
  /** 授权字符刹车耗尽。复用既有稳定码，不往 `APPLY_ERROR_CODES` 加成员。 */
  | 'ABORTED';

function nativeValueSetter(
  element: HTMLInputElement | HTMLTextAreaElement,
): ((value: string) => void) | null {
  const proto =
    element instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
  return setter ? (value: string) => setter.call(element, value) : null;
}

/**
 * 逐字符敲进去，返回**宿主最终留下的值**。
 *
 * 返回的不是我们打的字：掩码框会改写它（打 `062021` 得到 `06/2021`）。
 * 调用方拿这个值去和「预测的写入后形态」比对——那一层的知识不在这里。
 */
export function typeTextValue(input: TypedWriteInput): Result<string, TypedWriteError> {
  const { element, keystrokes, authority, ticket } = input;
  // 票据是编译期前置：它没有可读数据，所以不可能把原值泄漏进这个低层写入器。
  void ticket;

  // ── T1 的全部失败出口，一律排在第一次 mutation 之前 ─────────────────
  const access = checkActiveCapability(authority, 'set-text');
  if (!access.ok) return access;

  const setValue = nativeValueSetter(element);
  if (setValue === null) return { ok: false, code: 'WRITE_REVERTED' };

  if (keystrokes.length > MAX_TYPED_CHARS_PER_FIELD) {
    return { ok: false, code: 'TARGET_NOT_WRITABLE' };
  }

  // 清空阶段的字符数无法预知（宿主可能拒绝删除），所以按「现值长度 + 要敲的长度」
  // 预留——宁可早失败，也不要敲到一半撞上刹车留下半截值。
  const budget = element.value.length + keystrokes.length;
  const spent = typedByAuthority.get(authority) ?? 0;
  if (spent + budget > MAX_TYPED_CHARS_PER_AUTHORITY) return { ok: false, code: 'ABORTED' };
  typedByAuthority.set(authority, spent + budget);

  // ── 以下每一步都可能改动宿主，一律不再返回失败（T1） ─────────────────

  // 清空：逐次删末位。**不用 `setValue('')` 一次清空**——整串赋值正是被宿主
  // 表单状态拒收的那条路，清空同理；而且掩码框对「一次清空」和「逐次退格」
  // 的状态机反应不同。
  //
  // 上界是进入时的长度：宿主拒绝删除时值不会变短，靠它跳出而不是靠死循环检测。
  for (let guard = element.value.length; guard > 0 && element.value.length > 0; guard -= 1) {
    const before = element.value;
    setValue(before.slice(0, -1));
    dispatchHostEvent(element, 'input', { inputType: 'deleteContentBackward', data: null });
    // 宿主把值顶回去了：它不接受删除。停手，把现状交给 C6 判。
    if (element.value === before) break;
  }

  for (const character of keystrokes) {
    setValue(element.value + character);
    dispatchHostEvent(element, 'input', { inputType: 'insertText', data: character });
  }

  for (const event of TYPED_TAIL_EVENTS) dispatchHostEvent(element, event);

  return { ok: true, value: element.value };
}
