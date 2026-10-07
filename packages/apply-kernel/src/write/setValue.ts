/**
 * Writing a value into a host form control so the host FRAMEWORK believes the
 * user typed it. This is the riskiest 20 lines in the autofill feature.
 *
 * Why `element.value = x` is not enough: React (and Vue/Angular to a lesser
 * degree) installs its own `value` setter on the element instance and keeps a
 * private "value tracker". Assigning through that instance setter updates the
 * DOM but leaves the tracker in sync, so the subsequent `input` event is
 * treated as a no-op and React re-renders the OLD value straight back over
 * ours. Calling the PROTOTYPE's native setter writes the DOM directly, leaves
 * the tracker stale, and the dispatched `input` event then reads as a genuine
 * user change.
 *
 * 铁律 3 (as amended 2026-07-28) permits exactly: value / selectedIndex /
 * checked / files, plus the events frameworks need. Nothing here touches
 * attributes, styles, classes, or node structure, and nothing dispatches
 * click or submit — 铁律 2 stays literally intact.
 */

import type { Result } from '../contracts';
import { checkActiveCapability, type HostWriteAuthority } from '../grant';
import type { WriteTicket } from '../undo';
import {
  DATE_SEGMENT_COMMIT_EVENTS,
  DATE_SEGMENT_SECTION_EVENTS,
  dispatchHostEvent,
  EVENT_PROFILES,
} from './allowlist';
import type { BeginMainWorldBridge, MainWorldBridge } from './mainWorldBridge';
import { evaluateHostVeto } from '../gate/hostVeto';

type Writable = HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;

/** Read the target's document rather than any caller-supplied scan origin. */
function hostTargetStillAllowed(element: Element): boolean {
  try {
    const location = element.ownerDocument.location;
    return location !== null && !evaluateHostVeto({
      hostname: location.hostname, pathname: location.pathname,
      policy: { deniedHostSuffixes: [] },
    }).vetoed;
  } catch {
    return false;
  }
}

/** A text write plus the best-effort MAIN notification it started while active. */
export interface TextWriteAttempt {
  readonly expected: string;
  readonly bridge: MainWorldBridge;
}

/**
 * The prototype-level `value` setter for this element's own class. Resolved
 * per call (not cached at module scope) because the correct prototype differs
 * per element type, and in a cross-origin frame we may be running against a
 * different realm than the one this module was evaluated in.
 */
function nativeValueSetter(element: Writable): ((value: string) => void) | null {
  const proto =
    element instanceof HTMLInputElement
      ? HTMLInputElement.prototype
      : element instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : element instanceof HTMLSelectElement
          ? HTMLSelectElement.prototype
          : null;
  if (!proto) return null;
  const descriptor = Object.getOwnPropertyDescriptor(proto, 'value');
  const setter = descriptor?.set;
  return setter ? (value: string) => setter.call(element, value) : null;
}

function nativeSelectedIndexSetter(element: HTMLSelectElement): ((index: number) => void) | null {
  const descriptor = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'selectedIndex');
  const setter = descriptor?.set;
  return setter ? (index: number) => setter.call(element, index) : null;
}

/**
 * Tell the host framework the value changed. `input` is what React's onChange
 * actually listens for; `change` is what plain-DOM and some Vue forms use.
 * Text controls additionally receive non-bubbling `blur` plus bubbling
 * `focusout` for validation-on-blur forms. Native selects deliberately do not
 * receive a blur envelope: typeahead-like controls can clear their value when
 * they observe blur before a concrete option selection.
 */
function notifyHost(element: Writable, kind: 'text' | 'textarea' | 'select'): boolean {
  for (const event of EVENT_PROFILES[kind]) {
    if (!hostTargetStillAllowed(element)) return false;
    dispatchHostEvent(element, event);
  }
  return true;
}

/**
 * Attempt a text write and return the exact DOM value that must survive the
 * runner's asynchronous readback. A synchronous read here is intentionally
 * not a verdict: controlled hosts can still revert or coerce on their next
 * render pass.
 */
function writeNativeTextValue(
  element: HTMLInputElement | HTMLTextAreaElement,
  value: string,
  authority: HostWriteAuthority,
  ticket: WriteTicket,
): Result<string, 'GESTURE_UNTRUSTED' | 'GESTURE_EXPIRED' | 'CAPABILITY_DISABLED' | 'WRITE_REVERTED' | 'POLICY_DISABLED'> {
  // The opaque ticket is a compile-time precondition issued only by the undo
  // journal. It intentionally has no inspectable data, so it cannot leak an
  // original value into this low-level writer.
  void ticket;
  const access = checkActiveCapability(authority, 'set-text');
  if (!access.ok) return access;

  const setter = nativeValueSetter(element);
  if (!setter) return { ok: false, code: 'WRITE_REVERTED' };
  if (!hostTargetStillAllowed(element)) return { ok: false, code: 'POLICY_DISABLED' };
  setter(value);
  return { ok: true, value };
}

export function writeTextValue(
  element: HTMLInputElement | HTMLTextAreaElement,
  value: string,
  authority: HostWriteAuthority,
  ticket: WriteTicket,
): Result<string, 'GESTURE_UNTRUSTED' | 'GESTURE_EXPIRED' | 'CAPABILITY_DISABLED' | 'WRITE_REVERTED' | 'POLICY_DISABLED'> {
  const written = writeNativeTextValue(element, value, authority, ticket);
  if (!written.ok) return written;
  // Once the setter ran, this is a real write attempt. Stop the envelope if
  // host identity changes, but keep its witness for C6 and the Undo journal.
  notifyHost(element, element instanceof HTMLTextAreaElement ? 'textarea' : 'text');
  return written;
}

/**
 * 分段日期的一段（WAI-ARIA：`role=group` 里的 `input[role=spinbutton]`），返回它所在的那个组；不是就 null。
 *
 * 只认 ARIA 标准属性，不认任何厂商 class。参照物是 Workday 的 MM/YYYY（Canvas Kit，2026-09-24 实测）：
 * 每一段一个 1px、`scale(0.01)` 的真输入框，看得见、被点的是它的父节点那一段；整个日期只在焦点离开
 * 这个组时才提交进表单模型。这两件事分别决定了几何按谁量（engine 的 `honeypotGeometryTarget`）和
 * 写法（下面的 `writeDateSegment`）。判成分段本身不放宽任何东西——还要规则把这一格认成日期的年／月
 * 角色（collectionProjection 的 `isDatePartRole`）。
 */
export function dateSegmentGroup(element: Element): Element | null {
  if (element.localName !== 'input' || element.getAttribute('role')?.trim().toLowerCase() !== 'spinbutton') return null;
  return element.parentElement?.closest('[role="group"]') ?? null;
}

/**
 * 分段日期的一段（2026-09-24）：原生 setter + **只有** `input`（`DATE_SEGMENT_SECTION_EVENTS`）。
 *
 * 为什么不是文本框那一套信封，见 allowlist.ts 的 `DATE_SEGMENT_SECTION_EVENTS`：这类组件只在焦点离开
 * 整个日期组时提交，而同步派出的 blur/focusout 让它拿旧状态提交、再盖掉刚写的这一段。提交由 runner 在
 * 这一段渲染落地之后单独做（`commitDateSegment`）。
 *
 * 前置条件：焦点**不在**这个日期组里。组件判「离开」看的是焦点此刻在不在组里；焦点在组里时我们随后
 * 那一下提交不会发生，写进去的就只是显示、不是表单的值——回读却读得到它。这种时候宁可不写
 * （`TARGET_NOT_WRITABLE`，一次宿主 mutation 都没发生）。实际运行里焦点在我们浮层的按钮上，走不到这一条。
 */
export function writeDateSegment(
  element: HTMLInputElement,
  value: string,
  authority: HostWriteAuthority,
  ticket: WriteTicket,
): Result<string, 'GESTURE_UNTRUSTED' | 'GESTURE_EXPIRED' | 'CAPABILITY_DISABLED' | 'WRITE_REVERTED' | 'TARGET_NOT_WRITABLE' | 'POLICY_DISABLED'> {
  void ticket;
  const access = checkActiveCapability(authority, 'set-text');
  if (!access.ok) return access;
  const group = dateSegmentGroup(element);
  const active = element.ownerDocument.activeElement;
  if (group === null || (active !== null && group.contains(active))) return { ok: false, code: 'TARGET_NOT_WRITABLE' };
  const setter = nativeValueSetter(element);
  if (!setter) return { ok: false, code: 'WRITE_REVERTED' };
  if (!hostTargetStillAllowed(element)) return { ok: false, code: 'POLICY_DISABLED' };
  setter(value);
  for (const event of DATE_SEGMENT_SECTION_EVENTS) {
    if (!hostTargetStillAllowed(element)) break;
    dispatchHostEvent(element, event);
  }
  return { ok: true, value };
}

/**
 * 分段日期的提交：这一段的值已经渲染进组件之后，派一个冒泡的 focusout，组件把此刻的整个日期交给表单。
 * 仍在这一轮的写授权之内（runner 的写循环里调用）；授权失效就不派。
 */
export function commitDateSegment(element: HTMLInputElement, authority: HostWriteAuthority): boolean {
  if (!checkActiveCapability(authority, 'set-text').ok || !element.isConnected) return false;
  for (const event of DATE_SEGMENT_COMMIT_EVENTS) {
    if (!hostTargetStillAllowed(element)) return false;
    dispatchHostEvent(element, event);
  }
  return true;
}

/**
 * Fill-only L3 upgrade. It begins after the native setter while the intended
 * value is still on the live target, but before the regular host envelope can
 * cause a controlled page to render its old state back over that value.
 *
 * The async bridge is not itself a write verdict and is never used by Undo;
 * runner C6 waits for it, then reads the DOM before committing the ticket.
 */
export function writeTextValueWithMainWorld(
  element: HTMLInputElement | HTMLTextAreaElement,
  value: string,
  authority: HostWriteAuthority,
  ticket: WriteTicket,
  startBridge: BeginMainWorldBridge,
): Result<TextWriteAttempt, 'GESTURE_UNTRUSTED' | 'GESTURE_EXPIRED' | 'CAPABILITY_DISABLED' | 'WRITE_REVERTED' | 'POLICY_DISABLED'> {
  const written = writeNativeTextValue(element, value, authority, ticket);
  if (!written.ok) return written;
  if (!hostTargetStillAllowed(element)) {
    // The setter changed material, but no MAIN request has started. Keep a
    // cancelled transport outcome so the runner preserves its mutation ticket.
    return { ok: true, value: { expected: written.value,
      bridge: { settled: Promise.resolve('aborted'), abort: () => undefined } } };
  }
  const bridge = startBridge(element, authority, ticket);
  if (!notifyHost(element, element instanceof HTMLTextAreaElement ? 'textarea' : 'text')) {
    // Retire pending MAIN retries, but retain the real setter/bridge attempt
    // so C6 can account for changed material instead of abandoning its ticket.
    try { bridge.abort(); } catch { /* The caller retains the original bounded handle. */ }
  }
  return { ok: true, value: { expected: written.value, bridge } };
}

/** Case/whitespace-insensitive so "United States" matches "united states ". */
function normalize(text: string): string {
  return text.replace(/\s+/g, ' ').trim().toLowerCase();
}

/**
 * Select the option matching `value` in a native <select>. Matches on option
 * value first, then visible text, then a prefix — never a fuzzy guess, because
 * a wrong pick here is invisible to the user in a collapsed select.
 *
 * Returns false when no option matches; the caller reports NO_OPTION_MATCH and
 * leaves the control alone.
 */
function uniqueOptionIndex(
  options: readonly HTMLOptionElement[],
  matches: (option: HTMLOptionElement) => boolean,
): number | null | 'ambiguous' {
  const indexes = options.flatMap((option, index) => (matches(option) ? [index] : []));
  if (indexes.length === 1) return indexes[0];
  return indexes.length === 0 ? null : 'ambiguous';
}

/**
 * 唯一的 select 选项匹配语义：value 精确 → 文本精确 → 文本前缀，且必须唯一。
 *
 * 抽成纯函数是为了**计划期与写入期同源**（CAP-AF-044）：预览显示的"将选中
 * 哪一项"和写入真正选的必须是同一套判决，否则预览就是另一个谎言。
 * 写入期仍然重匹配一次——计划与写入之间页面可能变。
 */
export function resolveSelectOption(
  options: ReadonlyArray<{ readonly value: string; readonly text: string }>,
  value: string,
): { readonly index: number } | 'NO_OPTION_MATCH' | 'AMBIGUOUS_OPTION' {
  const wanted = normalize(value);
  const unique = (matches: (option: { value: string; text: string }) => boolean) => {
    const indexes = options.flatMap((option, index) => (matches(option) ? [index] : []));
    if (indexes.length === 1) return indexes[0];
    return indexes.length === 0 ? null : ('ambiguous' as const);
  };
  const byValue = unique((option) => normalize(option.value) === wanted);
  const byText = byValue === null ? unique((option) => normalize(option.text) === wanted) : byValue;
  const byPrefix = byText === null ? unique((option) => normalize(option.text).startsWith(wanted)) : byText;
  if (byPrefix === 'ambiguous') return 'AMBIGUOUS_OPTION';
  if (byPrefix === null) return 'NO_OPTION_MATCH';
  return { index: byPrefix };
}

export function writeSelectValue(
  element: HTMLSelectElement,
  value: string,
  authority: HostWriteAuthority,
  ticket: WriteTicket,
): Result<
  string,
  'GESTURE_UNTRUSTED' | 'GESTURE_EXPIRED' | 'CAPABILITY_DISABLED' | 'NO_OPTION_MATCH' | 'AMBIGUOUS_OPTION' | 'POLICY_DISABLED'
> {
  void ticket;
  const access = checkActiveCapability(authority, 'set-select');
  if (!access.ok) return access;

  const options = [...element.options];
  const resolved = resolveSelectOption(options, value);
  if (resolved === 'AMBIGUOUS_OPTION') return { ok: false, code: 'AMBIGUOUS_OPTION' };
  if (resolved === 'NO_OPTION_MATCH') return { ok: false, code: 'NO_OPTION_MATCH' };
  const byPrefix = resolved.index;

  const setter = nativeValueSetter(element);
  if (!hostTargetStillAllowed(element)) return { ok: false, code: 'POLICY_DISABLED' };
  if (setter) setter(options[byPrefix].value);
  else element.selectedIndex = byPrefix;
  notifyHost(element, 'select');
  // The option's DOM value, not the user-facing label, is the value later
  // read back. For example "United States" may legitimately become "us".
  return { ok: true, value: options[byPrefix].value };
}

/**
 * Restore a deliberately unselected native <select>. There is no value to
 * match in that state (some forms have no empty placeholder option), so Undo
 * needs the allowed `selectedIndex` primitive rather than inventing a value.
 */
export function writeSelectIndex(
  element: HTMLSelectElement,
  index: number,
  authority: HostWriteAuthority,
  ticket: WriteTicket,
): Result<void, 'GESTURE_UNTRUSTED' | 'GESTURE_EXPIRED' | 'CAPABILITY_DISABLED' | 'NO_OPTION_MATCH' | 'POLICY_DISABLED'> {
  void ticket;
  const access = checkActiveCapability(authority, 'set-select');
  if (!access.ok) return access;
  if (!Number.isInteger(index) || index < -1 || index >= element.options.length) {
    return { ok: false, code: 'NO_OPTION_MATCH' };
  }

  const setter = nativeSelectedIndexSetter(element);
  if (!hostTargetStillAllowed(element)) return { ok: false, code: 'POLICY_DISABLED' };
  if (setter) setter(index);
  else element.selectedIndex = index;
  notifyHost(element, 'select');
  return element.selectedIndex === index
    ? { ok: true, value: undefined }
    : { ok: false, code: 'NO_OPTION_MATCH' };
}
