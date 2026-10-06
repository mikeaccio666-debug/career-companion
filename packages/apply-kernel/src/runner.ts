/**
 * The only host-write orchestrator.
 *
 * A caller must supply both an authority minted from an explicit click in our
 * Shadow UI and the session-owned undo journal. The runner redeems that
 * authority once, records every original value, then passes the resulting
 * WriteTicket to the only write primitives.
 */

import { typeTextValue } from './write/typeValue';
import {
  assertNever,
  type ApplyErrorCode,
  type ApplyPlan,
  type ApplyPlanEntry,
  type ApplyWriteResult,
  type ComboboxSemanticAuthority,
  type ComboboxSemanticUndoTransaction,
  type Result,
  type ScanRoot,
} from './contracts';
import {
  selectComboboxOption,
  type ComboboxOptionSource,
  type ComboboxSemanticTransactionSource,
} from './click/combobox';
import {
  attachHostFile,
  fileTargetChecks,
  watchDeclaredUpload,
  watchHostFileAdoption,
} from './write/setFile';
import { fieldSignature, readValue } from './fieldIdentity';
import {
  checkActiveCapability,
  consumeAuthority,
  isolateConsumedAuthority,
  releaseAuthority,
  type HostWriteAuthority,
} from './grant';
import { isApplyPolicyEnabled, type ApplyPolicy } from './policy';
import type { UndoJournal, WriteTicket } from './undo';
import {
  commitDateSegment,
  dateSegmentGroup,
  writeDateSegment,
  writeSelectValue,
  writeTextValue,

  writeTextValueWithMainWorld,
  type TextWriteAttempt,
} from './write/setValue';
import { isDatePartRole } from './collectionProjection';
import { fillChoiceGroup } from './write/choiceGroup';
import { isSignOnBehalfChoiceKind, type SignOnBehalfKind } from './dict/signOnBehalf';
import { fillListboxCombobox } from './write/listboxCombobox';
import { fillHierarchicalPrompt } from './write/hierarchicalPrompt';
import { fillSearchPrompt } from './write/searchPrompt';
import { fillTypeaheadCombobox } from './write/typeaheadCombobox';
import { fillGenericCombobox, selectProxyOf, type GenericComboboxShapeMemo } from './write/ariaComboboxGeneric';
import type { BeginMainWorldBridge, MainWorldBridge } from './write/mainWorldBridge';
import {
  classifyHostValidation,
  telValuesEquivalent,
  valuesEquivalent,
  verifyWrittenValue,
  type HostValidationSignals,
  type WriteVerification,
} from './write/verify';
import { CAPABILITY_BY_KIND } from './write/allowlist';
import { hostDelay, nextHostTask } from './write/hostSchedule';
import {
  hasPlainTextOnlyStructure,
  isCurrentPlainTextContenteditableAttestation,
} from './rules/plainTextContenteditable';
import {
  hasExactPlainTextContenteditableRestoration,
  hasPlainTextContenteditableWriteAttempt,
  setPlainTextContenteditable,
  settledPlainTextContenteditableRestoration,
} from './write/setPlainTextContenteditable';
import { isRuleOwnedComboboxSemanticAuthority } from './rules/comboboxSemanticAuthority';

// Isolated-world provenance for the exact submission authority gate. A page
// can cancel an Event, but it cannot add that Event to this module-local set.
const AUTHORITY_BLOCKED_SUBMISSION_EVENTS = new WeakSet<Event>();

export function markSubmissionBlockedByAuthority(event: Event): void {
  AUTHORITY_BLOCKED_SUBMISSION_EVENTS.add(event);
}

function wasSubmissionBlockedByAuthority(event: Event): boolean {
  return AUTHORITY_BLOCKED_SUBMISSION_EVENTS.has(event);
}

export type ApplyRunAbort = 'IDENTITY_CHANGED' | 'HOST_SUBMITTED';

export interface ApplyRunSummary {
  results: ApplyWriteResult[];
  filled: number;
  failed: number;
  /**
   * 整轮被迫停下的原因；停下之后还没轮到的栏一律记 ABORTED / HOST_SUBMITTED。
   *
   * `HOST_SUBMITTED`：宿主开始提交了，一栏都不能再动。
   * `IDENTITY_CHANGED`：2026-09-23 起**只剩**规则自带语义读取口的受控下拉那一条路——一整笔
   * 开菜单、选选项的受控交易途中页面变了，或补偿证明不了回到写前状态。页面可能落在一个我们
   * 说不清的状态上，不再去点别的控件。写之前就由签名查出来的身份漂移**不再**走这里，
   * 记在 `identityDrift`，只放弃那一栏。
   */
  abortedBy: ApplyRunAbort | null;
  /**
   * 这一轮里有几栏在写之前发现自己的身份变了（2026-09-23 起不连坐：只放弃那一栏）。
   *
   * 数进来的：结构身份（`fieldSignature.core`）变了；漂移之后题面文字（labelHint）也变了；
   * 求职信的题面变了；富文本的规则证明不再成立；简历栏不再是批准过的简历目标。
   * 这几种从前都把 `abortedBy` 置成 IDENTITY_CHANGED、把后面整轮连坐成 ABORTED。
   *
   * 大于 0 说明页面在这一轮里重渲染过——比如 Greenhouse 答了「是否拉美裔」才插进种族那一题，
   * 后面的题序号都挪了一位。调用方据此重扫一遍、在这一次点击批准过的范围里补上这些栏与新出现的题。
   */
  identityDrift: number;
  /** Labels may drift after host validation; this count never carries label text. */
  labelHintDrifted: number;
  /**
   * 整轮结束**之后**再问一次「我们填的还在不在」，返回一份修订过的 `results`。
   *
   * 轮内的延时复检（CAP-AF-055）只等一个固定窗口——产品链路上是 250 毫秒，那是照着
   * 受控框架重渲染量的。**简历解析**是一次服务端往返：2026-09-22 在 Lever 上实测
   * 结算后约十二秒才把填好的地点清空。窗口一关，那一行就永远停在 `ok` 上，面板说
   * 「已填」而表单是空的——不是没填上，是我们说了谎。
   *
   * 把窗口调大解决不了：用户要干等，而且下一家可能十五秒。宿主什么时候回写不由
   * 我们决定，所以形状只能是「随时可以再问一次」。
   *
   * 三条纪律：
   *  · **只读**。不写 DOM、不碰还原票据——还原始终是用户的动作。
   *  · **只改判本轮成功的条目**。已经失败的条目有更具体的诊断
   *    （`WRITE_REVERTED` / `HOST_REJECTED`），不得被洗成 `LATE_REVERTED`。
   *  · **不就地改写 `results`**。摘要是那一刻的结论；修订版本由调用方自己拿去
   *    重建审计视图（`buildAuditView(plan, recheck())`）。
   *
   * 可以反复调用，每次都从本轮的原始结论重新判：值被放回去就如实答 `ok`。
   *
   * 「我们当时写进去的是什么」留在闭包里，从不进 `ApplyWriteResult`——那是简历与
   * 档案原文（Data-L1），不得进入任何会被序列化、落日志或上报的形状。
   */
  recheck: () => readonly ApplyWriteResult[];
}

/**
 * 向调用方索取用户当前简历文件。
 *
 * 注入而不是直接 import：`apply/` 层不得出现任何网络或跨 realm 消息调用
 * （由 `tests/s0/apply-l1-boundary.redgreen.test.ts` 按源码文本锁死——
 * 那条闸门刻意是**笨的**，连注释里的字面量都会命中，所以这段话不写出那两个符号）。
 *
 * 取件的实现住在 content 侧、走 background 代理：MV3 内容脚本的网络请求受**页面**的
 * CORS 约束，直连签名下载地址会被目标站点挡掉。
 *
 * 返回 null 表示拿不到（未登录 / 没有简历 / 下载失败），此时该字段以
 * `NO_VALUE` 结束，整轮继续。
 */
export interface ResolveResumeFileInput {
  readonly authorityExpiresAt: number;
  readonly signal?: AbortSignal;
}

export type ResolveResumeFile = (input: ResolveResumeFileInput) => Promise<File | null>;

export type ComboboxSelectionState =
  | 'EMPTY'
  | 'MATCH'
  | 'MISMATCH'
  | 'UNVERIFIABLE';

export interface RunApplyPlanInput {
  /**
   * 读一个控件上宿主自己的校验判决（CAP-AF-068）。
   *
   * 不注入 = 完全维持原行为：回读判决只回答"我们写的值还在不在"。注入之后，
   * 值留住但宿主判无效的字段会报 `HOST_REJECTED` 而不是成功——否则面板会报
   * 「已填 12/12」而页面上红着四条错误，用户点提交才发现。
   *
   * 与 readGeometry 同姿势：判据在 write/verify 里是纯函数，读 DOM 这一步隔开。
   */
  readonly readHostValidation?: (element: Element) => HostValidationSignals;
  /**
   * @deprecated Compatibility-only shape for older in-process callers. The
   * runner deliberately ignores it: semantic readback must travel on the
   * scanned field's rule-owned `semanticAuthority`.
   */
  readonly readComboboxSelection?: (
    trigger: HTMLInputElement,
    expectedOptionText: string,
  ) => ComboboxSelectionState;
  /** @deprecated Ignored; selector-free authority must be bound to the field. */
  readonly comboboxOptionSource?: ComboboxOptionSource;
  /**
   * @deprecated Ignored; a caller-injected snapshot cannot substitute for the
   * exact validated descriptor that produced the reviewed field.
   */
  readonly comboboxSemanticTransactionSource?: ComboboxSemanticTransactionSource;
  /**
   * @deprecated Ignored. Raw DOM value/index is never semantic Undo evidence.
   */
  readonly rawComboboxUndoIsSemantic?: (trigger: HTMLInputElement) => boolean;
  /**
   * 全轮写完后再等这么久，复检一遍本轮判成功的条目（CAP-AF-055）。
   *
   * 不给就**整个功能不存在**，行为与接这条能力之前逐字一致。做成批量一次扫
   * 而不是每字段各等：真实的重渲染/回填在写入串之后发生一次，每字段各等会把
   * 总耗时乘以字段数，直接撞注入预算（CAP-AF-065）。
   */
  readonly lateRecheckMs?: number;
  /** 等待器，测试注入；缺省用真实定时器。 */
  readonly lateRecheckDelay?: (ms: number) => Promise<void>;
  readonly plan: ApplyPlan;
  readonly auth: HostWriteAuthority;
  readonly journal: UndoJournal;
  /** The adapter-proven form scope used to recompute each live identity. */
  readonly root: ScanRoot;
  /** The same validated policy that narrowed the authority for this run. */
  readonly policy: ApplyPolicy;
  /**
   * 代填条款、声明与签名（2026-09-23）：用户在资料页单独勾过的同意此刻是否仍成立。调用方读后端
   * 记录给出；不给 = 没同意。带 signOnBehalf 的条目写之前与 `policy.capabilities['sign-on-behalf']`
   * 一起核一遍；勾选框在每一下点击之前再核一遍。
   *
   * 2026-09-28 起按类别问：同意过的那一版文案点名了这一类吗（旧版本的同意不覆盖新加的类别）；能不能联系雇主
   * 问的是资料里的回答仍是这一向吗。旧的调用方不看参数、一律答 true，行为与从前相同。
   */
  readonly signOnBehalfCurrent?: (kind: SignOnBehalfKind) => boolean;
  /** Fill-only L3 upgrade supplied by the isolated content entry. */
  readonly startMainWorldBridge?: BeginMainWorldBridge;
  readonly resolveResumeFile?: ResolveResumeFile;
  /**
   * 求职信 PDF 的取件函数（2026-09-27），形状与简历的相同。只给求职信上传栏（条目键 coverLetter、kind file）用；
   * 没接就是没有（NO_VALUE），绝不拿简历顶上。
   */
  readonly resolveCoverLetterFile?: ResolveResumeFile;
  /**
   * 逐字段结算的本地广播（CAP-AF-063 的中段屏）。
   *
   * 面板此前只有两种状态：一轮开始前什么都没有，跑完之后一次性摊开整张单子。
   * 中间那几秒——我们正在一栏一栏地改用户的表单——屏幕上没有任何东西说明我们
   * 在做什么、走到哪一栏。这条流补的就是那几秒。
   *
   * 它**只走本地**：`ApplyWriteResult` 带着宿主标签，与 `AuditView` 同边界，
   * 永不过桥、不进回执、不进遥测。
   *
   * 同一个 `index` 可能被广播多次：C6 回读与延时复检都会**事后改判**一条已经
   * 结算的结果。最后一次广播与 `ApplyRunSummary` 里那一条逐字一致。只广播第一次，
   * 中段屏会一直挂着一个已经不成立的绿勾。
   *
   * 通知抛出来不改变任何一次宿主写入的结局——给用户看进度这件锦上添花的事，
   * 不该有能力毁掉一份真实的申请。抛过一次这条流就整轮停掉，终局视图照常交付。
   */
  readonly onFieldSettled?: (index: number, result: ApplyWriteResult) => void;
  /**
   * 这一栏轮到了、马上要写（2026-09-23 浮层的进度卡：主卡上只显示「当前这一项」）。
   *
   * 与 `onFieldSettled` 同一条本地出口、同一种纪律：只给下标，抛出来就整轮不再广播，
   * 不改变任何一次宿主写入的结局。
   */
  readonly onFieldStart?: (index: number) => void;
  /**
   * 这一栏的值已经写进网页，正在等回读确认（文本类的回读排在整轮写完之后）。
   *
   * 进度条据此分两层走：写入先往前推，确认跟在后面——「已经在网页上了」与「网站确认了」
   * 不是一回事，计数只数后者。
   */
  readonly onFieldWritten?: (index: number) => void;
  /**
   * 这一次点击里我们写过、随后被宿主改掉的那几栏（简历解析回写，2026-09-24）：元素 → 调用方做决定那一刻
   * 在那一栏里看到的宿主值。这几栏非空也再写一次（资料里的值为准），前提是写前最后那一刻的值**逐字**
   * 仍是这个宿主值——变了（多半是用户动过）就照旧 NOT_EMPTY、一个字都不动。
   *
   * 只放宽「非空不写」那一道闸，别的一道不松：身份、题面、能力位、置信度、授权照旧逐栏重验。
   * 只管文本、长文本与原生下拉；组合框与单选／复选组照旧不覆盖已有的选择。不给就与从前逐字相同。
   */
  readonly reclaim?: ReadonlyMap<Element, string>;
  /** Session navigation/disposal invalidates every not-yet-written entry. */
  readonly signal?: AbortSignal;
  /** Revalidates the sealed scan generation; false/throw stops later writes. */
  readonly scanStillCurrent?: () => boolean;
  /** Clock seam used to re-check remote policy expiry between interactions. */
  readonly now?: () => number;
  /**
   * Lets queued MutationObserver callbacks run between host interactions.
   * Production uses a microtask; tests may inject a deterministic checkpoint.
   */
  readonly mutationDeliveryCheckpoint?: () => Promise<void>;
}

/**
 * Cross a real task boundary without timer nesting/clamping in browsers (and
 * without background-tab timer throttling: `hostSchedule.ts`).
 * MutationObserver delivery happens at the preceding microtask checkpoint, so
 * framework work queued through nested promises cannot trail the runner into
 * the next reviewed field. The timer fallback is only for runtimes without a
 * MessageChannel implementation.
 */
const nextMutationDeliveryTask = nextHostTask;

interface PendingVerification {
  readonly index: number;
  readonly entry: ApplyPlanEntry;
  readonly ticket: WriteTicket;
  readonly previous: string;
  readonly wasUserEdited: () => boolean;
  readonly stopWatchingUserEdits: () => void;
  /** Cancel it on host submission so hydration cannot mutate state after abort. */
  readonly bridge: MainWorldBridge | null;
  /** 写入期望值；延时复检拿它跟稍后的 DOM 比（CAP-AF-055）。 */
  readonly writtenValue: string;
  readonly verification: Promise<WriteVerification>;
}

interface PendingComboboxVerification {
  readonly index: number;
  readonly entry: Extract<ApplyPlanEntry, { kind: 'combobox' }>;
  readonly ticket: WriteTicket | null;
  readonly authority: ComboboxSemanticAuthority;
  readonly undo: ComboboxSemanticUndoTransaction | null;
  readonly expectedOptionText: string;
}

interface EntryWriteAttempt {
  readonly expected: string;
  readonly bridge: MainWorldBridge | null;
}

function isCompleteComboboxAuthority(
  authority: ComboboxSemanticAuthority | undefined,
): authority is ComboboxSemanticAuthority {
  return Boolean(
    isRuleOwnedComboboxSemanticAuthority(authority) &&
    typeof authority.readSelection === 'function' &&
    typeof authority.optionSource?.read === 'function' &&
    typeof authority.optionSource?.isOpen === 'function' &&
    typeof authority.semanticTransactionSource?.snapshot === 'function',
  );
}

/** Exact compensation for a post-click proof failure; never falls back to raw value. */
function restoreSemanticPreWrite(
  undo: ComboboxSemanticUndoTransaction,
): boolean {
  try {
    if (undo.wasUserEdited()) return false;
    if (undo.isAtPreWriteState()) return true;
    // A third semantic state may belong to the host or a trusted user. Exact
    // compensation is authorized only from this transaction's written seal.
    if (undo.isAtWrittenState() !== true) return false;
    return undo.restorePreWrite() === true &&
      undo.isAtPreWriteState() === true;
  } catch {
    return false;
  }
}

type SemanticCompensationOutcome =
  | 'RESTORED'
  | 'USER_EDITED'
  | 'RETAINED'
  | 'LOST';

/**
 * Retire only after exact pre-state readback. Retain an opaque handle only
 * while it still proves this transaction's written seal; an unsealed third
 * state is left untouched and grants no future Undo authority.
 */
function compensateOrRetainSemanticFailure(
  journal: UndoJournal,
  ticket: WriteTicket,
  undo: ComboboxSemanticUndoTransaction,
): SemanticCompensationOutcome {
  try {
    if (undo.wasUserEdited()) {
      if (journal.retainSemanticFailure(ticket, undo)) journal.abandon(ticket);
      else {
        undo.dispose();
        journal.abandon(ticket);
      }
      return 'USER_EDITED';
    }
  } catch {
    // An ownership read that cannot be proven is not permission to restore.
    try {
      undo.dispose();
    } catch {
      // The stable outcome remains LOST; disposal never creates authority.
    }
    journal.abandon(ticket);
    return 'LOST';
  }
  if (restoreSemanticPreWrite(undo)) {
    if (journal.retainSemanticFailure(ticket, undo)) journal.abandon(ticket);
    else {
      undo.dispose();
      journal.abandon(ticket);
    }
    return 'RESTORED';
  }
  // Retention is itself a future restore capability. Keep it only while the
  // opaque handle still proves the exact state sealed by this transaction;
  // an arbitrary third state must permanently revoke that capability.
  try {
    if (undo.wasUserEdited() !== true && undo.isAtWrittenState() === true) {
      if (journal.retainSemanticFailure(ticket, undo)) return 'RETAINED';
    }
  } catch {
    // Unprovable ownership is LOST, never a deferred restore permission.
  }
  undo.dispose();
  journal.abandon(ticket);
  return 'LOST';
}

/**
 * A callback may revoke execution after the option click has already changed
 * host semantics. Restore under the opaque transaction before returning the
 * fence error. Once host submission is observed, spend no further host click;
 * retain the exact Undo handle instead and keep the field non-successful.
 */
function failSemanticWriteAfterExecutionFence(
  journal: UndoJournal,
  ticket: WriteTicket,
  undo: ComboboxSemanticUndoTransaction,
  reason: ApplyErrorCode,
): ApplyErrorCode {
  if (reason === 'HOST_SUBMITTED') {
    let exactWrittenState = false;
    try {
      exactWrittenState = undo.wasUserEdited() !== true && undo.isAtWrittenState() === true;
    } catch {
      exactWrittenState = false;
    }
    if (exactWrittenState && journal.retainSemanticFailure(ticket, undo)) return reason;
    try {
      undo.dispose();
    } finally {
      journal.abandon(ticket);
    }
    return reason;
  }
  const compensation = compensateOrRetainSemanticFailure(journal, ticket, undo);
  if (compensation === 'RESTORED') return reason;
  if (compensation === 'USER_EDITED') return 'ABORTED';
  return 'IDENTITY_CHANGED';
}

interface HostSubmissionWatch {
  submitted(): boolean;
  wait(): Promise<void>;
  stop(): void;
}

function rejectedRun(plan: ApplyPlan, reason: ApplyErrorCode): ApplyRunSummary {
  const results = plan.entries.map<ApplyWriteResult>((entry) => ({
    key: entry.key,
    label: entry.label,
    ok: false,
    reason,
  }));
  // 一次写入都没发生，没有任何「我们写的值」可以复核：如实交回同一份结论。
  return {
    results,
    filled: 0,
    failed: results.length,
    abortedBy: null,
    identityDrift: 0,
    labelHintDrifted: 0,
    recheck: () => results,
  };
}

/**
 * 规则把这一格认成了起止日期的年／月角色，而它是分段日期的一段（`role=group` 里的 `input[role=spinbutton]`）。
 * 两个条件都要：角色只能来自规则数据，所以这条写法锁在规则量过的控件上。
 */
function isDateSegmentEntry(entry: ApplyPlanEntry): entry is Extract<ApplyPlanEntry, { kind: 'text' }> {
  return entry.kind === 'text' && isDatePartRole(entry.key) && dateSegmentGroup(entry.element) !== null;
}

/**
 * 宿主对这一格收不收。分段日期是**一个**值：组里任何一段被宿主标成无效（Workday 在「Invalid Date」时
 * 把空着的那一段标 aria-invalid），这个日期就没被收下——哪怕这一段自己的 aria-invalid 是空的。
 */
function hostVerdictFor(
  entry: ApplyPlanEntry,
  read: (element: Element) => HostValidationSignals,
): ReturnType<typeof classifyHostValidation> {
  const own = classifyHostValidation(read(entry.element));
  if (own === 'rejected' || !isDateSegmentEntry(entry)) return own;
  const group = dateSegmentGroup(entry.element);
  const others = group === null
    ? []
    : [...group.querySelectorAll('input[role="spinbutton"]')].filter((segment) => segment !== entry.element);
  return others.some((segment) => classifyHostValidation(read(segment)) === 'rejected') ? 'rejected' : own;
}

function writeEntry(
  entry: ApplyPlanEntry,
  root: ScanRoot,
  authority: HostWriteAuthority,
  ticket: WriteTicket,
  startMainWorldBridge: BeginMainWorldBridge | undefined,
):
  | ReturnType<typeof writeSelectValue>
  | Result<
      TextWriteAttempt,
      | 'GESTURE_UNTRUSTED'
      | 'GESTURE_EXPIRED'
      | 'CAPABILITY_DISABLED'
      | 'IDENTITY_CHANGED'
      | 'WRITE_REVERTED'
    >
  | ReturnType<typeof typeTextValue> {
  switch (entry.kind) {
    case 'text':
    case 'textarea':
      // 分段日期的一段（2026-09-24）：只发 input，提交在这一段渲染落地之后由写循环单独做。
      if (isDateSegmentEntry(entry)) {
        return writeDateSegment(entry.element, entry.value, authority, ticket);
      }
      // 逐字符通路（50-证据库 §F.6-s）：宿主只接受增量输入时，整串写入会被它的
      // 表单状态拒收而 `element.value` 留着——回读读到的恰好是对的，于是把失败
      // 报成成功。**不走主世界桥**：桥是给「控制型页面把旧状态渲染回来」那一类
      // 用的 L3 升级，与「只认增量输入」不是同一个问题。
      if (entry.writeMode === 'typed') {
        return typeTextValue({ element: entry.element, keystrokes: entry.value, authority, ticket });
      }
      return startMainWorldBridge
        ? writeTextValueWithMainWorld(entry.element, entry.value, authority, ticket, startMainWorldBridge)
        : writeTextValue(entry.element, entry.value, authority, ticket);
    case 'select':
      return writeSelectValue(entry.element, entry.value, authority, ticket);
    case 'richtext':
      return setPlainTextContenteditable({
        element: entry.element,
        value: entry.value,
        root,
        attestation: entry.plainTextContenteditableAttestation,
        authority,
        ticket,
      });
    case 'combobox':
    case 'file':
    case 'choice':
      // 走不到这里：三者的调用点在上面就分流了。留着是为了让"下拉/文件/选项被
      // setValue 写入"成为一个编译期不可能，而不是一条靠人记住的约定。
      return { ok: false, code: 'CAPABILITY_DISABLED' };
    default:
      return assertNever(entry, 'runApplyPlan entry kind');
  }
}

function asEntryWriteAttempt(
  result: ReturnType<typeof writeEntry>,
): Result<EntryWriteAttempt, ApplyErrorCode> {
  if (!result.ok) return result;
  if (typeof result.value === 'string') return { ok: true, value: { expected: result.value, bridge: null } };
  return { ok: true, value: { expected: result.value.expected, bridge: result.value.bridge } };
}

function verifyAfterMainWorldBridge(
  bridge: MainWorldBridge | null,
  input: Parameters<typeof verifyWrittenValue>[0],
  signal?: AbortSignal,
): Promise<WriteVerification> {
  const verify = () => verifyWrittenValue({ ...input, signal });
  if (!bridge) return verify();
  const afterBridge = bridge.settled.then((outcome) =>
    outcome === 'aborted' || signal?.aborted ? 'aborted' : verify(),
  );
  if (!signal) return afterBridge;
  if (signal.aborted) {
    try {
      bridge.abort();
    } catch {
      // The session signal still owns cancellation if a detached test seam
      // rejects its transport-level abort.
    }
    return Promise.resolve('aborted');
  }

  let closed = false;
  let resolveAborted: (outcome: WriteVerification) => void = () => undefined;
  const aborted = new Promise<WriteVerification>((resolve) => {
    resolveAborted = resolve;
  });
  const onAbort = () => {
    if (closed) return;
    try {
      bridge.abort();
    } catch {
      // A test seam or detached page may reject cancellation. The runner still
      // owns the signal and must close without starting a late C6 read.
      resolveAborted('aborted');
      return;
    }
    resolveAborted('aborted');
  };
  signal.addEventListener('abort', onAbort, { once: true });
  if (signal.aborted) onAbort();
  return Promise.race([afterBridge, aborted]).finally(() => {
    closed = true;
    signal.removeEventListener('abort', onAbort);
  });
}

/** 等宿主显示它收下的文件最多这么久（2026-09-28）。一个小附件传完、列出来，实测在一两秒内。 */
const FILE_ADOPTION_WAIT_MS = 3_000;
const FILE_ADOPTION_POLL_MS = 100;
/**
 * 等规则声明的上传部件说「传好了」最多这么久（2026-09-28 Workday：208 KB 的简历从 change 到标记约 0.6 秒；这个标记要等
 * 宿主自己的上传往返，上限留给 5 MB 的附件与慢网络）。到点没等到，照旧记「网站没确认」。
 */
const DECLARED_UPLOAD_WAIT_MS = 8_000;

async function awaitHostFileAdoption(adopted: () => boolean, signal: AbortSignal | undefined, waitMs = FILE_ADOPTION_WAIT_MS): Promise<boolean> {
  const deadline = Date.now() + waitMs;
  for (;;) {
    if (adopted()) return true;
    if (signal?.aborted || Date.now() >= deadline) return false;
    await hostDelay(FILE_ADOPTION_POLL_MS, signal);
  }
}

/**
 * Only phone-like text controls get the tel-aware readback (`write/verify.ts`
 * `telValuesEquivalent`): the control declares itself (`type="tel"`,
 * `autocomplete="tel…"`) or the reviewed plan resolved it to the phone key.
 * Every other control keeps the strict formatting-only comparison.
 */
function isTelReadback(entry: ApplyPlanEntry): boolean {
  if (entry.kind !== 'text') return false;
  if (entry.key === 'phone') return true;
  const element = entry.element;
  if (!(element instanceof HTMLInputElement)) return false;
  if (element.type === 'tel') return true;
  return /^tel(?:$|-)/i.test(element.getAttribute('autocomplete')?.trim() ?? '');
}

function verificationFailure(verification: Exclude<WriteVerification, 'ok'>): ApplyErrorCode {
  switch (verification) {
    case 'reverted':
      return 'WRITE_REVERTED';
    case 'mismatch':
      return 'VALUE_COERCED';
    case 'timeout':
      return 'VERIFY_TIMEOUT';
    case 'aborted':
      return 'ABORTED';
    default:
      return assertNever(verification, 'runApplyPlan verification');
  }
}

/**
 * A failed verdict is not necessarily a no-op: a host may retain a coerced
 * value, or still be settling when the watchdog fires. Preserve Undo whenever
 * the raw DOM value differs from the pre-write snapshot; undoAll() will still
 * refuse to overwrite a later user edit.
 */
function preserveUndoForChangedHostValue(
  journal: UndoJournal,
  ticket: WriteTicket,
  previous: string,
  element: ApplyPlanEntry['element'],
): void {
  if (readValue(element) === previous) {
    journal.abandon(ticket);
    return;
  }
  journal.commit(ticket, readValue(element));
}

/**
 * Verification deliberately spans a few event-loop turns. If the candidate
 * edits the control in that window, its final value must never become the
 * journal's "written" snapshot — doing so would let Undo overwrite a real
 * user edit. Our own writer dispatches untrusted events, so only a browser
 * trusted editing event can trip this latch.
 */
function watchTrustedUserEdits(element: ApplyPlanEntry['element']): {
  wasUserEdited: () => boolean;
  stop: () => void;
} {
  let userEdited = false;
  const onEdit = (event: Event) => {
    if (event.isTrusted) userEdited = true;
  };
  const eventTypes = ['beforeinput', 'input', 'change'] as const;
  for (const type of eventTypes) element.addEventListener(type, onEdit, true);

  return {
    wasUserEdited: () => userEdited,
    stop: () => {
      for (const type of eventTypes) element.removeEventListener(type, onEdit, true);
    },
  };
}

/**
 * Observe rather than interfere. A host can submit in response to our allowed
 * input/change events; capture listeners make the rest of this one fill run
 * fail closed without dispatching, cancelling, or modifying any host event.
 */
function watchHostSubmission(plan: ApplyPlan): HostSubmissionWatch {
  const hostDocument = plan.entries[0]!.element.ownerDocument;
  const hostWindow = hostDocument.defaultView;
  let didSubmit = false;
  let resolveSubmitted: (() => void) | null = null;
  const submission = new Promise<void>((resolve) => {
    resolveSubmitted = resolve;
  });
  const onSubmitted = (event: Event) => {
    // A preinstalled submission authority gate may cancel an unreviewed host
    // attempt before this observer runs. Seeing a cancelled event is not a
    // submission fact and must not erase the audit/undo result of this fill.
    if (
      event.type === 'submit' &&
      event.defaultPrevented &&
      wasSubmissionBlockedByAuthority(event)
    ) return;
    if (didSubmit) return;
    didSubmit = true;
    resolveSubmitted?.();
  };

  let documentListenerInstalled = false;
  try {
    hostDocument.addEventListener('submit', onSubmitted, true);
    documentListenerInstalled = true;
    hostWindow?.addEventListener('beforeunload', onSubmitted, true);
  } catch (error) {
    if (documentListenerInstalled) hostDocument.removeEventListener('submit', onSubmitted, true);
    hostWindow?.removeEventListener('beforeunload', onSubmitted, true);
    throw error;
  }

  return {
    submitted: () => didSubmit,
    wait: () => submission,
    stop: () => {
      hostDocument.removeEventListener('submit', onSubmitted, true);
      hostWindow?.removeEventListener('beforeunload', onSubmitted, true);
    },
  };
}

function markResultsFrom(
  plan: ApplyPlan,
  results: Array<ApplyWriteResult | null>,
  start: number,
  reason: ApplyErrorCode,
): void {
  for (let index = start; index < plan.entries.length; index += 1) {
    if (results[index]) continue;
    const entry = plan.entries[index]!;
    results[index] = { key: entry.key, label: entry.label, ok: false, reason };
  }
}

/**
 * A microtask checkpoint is new for plain writes. Preserve the old ordering in
 * the one case where a synchronous host handler already changed the next field
 * identity before it queued submission: that field remains IDENTITY_CHANGED,
 * while submission still owns the run and every later untouched entry.
 */
function markHostSubmissionAfterMutationCheckpoint(
  plan: ApplyPlan,
  results: Array<ApplyWriteResult | null>,
  start: number,
  root: ScanRoot,
): void {
  const next = plan.entries[start];
  if (
    next &&
    next.element.isConnected &&
    fieldSignature(next.element, root).core !== next.signature.core
  ) {
    results[start] = {
      key: next.key,
      label: next.label,
      ok: false,
      reason: 'IDENTITY_CHANGED',
    };
    markResultsFrom(plan, results, start + 1, 'HOST_SUBMITTED');
    return;
  }
  markResultsFrom(plan, results, start, 'HOST_SUBMITTED');
}

/** Submission stops filling, but cannot erase an explicit way to undo retained material. */
function abandonPendingForHostSubmission(
  pending: readonly PendingVerification[],
  results: Array<ApplyWriteResult | null>,
  journal: UndoJournal,
): void {
  for (const item of pending) {
    if (results[item.index]) continue;
    item.bridge?.abort();
    if (item.entry.kind === 'richtext') {
      journal.commit(item.ticket, readValue(item.entry.element));
    } else {
      journal.abandon(item.ticket);
    }
    results[item.index] = {
      key: item.entry.key,
      label: item.entry.label,
      ok: false,
      reason: 'HOST_SUBMITTED',
    };
  }
}

type VerificationWait =
  | { readonly kind: 'verified'; readonly verification: WriteVerification }
  | { readonly kind: 'submitted' };

function waitForVerificationOrSubmission(
  item: PendingVerification,
  submission: HostSubmissionWatch,
): Promise<VerificationWait> {
  if (submission.submitted()) return Promise.resolve({ kind: 'submitted' });
  return Promise.race([
    item.verification.then((verification) => ({ kind: 'verified' as const, verification })),
    submission.wait().then(() => ({ kind: 'submitted' as const })),
  ]);
}

/**
 * 「我们写进去的那个值现在还在不在」——轮内延时复检与整轮之后的复核共用这一个定义。
 *
 * 三态，不是两态。`null` = **读不到**（控件已被宿主卸掉），与「值没了」必须分开：
 * 重新挂载一个等价节点与真的移除，在不重新扫描的前提下分不出来，判成没了会是
 * 反方向的谎。两个调用方都把 `null` 当作「不改判」。
 */
/**
 * 宿主把写过的输入框整个重新挂载了——值落在了哪个节点上？
 *
 * 2026-09-22 在 nvidia.wd5.myworkdayjobs.com 真实量到：改值之后派 blur + focusout（写入器
 * 最后那两个事件，给「失焦时校验」的表单用的），Workday 在 300 毫秒内把那个输入框换成一个
 * 新节点，**新节点里就是我们写的值**；同段其它框都不动。回读攥着旧节点，于是报 DETACHED
 * ——14 页里 12 页面板写着「0 / 5 必填」，而值其实都在表单里。一个假失败。
 *
 * 认接班人只认**同一个表单根里、签名完全一样的恰好一个**节点：`fieldSignature` 的 core
 * （标签、类型、name 形状、作用域、作用域内序号）加上标签。签名本来就是为「扛住预览到
 * 写入之间的重渲染」设计的，框架生成的 id 刻意不参与。挪了位置的节点序号变了，不认。
 * 然后里面必须正好是我们写的值——宿主把值扔了就不是成功。
 *
 * 只处理文本类控件：选择题与文件的重挂载各有语义（选中项、文件身份），不在这里猜。
 * 这一步**不写任何东西**，只是认出我们的写入落到了哪里。
 */
function remountedSuccessor(
  entry: ApplyPlanEntry,
  root: ScanRoot,
  expected: string | undefined,
): Element | null {
  if (expected === undefined) return null;
  if (entry.kind !== 'text' && entry.kind !== 'textarea') return null;
  let found: Element | null = null;
  for (const candidate of root.querySelectorAll(entry.element.localName)) {
    if (!candidate.isConnected || candidate === entry.element) continue;
    const signature = fieldSignature(candidate, root);
    if (signature.core !== entry.signature.core || signature.labelHint !== entry.signature.labelHint) continue;
    // 签名里带着序号，两个节点撞同一个签名在结构上不该发生；真撞了就不猜。
    if (found !== null) return null;
    found = candidate;
  }
  if (found === null) return null;
  if (!(found instanceof HTMLInputElement) && !(found instanceof HTMLTextAreaElement)) return null;
  const actual = readValue(found);
  const holds = isTelReadback(entry)
    ? telValuesEquivalent(expected, actual)
    : valuesEquivalent(expected, actual);
  return holds ? found : null;
}

function writtenValueStillHolds(
  entry: ApplyPlanEntry,
  expected: string,
  root: ScanRoot,
): boolean | null {
  if (!entry.element.isConnected) return null;
  if (entry.kind === 'richtext') {
    return isCurrentPlainTextContenteditableAttestation({
      attestation: entry.plainTextContenteditableAttestation,
      root,
      element: entry.element,
      purpose: 'fill',
    }) && hasPlainTextOnlyStructure(entry.element) &&
      fieldSignature(entry.element, root).core === entry.signature.core &&
      fieldSignature(entry.element, root).labelHint === entry.signature.labelHint &&
      readValue(entry.element) === expected;
  }
  return isTelReadback(entry)
    ? telValuesEquivalent(expected, readValue(entry.element))
    : valuesEquivalent(expected, readValue(entry.element));
}

function summarizeRun(
  plan: ApplyPlan,
  results: Array<ApplyWriteResult | null>,
  abortedBy: ApplyRunAbort | null,
  identityDrift: number,
  labelHintDrifted: number,
  recheckable: readonly { readonly index: number; readonly holds: () => boolean | null }[],
): ApplyRunSummary {
  const completed = results.map((result) => {
    if (result) return result;
    throw new Error('apply: write result missing after verification');
  });
  const recheck = (): readonly ApplyWriteResult[] => {
    // 每次都从本轮的原始结论重新判：值被放回去就如实答 ok，不吃掉自己上一次的改判。
    const revised = [...completed];
    for (const item of recheckable) {
      const settled = completed[item.index];
      // 已经失败的条目有更具体的诊断，不得被洗成 LATE_REVERTED。
      if (settled === undefined || !settled.ok) continue;
      let holds: boolean | null;
      try {
        holds = item.holds();
      } catch {
        // 读取口坏掉是「读不到」，不是「值没了」。
        holds = null;
      }
      if (holds !== false) continue;
      const entry = plan.entries[item.index]!;
      revised[item.index] = { key: entry.key, label: entry.label, ok: false, reason: 'LATE_REVERTED' };
    }
    return revised;
  };
  const filled = completed.filter((result) => result.ok).length;
  const failed = completed.filter((result, index) => {
    const isComboboxPrefilled =
      plan.entries[index]?.kind === 'combobox' &&
      !result.ok &&
      result.reason === 'NOT_EMPTY';
    return !result.ok && !isComboboxPrefilled;
  }).length;
  return {
    results: completed,
    filled,
    // A semantic combobox MATCH is an explicit no-write/PREFILLED outcome.
    // Other controls keep their existing NOT_EMPTY failure accounting.
    failed,
    abortedBy,
    identityDrift,
    labelHintDrifted,
    recheck,
  };
}

/**
 * Fill a reviewed plan. Any invalid precondition fails before the first host
 * property write. Before a bounded interaction yields, the caller-owned
 * authority is moved into a runner-private object; asynchronous readback starts
 * before that private object is released but never writes a host field, then
 * decides whether a ticket may be committed to Undo.
 */
export async function runApplyPlan(input: RunApplyPlanInput): Promise<ApplyRunSummary> {
  const { plan, auth, journal, root, policy, startMainWorldBridge, resolveResumeFile, resolveCoverLetterFile, signal } = input;
  const now = input.now ?? (() => Date.now());
  const deliverHostMutations = async () => {
    // Invoke the deterministic test/host seam synchronously, but never let it
    // replace the native task boundary that production correctness relies on.
    const additionalCheckpoint = input.mutationDeliveryCheckpoint?.();
    await nextMutationDeliveryTask();
    await additionalCheckpoint;
  };
  const policyStillEnabled = () =>
    isApplyPolicyEnabled(policy, plan.vendor, now()) &&
    Number.isFinite(policy.minConfidence) &&
    policy.minConfidence >= 0 &&
    policy.minConfidence <= 1;
  const signOnBehalfStillAllowed = (kind: SignOnBehalfKind) => {
    if (policy.capabilities['sign-on-behalf'] !== true || !policyStillEnabled()) return false;
    try {
      return input.signOnBehalfCurrent?.(kind) === true;
    } catch {
      return false;
    }
  };
  const scanStillCurrent = () => {
    if (!input.scanStillCurrent) return true;
    try {
      return input.scanStillCurrent() === true;
    } catch {
      return false;
    }
  };
  if (plan.entries.length === 0) {
    return { results: [], filled: 0, failed: 0, abortedBy: null, identityDrift: 0, labelHintDrifted: 0, recheck: () => [] };
  }

  const consumed = consumeAuthority(auth);
  if (!consumed.ok) return rejectedRun(plan, consumed.code);
  let writeAuthority = consumed.value;
  let writeAuthorityIsPrivate = false;
  const ensurePrivateWriteAuthority = (): ApplyErrorCode | null => {
    if (writeAuthorityIsPrivate) return null;
    const isolated = isolateConsumedAuthority(writeAuthority);
    if (!isolated.ok) return isolated.code;
    writeAuthority = isolated.value;
    writeAuthorityIsPrivate = true;
    return null;
  };

  // Session validates the cached policy before narrowing an authority,
  // but the runner is the last synchronous boundary before any host setter.
  // Treat an invalid test seam or a policy that closed while the preview was
  // open exactly like a kill switch: consume this one-shot authority and write
  // nothing. The storage-backed resolver already guarantees 0..1; checking
  // again makes this exported boundary fail closed for every caller.
  if (
    !policyStillEnabled()
  ) {
    releaseAuthority(writeAuthority);
    return rejectedRun(plan, 'POLICY_DISABLED');
  }

  const results: Array<ApplyWriteResult | null> = plan.entries.map(() => null);
  // 差分广播，而不是在四十来处 `results[index] = …` 各插一行：逐点插钩子既漏得
  // 到处都是，又会把通知塞进写入事务的中途。这里只在几个静默检查点问一句
  // 「自上次以来有哪些格子变了」，通知之后 runner 原有的那串栅栏照常重跑一遍。
  const announced: Array<ApplyWriteResult | null> = plan.entries.map(() => null);
  const onFieldSettled = input.onFieldSettled;
  let announcing = onFieldSettled !== undefined;
  const announceSettled = (): void => {
    if (!announcing) return;
    for (const [index, result] of results.entries()) {
      if (result === null || result === announced[index]) continue;
      // 先记下再通知：抛出来的那一条不再重播，坏掉的出口也不会在剩下的每个
      // 检查点上反复抛。
      announced[index] = result;
      try {
        onFieldSettled!(index, result);
      } catch {
        // 这是个显示出口，不是可失败的操作：它的故障停在这里，整轮的结论
        // 与 `ApplyRunSummary` 完全不受影响，调用方仍然拿得到终局视图。
        announcing = false;
        return;
      }
    }
  };
  // 「轮到这一栏」与「已写入、待确认」两声：与上面同一条纪律——抛过一次就不再广播。
  let liveAnnouncing = input.onFieldStart !== undefined || input.onFieldWritten !== undefined;
  const announceLive = (hook: ((index: number) => void) | undefined, index: number): void => {
    if (!liveAnnouncing || hook === undefined) return;
    try {
      hook(index);
    } catch {
      liveAnnouncing = false;
    }
  };
  const pending: PendingVerification[] = [];
  const pendingRichtextCompensations: WriteTicket[] = [];
  const pendingCombobox: PendingComboboxVerification[] = [];
  // 下拉部件交出来的延时复查（2026-09-23）：它们选完、看到值显示出来就返回，「值还在不在」
  // 这一问留到整轮收尾那一次统一的延时复检里问，不再每个下拉各等一遍 lateRecheckMs。
  const deferredWidgetRechecks: Array<{ readonly index: number; readonly stillHolds: () => boolean }> = [];
  // 通用路的 ARIA 下拉（2026-09-28）：同一轮里一模一样的部件只探一次（write/ariaComboboxGeneric.ts）。
  const genericComboboxShapes: GenericComboboxShapeMemo = new Map();
  let submission: HostSubmissionWatch | null = null;
  let authorityReleased = false;
  let abortedBy: ApplyRunAbort | null = null;
  let identityDrift = 0;
  let labelHintDrifted = 0;
  let drainLateVerifications = false;

  try {
    submission = watchHostSubmission(plan);
    const hostSubmission = submission;
    const currentExecutionError = (): ApplyErrorCode | null => {
      if (hostSubmission.submitted()) return 'HOST_SUBMITTED';
      if (signal?.aborted) return 'ABORTED';
      if (!policyStillEnabled()) return 'POLICY_DISABLED';
      if (!scanStillCurrent()) return 'ABORTED';
      return null;
    };
    try {
      if (auth.purpose !== 'fill' || auth.fingerprint !== plan.fingerprint) {
        return rejectedRun(plan, 'PLAN_STALE');
      }

      for (const [index, entry] of plan.entries.entries()) {
        // 上一栏的结局在这里出去，随后下面那串栅栏（abort / 提交 / policy /
        // 扫描当前性）在通知回来之后原样重跑一遍。
        announceSettled();
        const { key, label } = entry;
        const element = entry.element;
        const stopAfterExecutionCallback = (reason: ApplyErrorCode): void => {
          results[index] = { key, label, ok: false, reason };
          if (reason === 'HOST_SUBMITTED') abortedBy = 'HOST_SUBMITTED';
          markResultsFrom(plan, results, index + 1, reason);
        };

        if (signal?.aborted) {
          markResultsFrom(plan, results, index, 'ABORTED');
          break;
        }
        if (hostSubmission.submitted()) {
          abortedBy = 'HOST_SUBMITTED';
          markResultsFrom(plan, results, index, 'HOST_SUBMITTED');
          break;
        }
        if (!policyStillEnabled()) {
          markResultsFrom(plan, results, index, 'POLICY_DISABLED');
          break;
        }
        if (!scanStillCurrent()) {
          markResultsFrom(plan, results, index, 'ABORTED');
          break;
        }
        if (!policy.capabilities[CAPABILITY_BY_KIND[entry.kind]]) {
          results[index] = { key, label, ok: false, reason: 'CAPABILITY_DISABLED' };
          continue;
        }
        // 代填的条款同意、属实声明与签名：写之前再核一次——策略里这一位仍开着、用户的同意仍成立。
        if (entry.signOnBehalf !== undefined && !signOnBehalfStillAllowed(entry.signOnBehalf)) {
          results[index] = { key, label, ok: false, reason: 'CAPABILITY_DISABLED' };
          continue;
        }
        if (!element.isConnected) {
          results[index] = { key, label, ok: false, reason: 'DETACHED' };
          continue;
        }

        const liveSignature = fieldSignature(element, root);
        const labelHintHadDrifted = liveSignature.labelHint !== entry.signature.labelHint;
        if (liveSignature.core !== entry.signature.core) {
          // 不连坐（2026-09-23）：只放弃这一栏。原先这里把后面所有栏标成 ABORTED、整轮停手——
          // Greenhouse 的 EEO 答完「是否拉美裔」才插进种族题，Veteran 那一栏序号一挪，排在最后的
          // 简历就被连带作废（批测 0/4）。后面每一栏写前都各自重验结构身份，页面变过之后还要求
          // 题面文字与计划时相同（下一条），不会把值写进换了题的格子。
          results[index] = { key, label, ok: false, reason: 'IDENTITY_CHANGED' };
          identityDrift += 1;
          continue;
        }
        // 这一轮里页面已经变过结构：往后的栏结构对得上还不够，题面文字也得与计划时相同才写。
        if (identityDrift > 0 && labelHintHadDrifted) {
          results[index] = { key, label, ok: false, reason: 'IDENTITY_CHANGED' };
          identityDrift += 1;
          continue;
        }
        if (entry.kind !== 'file' && labelHintHadDrifted) labelHintDrifted += 1;

        // 代填（第二刀，2026-09-23）：我们以用户名义答的是计划时读到的那句话。单选组与原生下拉在
        // 点击当下看不到题面，所以写之前要求控件旁的文字与计划时逐字相同；变了就不替他答这一栏。
        if (entry.signOnBehalf !== undefined && labelHintHadDrifted) {
          results[index] = { key, label, ok: false, reason: 'IDENTITY_CHANGED' };
          continue;
        }

        // Cover Letter is a narrow material target, not a generic long-answer
        // fallback. A label change after preview can turn the same structural
        // node into a sensitive/manual field, so exact review identity wins
        // over the generic non-blocking label-drift metric.
        // 与结构漂移同一条纪律（2026-09-23）：只放弃这一栏、记进 identityDrift。这道闸护的是
        // 「这一格换了题」，那是这一格自己的事；后面的栏各自写前重验，漂移之后还要求题面不变。
        if (entry.key === 'coverLetter' && labelHintHadDrifted) {
          results[index] = { key, label, ok: false, reason: 'IDENTITY_CHANGED' };
          identityDrift += 1;
          continue;
        }

        // 富文本的规则证明（exact attrMap attestation）不再成立：同上，只放弃这一栏。
        // 这里是写前的第一道；记还原票据时封存、setter 之前的那几道证明照旧在写入原语里。
        if (
          entry.kind === 'richtext' &&
          !isCurrentPlainTextContenteditableAttestation({
            attestation: entry.plainTextContenteditableAttestation,
            root,
            element: entry.element,
            purpose: 'fill',
          })
        ) {
          results[index] = { key, label, ok: false, reason: 'IDENTITY_CHANGED' };
          identityDrift += 1;
          continue;
        }

        // A candidate may type after reviewing the preview but before the
        // trusted Fill click. Re-read at the final possible point and leave it
        // alone rather than turn a stale empty-field plan into an overwrite.
        // 唯一的例外是调用方点名收回的那几栏（`reclaim`）：此刻的值逐字仍是它记下的宿主值才写。
        const reclaimable = (): boolean => {
          if (entry.kind !== 'text' && entry.kind !== 'textarea' && entry.kind !== 'select') return false;
          const hostValue = input.reclaim?.get(element);
          return hostValue !== undefined && readValue(element) === hostValue;
        };
        // 下拉部件也收得回（2026-10-04，Rippling 的 Location 被简历解析改写）：点名收回、此刻输入框里仍逐字是记下的宿主值，
        // 部件写入器这一栏就不按「非空不写」拦——资料里的值为准，重选一次。值变了（用户在改）照旧拦。
        const widgetFillEmptyOnly = (): boolean => {
          if (!plan.fillEmptyOnly) return false;
          if (entry.kind !== 'combobox') return true;
          const hostValue = input.reclaim?.get(element);
          return !(hostValue !== undefined && readValue(element) === hostValue);
        };
        if (
          entry.kind !== 'combobox' &&
          entry.kind !== 'choice' &&
          (
            (entry.key === 'coverLetter' && readValue(element) !== '') ||
            (entry.key !== 'coverLetter' && plan.fillEmptyOnly && readValue(element).trim() !== '' && !reclaimable())
          )
        ) {
          results[index] = { key, label, ok: false, reason: 'NOT_EMPTY' };
          continue;
        }

        // Planning uses the bundled baseline so the preview stays available
        // while policy is loading. A fresh policy may only tighten that
        // baseline; re-check the frozen match score immediately before taking
        // an Undo ticket, so an out-of-date preview cannot widen a host write.
        if (!Number.isFinite(entry.confidence) || entry.confidence < policy.minConfidence) {
          results[index] = { key, label, ok: false, reason: 'LOW_CONFIDENCE' };
          continue;
        }

        // 写前的检查都过了：这一栏此刻真的要动手了。
        announceLive(input.onFieldStart, index);

        // File bytes are L1 and potentially large. Prove the live target and
        // set-file capability before asking background to retrieve anything.
        // Repeat every volatile proof after the await, before recording/writing.
        if (entry.kind === 'file') {
          // 简历还是求职信（2026-09-27）：各走各的身份判据与取件函数，写入原语同一个（attachHostFile 按用途核身份）。
          const coverLetterFile = entry.key === 'coverLetter';
          const fileChecks = fileTargetChecks(coverLetterFile ? 'cover-letter' : 'resume');
          if (!policy.capabilities['set-file']) {
            results[index] = { key, label, ok: false, reason: 'CAPABILITY_DISABLED' };
            continue;
          }
          const preflight = checkActiveCapability(writeAuthority, 'set-file');
          if (!preflight.ok) {
            results[index] = { key, label, ok: false, reason: preflight.code };
            continue;
          }
          // 三个原因分开处理（2026-08-21）。原先这里对
          // `isApprovedResumeFileTarget` 一律报 IDENTITY_CHANGED 并 break 整轮，
          // 于是一个 disabled 或藏起来的上传控件会把它**后面**的所有字段废成
          // ABORTED——损失多少纯看它在 DOM 里排第几。同一分支的邻居
          // （CAPABILITY_DISABLED、能力位 preflight）本来就是 continue，
          // 这里对齐同一纪律。
          if (!fileChecks.approvedIdentity(entry.element, root)) {
            // 身份漂了：页面级信号，如实记进 identityDrift（调用方据此重扫）。文件条目
            // 排在计划最后，后面只剩其它文件条目，每一条写前都重验自己的身份与签名。
            results[index] = { key, label, ok: false, reason: 'IDENTITY_CHANGED' };
            identityDrift += 1;
            continue;
          }
          if (!fileChecks.approvedTarget(entry.element, root)) {
            // 身份没变，只是此刻写不进去（disabled / 无可见触发器）。
            // 如实报这一栏，其余字段照常。
            results[index] = { key, label, ok: false, reason: 'TARGET_NOT_WRITABLE' };
            continue;
          }

          let file: File | null = null;
          const authorityIsolationError = ensurePrivateWriteAuthority();
          if (authorityIsolationError) {
            results[index] = { key, label, ok: false, reason: authorityIsolationError };
            markResultsFrom(plan, results, index + 1, authorityIsolationError);
            break;
          }
          try {
            const resolveFile = coverLetterFile ? resolveCoverLetterFile : resolveResumeFile;
            file = resolveFile
              ? await resolveFile({ authorityExpiresAt: auth.expiresAt, signal })
              : null;
          } catch {
            file = null;
          }
          if (signal?.aborted) {
            results[index] = { key, label, ok: false, reason: 'ABORTED' };
            markResultsFrom(plan, results, index + 1, 'ABORTED');
            break;
          }
          if (hostSubmission.submitted()) {
            results[index] = { key, label, ok: false, reason: 'HOST_SUBMITTED' };
            abortedBy = 'HOST_SUBMITTED';
            markResultsFrom(plan, results, index + 1, 'HOST_SUBMITTED');
            break;
          }
          if (!policyStillEnabled()) {
            results[index] = { key, label, ok: false, reason: 'POLICY_DISABLED' };
            markResultsFrom(plan, results, index + 1, 'POLICY_DISABLED');
            break;
          }
          if (!scanStillCurrent()) {
            results[index] = { key, label, ok: false, reason: 'ABORTED' };
            markResultsFrom(plan, results, index + 1, 'ABORTED');
            break;
          }
          if (!entry.element.isConnected) {
            results[index] = { key, label, ok: false, reason: 'DETACHED' };
            continue;
          }

          const finalSignature = fieldSignature(entry.element, root);
          if (
            finalSignature.core !== entry.signature.core ||
            !fileChecks.approvedIdentity(entry.element, root)
          ) {
            // 同上：文件目标的身份漂移只废这一条，不连坐其余文件条目；如实记进 identityDrift。
            results[index] = { key, label, ok: false, reason: 'IDENTITY_CHANGED' };
            identityDrift += 1;
            continue;
          }
          // 等字节的这段时间就是宿主重渲染的窗口：这一轮页面已经变过结构的话，写前的题面文字
          // 要求在真正挂文件的这一刻再成立一次（与其它栏「漂移之后题面也得不变」同一条纪律）。
          if (identityDrift > 0 && finalSignature.labelHint !== entry.signature.labelHint) {
            results[index] = { key, label, ok: false, reason: 'IDENTITY_CHANGED' };
            identityDrift += 1;
            continue;
          }
          if (!fileChecks.approvedTarget(entry.element, root)) {
            // 等文件字节的这段时间里目标变得不可写（disabled / 触发器没了）：
            // 与写前那道检查同一纪律，如实报这一栏，其余照常。
            results[index] = { key, label, ok: false, reason: 'TARGET_NOT_WRITABLE' };
            continue;
          }
          if (labelHintHadDrifted || finalSignature.labelHint !== entry.signature.labelHint) {
            labelHintDrifted += 1;
          }
          if (!file) {
            results[index] = { key, label, ok: false, reason: 'NO_VALUE' };
            continue;
          }

          const recorded = journal.record(entry.element);
          if (!recorded.ok) {
            results[index] = { key, label, ok: false, reason: recorded.code };
            continue;
          }
          // 写之前记下这一栏的容器：宿主收下文件后可能把 input 换掉，之后只在这个容器里找它显示的文件名。
          const hostAdopted = watchHostFileAdoption(entry.element, root, file);
          // 规则声明了这种上传部件怎么说「收下了」（2026-09-28 Workday）：写之前记下部件里此刻有几项「就是这一份、传好了」。
          const declaredUpload = entry.kind === 'file' && entry.upload !== undefined
            ? watchDeclaredUpload(entry.element, root, entry.upload, file)
            : null;
          /** 宿主列出了这一次挂上的这一份、并且说传好了：这就是它的确认（读不回文件框也算已核对）。 */
          const hostConfirmed = (): Promise<boolean> =>
            declaredUpload === null ? Promise.resolve(false) : awaitHostFileAdoption(declaredUpload, signal, DECLARED_UPLOAD_WAIT_MS);
          const attached = attachHostFile({
            element: entry.element,
            file,
            root,
            authority: writeAuthority,
            ticket: recorded,
            policy,
            purpose: coverLetterFile ? 'cover-letter' : 'resume',
          });
          if (attached.ok) {
            journal.commitFile(recorded.value, file);
            // 文件控件的回读是 `input.files` 的对象同一性，attachHostFile 刚刚
            // 做过；只有宿主把 input 卸掉/换掉（只留一个文件名 chip）时才真的
            // 读不回来。以前这里对两种情形一律盖 unverified，于是 2026-09-17
            // 那轮 Ashby 上 89 条已经填好的必填简历栏被算成"还没办完"。
            //
            // 读得到之后剩下的问题与文本同一条：宿主收不收（CAP-AF-068）。
            // 读 DOM 由调用方注入；不注入则维持 unknown=成功的既有口径。
            if (attached.value === 'readback') {
              const hostVerdict = input.readHostValidation
                ? classifyHostValidation(input.readHostValidation(entry.element))
                : 'unknown';
              results[index] = hostVerdict === 'rejected'
                ? { key, label, ok: false, reason: 'HOST_REJECTED' }
                : { key, label, ok: true };
            } else {
              results[index] = await hostConfirmed()
                ? { key, label, ok: true }
                : { key, label, ok: true, unverified: true };
            }
          } else {
            // attachHostFile restores the known pre-write empty FileList on any
            // post-event failure. If a hostile setter prevents that rollback,
            // retain the ticket instead of leaving our exact L1 File with no Undo.
            if (entry.element.files?.length === 1 && entry.element.files[0] === file) {
              journal.commitFile(recorded.value, file);
            } else {
              journal.abandon(recorded.value);
            }
            // 宿主在 change 里拿走文件、清空 input，稍后才显示文件名（2026-09-28 通用路：Flow.js、Ashby 的表）：
            // 同一拍里读不回来的 VALUE_COERCED，再等一小会儿看这一栏自己的容器里有没有出现这个文件名。
            // 出现了就是宿主收下了——与同一拍里显示文件名同一个判据，报成功、标 unverified；一直不出现照旧失败。
            // 规则声明的部件说「传好了」的，就是宿主确认收下了这一份（2026-09-28 Workday：它在 change 里清空文件框）。
            results[index] = attached.code === 'VALUE_COERCED' && await hostConfirmed()
              ? { key, label, ok: true }
              : attached.code === 'VALUE_COERCED' && await awaitHostFileAdoption(hostAdopted, signal)
                ? { key, label, ok: true, unverified: true }
                : { key, label, ok: false, reason: attached.code };
          }
          await deliverHostMutations();
          if (hostSubmission.submitted()) {
            abortedBy = 'HOST_SUBMITTED';
            markResultsFrom(plan, results, index + 1, 'HOST_SUBMITTED');
            break;
          }
          if (!policyStillEnabled()) {
            markResultsFrom(plan, results, index + 1, 'POLICY_DISABLED');
            break;
          }
          if (!scanStillCurrent()) {
            markResultsFrom(plan, results, index + 1, 'ABORTED');
            break;
          }
          if (signal?.aborted) {
            markResultsFrom(plan, results, index + 1, 'ABORTED');
            break;
          }
          continue;
        }

        // 单选/复选：整组一道题，fill-first（与文件同一纪律：不进撤销日志）。
        if (entry.kind === 'choice') {
          const lateRecheckMs = input.lateRecheckMs;
          if (lateRecheckMs === undefined || !(lateRecheckMs > 0)) {
            results[index] = { key, label, ok: false, reason: 'CAPABILITY_DISABLED' };
            continue;
          }
          // 带着代填标记却不是选择题那几类（签名栏的类别）：计划不会这样排，排了也不写——不带标记地
          // 写下去，原生组会回落到属性写入，绕开点击策略。
          if (entry.signOnBehalf !== undefined && !isSignOnBehalfChoiceKind(entry.signOnBehalf)) {
            results[index] = { key, label, ok: false, reason: 'CAPABILITY_DISABLED' };
            continue;
          }
          const authorityIsolationError = ensurePrivateWriteAuthority();
          if (authorityIsolationError) {
            results[index] = { key, label, ok: false, reason: authorityIsolationError };
            markResultsFrom(plan, results, index + 1, authorityIsolationError);
            break;
          }
          const outcome = await fillChoiceGroup({
            questionId: key,
            choice: entry.choice,
            lines: entry.value.split('\n'),
            root,
            // 原生激活是 click，所以它另受点击能力位约束（与下拉同一位）：
            // 部署把点击关掉时，这一栏自动回落到属性写入，而不是整组填不上。
            clickCapabilityCurrent: () =>
              policyStillEnabled() &&
              policy.capabilities['set-combobox'] === true &&
              checkActiveCapability(writeAuthority, 'set-combobox').ok &&
              (entry.signOnBehalf === undefined || signOnBehalfStillAllowed(entry.signOnBehalf)),
            // 代填的框只走原生点击、每一下都过点击策略（fillChoiceGroup 对它不做属性回落）。
            ...(isSignOnBehalfChoiceKind(entry.signOnBehalf) ? { signOnBehalf: entry.signOnBehalf } : {}),
            authorizeWrite: async () =>
              checkActiveCapability(writeAuthority, 'set-select').ok && policyStillEnabled() && scanStillCurrent() && !hostSubmission.submitted(),
            ...(input.readHostValidation ? { readHostValidation: input.readHostValidation } : {}),
            executionFence: currentExecutionError,
            lateRecheckMs,
            ...(signal ? { signal } : {}),
          });
          results[index] = outcome.ok ? { key, label, ok: true } : { key, label, ok: false, reason: outcome.code };
          continue;
        }

        const previous = readValue(element);

        // 下拉走完全不同的路径：不 setValue，而是开→匹配→点，并且**必须**跨
        // 宏任务（实测同一 tick 内 0 个选项）。决策 17 正是为这一段放宽了授权
        // 窗口，所以它必须留在 releaseAuthority 之前的这个循环里。
        // 它自带结算，不进 C6 的 pending 队列——通用层没有可比对的值可读回，
        // 见 click/combobox.ts 头部那条"选项文案 ≠ 选中显示值"的实测。
        if (entry.kind === 'combobox' && entry.listbox !== undefined) {
          const lateRecheckMs = input.lateRecheckMs;
          if (lateRecheckMs === undefined || !(lateRecheckMs > 0)) {
            results[index] = { key, label, ok: false, reason: 'CAPABILITY_DISABLED' };
            continue;
          }
          const authorityIsolationError = ensurePrivateWriteAuthority();
          if (authorityIsolationError) {
            results[index] = { key, label, ok: false, reason: authorityIsolationError };
            markResultsFrom(plan, results, index + 1, authorityIsolationError);
            break;
          }
          // 代填的下拉只走 listbox 那一种部件：只有它把代填标记带进点击策略（engine 也只排这一种）。
          const signed = isSignOnBehalfChoiceKind(entry.signOnBehalf) ? entry.signOnBehalf : undefined;
          if (
            entry.signOnBehalf !== undefined &&
            (signed === undefined || entry.multiple === true || entry.listbox.typeahead !== undefined || entry.listbox.hierarchicalPrompt !== undefined || entry.listbox.searchPrompt !== undefined)
          ) {
            results[index] = { key, label, ok: false, reason: 'CAPABILITY_DISABLED' };
            continue;
          }
          const recorded = journal.record(entry.element);
          if (!recorded.ok) {
            results[index] = { key, label, ok: false, reason: recorded.code };
            continue;
          }
          // 同一个 binding 槽位、三种部件：带 typeahead 的是规则量过的纯文本建议框
          // （无 ARIA listbox），走 write/typeaheadCombobox.ts；带 hierarchicalPrompt 的
          // 是规则量过的**外挂分层菜单**（菜单不在表单根里、行没有 option 角色、值在
          // 分类下一层），走 write/hierarchicalPrompt.ts；其余是 ARIA listbox。
          const widgetInput = {
            trigger: entry.element,
            binding: entry.listbox,
            candidates: entry.comboboxCandidates,
            root,
            authority: writeAuthority,
            ticket: recorded,
            policy,
            fillEmptyOnly: widgetFillEmptyOnly(),
            // 代填的那一栏在交互途中每一道关口都再核一次：能力位仍开着、用户的同意仍成立。
            fence: signed === undefined
              ? currentExecutionError
              : () => currentExecutionError() ?? (signOnBehalfStillAllowed(signed) ? null : 'CAPABILITY_DISABLED'),
            lateRecheckMs,
            deferLateRecheck: (stillHolds: () => boolean) => { deferredWidgetRechecks.push({ index, stillHolds }); },
          };
          // A binding carries exactly one of these shapes (the interpreter builds one), so the order is not a choice.
          // 电话国际区号（2026-09-28）：只认号码自己写明的那个区号（engine 只在搜索式单选上排这一种条目）。
          const searched = entry.listbox.searchPrompt !== undefined
            ? await fillSearchPrompt(entry.callingCode === undefined ? widgetInput : { ...widgetInput, callingCode: entry.callingCode })
            : null;
          const outcome = searched ?? (entry.listbox.typeahead !== undefined
            ? await fillTypeaheadCombobox(widgetInput)
            : entry.listbox.hierarchicalPrompt !== undefined
              ? await fillHierarchicalPrompt(widgetInput)
              : await fillListboxCombobox({
                ...widgetInput,
                ...(entry.multiple ? { multiple: true } : {}),
                ...(entry.multiple && entry.singlePick === true ? { singlePick: true } : {}),
                ...(signed === undefined ? {} : { signOnBehalf: signed }),
              }));
          // A search prompt that took only some of its values says which it did not (the dock lists them).
          const misses = searched?.notAdded === undefined ? {} : { notAdded: searched.notAdded };
          if (outcome.ok) {
            journal.commit(recorded.value, outcome.value);
            results[index] = { key, label, ok: true, ...misses };
          } else {
            journal.abandon(recorded.value);
            results[index] = { key, label, ok: false, reason: outcome.code, ...misses };
          }
          continue;
        }

        // 通用路（2026-09-28）：没有规则绑定的 ARIA 下拉——`input[role=combobox]`（MUI Autocomplete 一类），
        // 或藏起来的原生下拉旁边替它说话的触发器（jQuery UI selectmenu、bootstrap-select）。点它自己的触发器、
        // 在它自己的面板里只选整条相等的一项、读回两次、核实面板关上（write/ariaComboboxGeneric.ts）。只在
        // 通用路上开：厂商路上这类部件由规则量过再声明绑定，没绑定的照旧不碰。代填的格不走这条路。
        const genericTrigger = plan.vendor !== 'generic'
          ? null
          : entry.kind === 'combobox' && entry.listbox === undefined && entry.semanticAuthority === undefined
            ? entry.element
            : entry.kind === 'select' && entry.selectProxy !== undefined
              ? entry.selectProxy
              : null;
        if (genericTrigger !== null && (entry.kind === 'combobox' || entry.kind === 'select')) {
          const lateRecheckMs = input.lateRecheckMs;
          if (lateRecheckMs === undefined || !(lateRecheckMs > 0) || entry.signOnBehalf !== undefined) {
            results[index] = { key, label, ok: false, reason: 'CAPABILITY_DISABLED' };
            continue;
          }
          // 藏起来的原生下拉：写前按同一个判据再认一次它的触发器，认不回来（换了、没了）就不点。
          if (entry.kind === 'select' && selectProxyOf(entry.element, root) !== entry.selectProxy) {
            results[index] = { key, label, ok: false, reason: 'TARGET_NOT_WRITABLE' };
            continue;
          }
          const authorityIsolationError = ensurePrivateWriteAuthority();
          if (authorityIsolationError) {
            results[index] = { key, label, ok: false, reason: authorityIsolationError };
            markResultsFrom(plan, results, index + 1, authorityIsolationError);
            break;
          }
          const recorded = journal.record(entry.element);
          if (!recorded.ok) {
            results[index] = { key, label, ok: false, reason: recorded.code };
            continue;
          }
          const select = entry.kind === 'select' ? entry.element : null;
          const outcome = await fillGenericCombobox({
            trigger: genericTrigger,
            query: entry.kind === 'combobox' ? entry.element : null,
            ...(select === null ? {} : { carrier: select }),
            candidates: entry.kind === 'combobox' ? entry.comboboxCandidates : [entry.value],
            readValue: select === null
              ? () => readValue(entry.element)
              : () => (select.value === '' ? '' : select.selectedOptions[0]?.text ?? ''),
            root,
            authority: writeAuthority,
            ticket: recorded,
            policy,
            fillEmptyOnly: widgetFillEmptyOnly(),
            fence: currentExecutionError,
            lateRecheckMs,
            deferLateRecheck: (stillHolds: () => boolean) => { deferredWidgetRechecks.push({ index, stillHolds }); },
            shapes: genericComboboxShapes,
          });
          if (outcome.ok) {
            journal.commit(recorded.value, outcome.value);
            results[index] = { key, label, ok: true };
          } else {
            journal.abandon(recorded.value);
            results[index] = { key, label, ok: false, reason: outcome.code };
          }
          continue;
        }

        if (entry.kind === 'combobox') {
          // 受控语义这条路不带代填标记（engine 也不排）：带着标记走到这里就不写。
          if (entry.signOnBehalf !== undefined) {
            results[index] = { key, label, ok: false, reason: 'CAPABILITY_DISABLED' };
            continue;
          }
          const semanticAuthority = entry.semanticAuthority;
          if (
            !isCompleteComboboxAuthority(semanticAuthority) ||
            typeof input.readHostValidation !== 'function' ||
            input.lateRecheckMs === undefined ||
            !Number.isFinite(input.lateRecheckMs) ||
            input.lateRecheckMs <= 0
          ) {
            results[index] = { key, label, ok: false, reason: 'CAPABILITY_DISABLED' };
            continue;
          }
          let selectionBeforeWrite: ComboboxSelectionState = 'UNVERIFIABLE';
          const semanticCandidates = entry.resolvedOptionText
            ? [entry.resolvedOptionText]
            : entry.comboboxCandidates;
          try {
            const candidateStates = semanticCandidates.map((candidate) =>
              semanticAuthority.readSelection(entry.element, candidate),
            );
            selectionBeforeWrite = candidateStates.includes('MATCH')
              ? 'MATCH'
              : candidateStates.every((state) => state === 'EMPTY')
                ? 'EMPTY'
                : candidateStates.includes('UNVERIFIABLE')
                  ? 'UNVERIFIABLE'
                  : 'MISMATCH';
          } catch {
            selectionBeforeWrite = 'UNVERIFIABLE';
          }
          const selectionFence = currentExecutionError();
          if (selectionFence !== null) {
            stopAfterExecutionCallback(selectionFence);
            break;
          }
          if (selectionBeforeWrite === 'MATCH') {
            let hostVerdict: ReturnType<typeof classifyHostValidation> = 'unknown';
            try {
              hostVerdict = classifyHostValidation(input.readHostValidation(entry.element));
            } catch {
              hostVerdict = 'unknown';
            }
            const validationFence = currentExecutionError();
            if (validationFence !== null) {
              stopAfterExecutionCallback(validationFence);
              break;
            }
            if (hostVerdict !== 'accepted') {
              results[index] = {
                key,
                label,
                ok: false,
                reason: hostVerdict === 'rejected' ? 'HOST_REJECTED' : 'CAPABILITY_DISABLED',
              };
              continue;
            }
            const expectedOptionText = semanticCandidates.find((candidate) => {
              try {
                return semanticAuthority.readSelection(entry.element, candidate) === 'MATCH';
              } catch {
                return false;
              }
            });
            const readbackFence = currentExecutionError();
            if (readbackFence !== null) {
              stopAfterExecutionCallback(readbackFence);
              break;
            }
            if (expectedOptionText === undefined) {
              results[index] = { key, label, ok: false, reason: 'CAPABILITY_DISABLED' };
              continue;
            }
            results[index] = { key, label, ok: false, reason: 'NOT_EMPTY' };
            pendingCombobox.push({
              index,
              entry,
              ticket: null,
              authority: semanticAuthority,
              undo: null,
              expectedOptionText,
            });
            continue;
          }
          if (plan.fillEmptyOnly && selectionBeforeWrite === 'MISMATCH') {
            results[index] = { key, label, ok: false, reason: 'NOT_EMPTY' };
            continue;
          }
          // A search input may display text while the host has selected
          // nothing. That exact B-R2 false-positive shape must not be treated
          // as empty permission to open/click, nor as an already-filled value.
          if (
            selectionBeforeWrite === 'EMPTY' &&
            readValue(entry.element).trim() !== ''
          ) {
            results[index] = { key, label, ok: false, reason: 'CAPABILITY_DISABLED' };
            continue;
          }
          if (
            selectionBeforeWrite === 'UNVERIFIABLE' ||
            (selectionBeforeWrite !== 'EMPTY' && selectionBeforeWrite !== 'MISMATCH')
          ) {
            results[index] = {
              key,
              label,
              ok: false,
              reason: 'CAPABILITY_DISABLED',
            };
            continue;
          }
          const authorityIsolationError = ensurePrivateWriteAuthority();
          if (authorityIsolationError) {
            results[index] = { key, label, ok: false, reason: authorityIsolationError };
            markResultsFrom(plan, results, index + 1, authorityIsolationError);
            break;
          }
          // A semantic MATCH is an explicit PREFILLED/no-write result. Mint the
          // Undo ticket only after every zero-click exit has been exhausted and
          // the runner is about to enter the real option-dispatch transaction.
          const recorded = journal.record(element);
          if (!recorded.ok) {
            results[index] = { key, label, ok: false, reason: recorded.code };
            continue;
          }
          const userEditWatch = watchTrustedUserEdits(entry.element);
          let outcome: Awaited<ReturnType<typeof selectComboboxOption>>;
          try {
            outcome = await selectComboboxOption({
              trigger: entry.element,
              previousRawValue: previous,
              desired: entry.value,
              ...(entry.comboboxCandidates.length > 1
                ? { alternates: entry.comboboxCandidates.slice(1) }
                : {}),
              ...(entry.comboboxHarvest ? { harvest: entry.comboboxHarvest } : {}),
              root,
              optionSource: semanticAuthority.optionSource,
              semanticTransactionSource: semanticAuthority.semanticTransactionSource,
              authority: writeAuthority,
              ticket: recorded,
              policy,
              signal,
              executionFence: () => {
                const userEdited = userEditWatch.wasUserEdited();
                const executionError = currentExecutionError();
                return userEdited ? 'ABORTED' : executionError;
              },
              readSelection: (liveTrigger: HTMLInputElement, expectedOptionText: string) =>
                semanticAuthority.readSelection(liveTrigger, expectedOptionText) === 'MATCH'
                  ? expectedOptionText
                  : null,
            });
          } finally {
            userEditWatch.stop();
          }
          let watcherUserEdited = true;
          try {
            watcherUserEdited = userEditWatch.wasUserEdited();
          } catch {
            watcherUserEdited = true;
          }
          // `wasUserEdited` is a callback boundary too. It may return a benign
          // value while revoking policy or invalidating the scan generation.
          let postCallbackStop = currentExecutionError();
          if (watcherUserEdited) {
            if (outcome.ok) outcome.value.undo.dispose();
            else outcome.recovery?.dispose();
            journal.abandon(recorded.value);
            results[index] = { key, label, ok: false, reason: 'ABORTED' };
          } else if (outcome.ok && postCallbackStop !== null) {
            const reason = failSemanticWriteAfterExecutionFence(
              journal,
              recorded.value,
              outcome.value.undo,
              postCallbackStop,
            );
            results[index] = { key, label, ok: false, reason };
          } else if (outcome.ok) {
            let hostVerdict: ReturnType<typeof classifyHostValidation> = 'unknown';
            try {
              hostVerdict = classifyHostValidation(input.readHostValidation(entry.element));
            } catch {
              hostVerdict = 'unknown';
            }
            const validationFence = currentExecutionError();
            if (validationFence !== null) {
              postCallbackStop = validationFence;
              const reason = failSemanticWriteAfterExecutionFence(
                journal,
                recorded.value,
                outcome.value.undo,
                validationFence,
              );
              results[index] = { key, label, ok: false, reason };
            } else if (hostVerdict !== 'accepted') {
              const compensation = compensateOrRetainSemanticFailure(
                journal,
                recorded.value,
                outcome.value.undo,
              );
              results[index] = compensation === 'RESTORED'
                ? {
                    key,
                    label,
                    ok: false,
                    reason: hostVerdict === 'rejected' ? 'HOST_REJECTED' : 'CAPABILITY_DISABLED',
                  }
                : compensation === 'USER_EDITED'
                  ? { key, label, ok: false, reason: 'ABORTED' }
                  : { key, label, ok: false, reason: 'IDENTITY_CHANGED' };
            } else {
              const committed = journal.commitSemantic(recorded.value, outcome.value.undo);
              // commitSemantic invokes the opaque `isAtWrittenState` callback.
              // Re-run execution authority after it before exposing success.
              const writtenStateFence = currentExecutionError();
              if (writtenStateFence !== null) {
                postCallbackStop = writtenStateFence;
                const reason = failSemanticWriteAfterExecutionFence(
                  journal,
                  recorded.value,
                  outcome.value.undo,
                  writtenStateFence,
                );
                results[index] = { key, label, ok: false, reason };
              } else if (!committed) {
                compensateOrRetainSemanticFailure(
                  journal,
                  recorded.value,
                  outcome.value.undo,
                );
                results[index] = { key, label, ok: false, reason: 'IDENTITY_CHANGED' };
              } else {
                results[index] = { key, label, ok: true };
                pendingCombobox.push({
                  index,
                  entry,
                  ticket: recorded.value,
                  authority: semanticAuthority,
                  undo: outcome.value.undo,
                  expectedOptionText: outcome.value.optionText,
                });
              }
            }
          } else {
            // A post-dispatch failure may retain recovery only when the click
            // layer has sealed the exact transaction-owned written state.
            // Unsealed third states return no handle and are never overwritten.
            if (outcome.recovery !== undefined) {
              if (!journal.retainSemanticFailure(recorded.value, outcome.recovery)) {
                outcome.recovery.dispose();
                journal.abandon(recorded.value);
              }
            } else {
              journal.abandon(recorded.value);
            }
            results[index] = { key, label, ok: false, reason: outcome.code };
          }
          await deliverHostMutations();
          // 这一段**仍然整轮停手**（2026-09-23 复核过，不跟写前漂移的不连坐）。写前漂移是在我们
          // 碰这一格之前、由这一格自己的签名查出来的；这里的 IDENTITY_CHANGED 来自一整笔受控交易
          // 的变异栅栏与补偿：页面在我们开菜单、选选项的交易途中变了（多半点击已经发出去），或者
          // 补偿证明不了回到写前状态——菜单可能还开着、受控状态落在第三种样子上。在一张说不清状态
          // 的页面上接着点别的控件，不是「只放弃这一栏」能兜住的。这条路只给规则自带语义读取口的
          // 受控下拉用（*-controlled-combobox-canary），Greenhouse 的 react-select 走 listbox 那条，
          // 不受影响。apply-combobox-reachable / -semantic-authority-hostile 锁着这一段。
          if (postCallbackStop !== null) {
            const result = results[index];
            if (result?.ok === false && result.reason === 'IDENTITY_CHANGED') {
              abortedBy ??= 'IDENTITY_CHANGED';
              markResultsFrom(plan, results, index + 1, 'ABORTED');
            } else {
              if (postCallbackStop === 'HOST_SUBMITTED') abortedBy = 'HOST_SUBMITTED';
              markResultsFrom(plan, results, index + 1, postCallbackStop);
            }
            break;
          }
          if (
            (!outcome.ok && outcome.code === 'IDENTITY_CHANGED') ||
            (results[index]?.ok === false && results[index].reason === 'IDENTITY_CHANGED')
          ) {
            abortedBy ??= 'IDENTITY_CHANGED';
            markResultsFrom(plan, results, index + 1, 'ABORTED');
            break;
          }
          if (hostSubmission.submitted()) {
            abortedBy = 'HOST_SUBMITTED';
            markResultsFrom(plan, results, index + 1, 'HOST_SUBMITTED');
            break;
          }
          if (!policyStillEnabled()) {
            markResultsFrom(plan, results, index + 1, 'POLICY_DISABLED');
            break;
          }
          if (!scanStillCurrent()) {
            markResultsFrom(plan, results, index + 1, 'ABORTED');
            break;
          }
          if (signal?.aborted) {
            markResultsFrom(plan, results, index + 1, 'ABORTED');
            break;
          }
          continue;
        }

        const recorded = journal.record(
          element,
          entry.kind === 'richtext'
            ? {
                plainTextContenteditable: {
                  root,
                  attestation: entry.plainTextContenteditableAttestation,
                },
              }
            : undefined,
        );
        if (!recorded.ok) {
          results[index] = { key, label, ok: false, reason: recorded.code };
          continue;
        }
        const attempted = asEntryWriteAttempt(
          writeEntry(entry, root, writeAuthority, recorded.value, startMainWorldBridge),
        );
        const authorityIsolationError = ensurePrivateWriteAuthority();
        if (!attempted.ok) {
          if (entry.kind === 'richtext' && hasPlainTextContenteditableWriteAttempt(recorded.value)) {
            journal.commit(recorded.value, readValue(element));
            pendingRichtextCompensations.push(recorded.value);
          } else {
            journal.abandon(recorded.value);
          }
          results[index] = { key, label, ok: false, reason: attempted.code };
          await deliverHostMutations();
          if (hostSubmission.submitted()) {
            abortedBy = 'HOST_SUBMITTED';
            markHostSubmissionAfterMutationCheckpoint(plan, results, index + 1, root);
            break;
          }
          if (!policyStillEnabled()) {
            markResultsFrom(plan, results, index + 1, 'POLICY_DISABLED');
            break;
          }
          if (!scanStillCurrent()) {
            markResultsFrom(plan, results, index + 1, 'ABORTED');
            break;
          }
          if (signal?.aborted) {
            markResultsFrom(plan, results, index + 1, 'ABORTED');
            break;
          }
          if (authorityIsolationError) {
            markResultsFrom(plan, results, index + 1, authorityIsolationError);
            break;
          }
          continue;
        }

        const userEditWatch = watchTrustedUserEdits(element);
        pending.push({
          index,
          entry,
          ticket: recorded.value,
          previous,
          wasUserEdited: userEditWatch.wasUserEdited,
          stopWatchingUserEdits: userEditWatch.stop,
          bridge: attempted.value.bridge,
          // 延时复检要拿它跟稍后的 DOM 比（CAP-AF-055）。
          writtenValue: attempted.value.expected,
          // The bridge request was synchronously emitted while authority was
          // active. After release, await its bounded terminal response before
          // C6 reads whether either L2 or L3 actually held the host value.
          verification: verifyAfterMainWorldBridge(
            attempted.value.bridge,
            {
              expected: attempted.value.expected,
              previous,
              readCurrent: () => readValue(element),
              exact: entry.kind === 'richtext',
              tel: isTelReadback(entry),
              currentIsValid: entry.kind === 'richtext'
                ? () => isCurrentPlainTextContenteditableAttestation({
                    attestation: entry.plainTextContenteditableAttestation,
                    root,
                    element: entry.element,
                    purpose: 'fill',
                  }) && hasPlainTextOnlyStructure(entry.element)
                : undefined,
            },
            signal,
          ),
        });
        // 值已经在网页上了，回读确认排在整轮写完之后。
        announceLive(input.onFieldWritten, index);

        // Host handlers can synchronously add/remove/re-scope controls during
        // our input/change events. MutationObserver delivers only after this
        // call stack yields, so explicitly yield before considering the next
        // field under the old reviewed scan.
        await deliverHostMutations();

        // 分段日期（2026-09-24）：这一段的值此刻已经渲染进组件（React 的更新在微任务里、先于上面那个宿主
        // 任务落地），现在才让焦点「离开」这个日期组，组件拿刚渲染的整个日期提交进表单、跑离开校验。
        // 每一段各提交一次：月份那一次会让 Workday 短暂报一下 Invalid Date，紧接着年份那一次就把它清掉；
        // 只提交最后一段的话，最后一段因为别的原因没写成时，前一段就只停在显示里。
        if (isDateSegmentEntry(entry) && !signal?.aborted && commitDateSegment(entry.element, writeAuthority)) {
          await deliverHostMutations();
        }

        // A host input/change handler can synchronously start submission. Do
        // not reach the next field even though the current ticket still needs
        // the asynchronous C6 verdict.
        if (hostSubmission.submitted()) {
          abortedBy = 'HOST_SUBMITTED';
          markHostSubmissionAfterMutationCheckpoint(plan, results, index + 1, root);
          break;
        }
        if (!policyStillEnabled()) {
          markResultsFrom(plan, results, index + 1, 'POLICY_DISABLED');
          break;
        }
        if (!scanStillCurrent()) {
          markResultsFrom(plan, results, index + 1, 'ABORTED');
          break;
        }
        if (signal?.aborted) {
          markResultsFrom(plan, results, index + 1, 'ABORTED');
          break;
        }
        if (authorityIsolationError) {
          markResultsFrom(plan, results, index + 1, authorityIsolationError);
          break;
        }
      }
    } finally {
      // 授权可以跨越一次**有界的控件交互**（决策 17），但绝不跨越 C6 的读回帧。
      // 读回只读不写，因此它跑在 releaseAuthority 之后。
      releaseAuthority(writeAuthority);
      authorityReleased = true;
    }

    // The synchronous compensator has already stopped. Only readback and
    // journal finalization run after release; no delayed host setter exists.
    for (const ticket of pendingRichtextCompensations) {
      if (await settledPlainTextContenteditableRestoration(ticket) &&
        hasExactPlainTextContenteditableRestoration(ticket)) journal.abandon(ticket);
    }

    if (hostSubmission.submitted()) {
      abortedBy = 'HOST_SUBMITTED';
      abandonPendingForHostSubmission(pending, results, journal);
      drainLateVerifications = true;
    } else {
      for (const item of pending) {
        // 回读是串行的，一条一条落定——中段屏也就一栏一栏地亮。
        announceSettled();
        const outcome = await waitForVerificationOrSubmission(item, hostSubmission);
        if (outcome.kind === 'submitted' || hostSubmission.submitted()) {
          abortedBy = 'HOST_SUBMITTED';
          abandonPendingForHostSubmission(pending, results, journal);
          drainLateVerifications = true;
          break;
        }

        const { entry, ticket } = item;
        if (outcome.verification === 'aborted') {
          if (!entry.element.isConnected || item.wasUserEdited()) journal.abandon(ticket);
          else preserveUndoForChangedHostValue(journal, ticket, item.previous, entry.element);
          results[item.index] = { key: entry.key, label: entry.label, ok: false, reason: 'ABORTED' };
          continue;
        }
        if (!entry.element.isConnected) {
          // 还原票据绑的是这个旧节点——它已经不在文档里，无论接下来认不认得出接班人，
          // 这张票都还原不了什么。与还原簿对已卸节点的既有处理（abandonedDetached）一致。
          journal.abandon(ticket);
          const successor = remountedSuccessor(entry, root, item.writtenValue);
          if (successor !== null) {
            // 值落在接班节点上：写入成功。宿主收不收仍要问一句，与正常成功路同一口径。
            const hostVerdict = input.readHostValidation
              ? classifyHostValidation(input.readHostValidation(successor))
              : 'unknown';
            results[item.index] = hostVerdict === 'rejected'
              ? { key: entry.key, label: entry.label, ok: false, reason: 'HOST_REJECTED' }
              : { key: entry.key, label: entry.label, ok: true };
            continue;
          }
          results[item.index] = { key: entry.key, label: entry.label, ok: false, reason: 'DETACHED' };
          continue;
        }

        if (outcome.verification === 'ok') {
          // Keep the final raw DOM value, not the profile label. This preserves
          // Undo for normalised text and select options such as "United States" → "us".
          if (item.wasUserEdited()) journal.abandon(ticket);
          else journal.commit(ticket, readValue(entry.element));

          // 回读判决只证明"我们写的值还在"。宿主收不收是另一个问题——
          // 不问就会报「已填 12/12」而页面红着四条错误（CAP-AF-068）。
          // 读 DOM 由调用方注入；不注入则完全维持原行为。
          const hostVerdict = input.readHostValidation
            ? hostVerdictFor(entry, input.readHostValidation)
            : 'unknown';
          results[item.index] = hostVerdict === 'rejected'
            ? { key: entry.key, label: entry.label, ok: false, reason: 'HOST_REJECTED' }
            : { key: entry.key, label: entry.label, ok: true };
          continue;
        }

        if (item.wasUserEdited()) journal.abandon(ticket);
        else preserveUndoForChangedHostValue(journal, ticket, item.previous, entry.element);
        results[item.index] = {
          key: entry.key,
          label: entry.label,
          ok: false,
          reason: verificationFailure(outcome.verification),
        };
      }
    }

    // 回读全部落定；延时复检之前把这一批交出去，中段屏在那 250ms 里不是停着的。
    announceSettled();

    // 延时复检（CAP-AF-055）：普通控件只扫本轮判成功的条目；combobox 还要扫
    // 已经证明语义匹配的 PREFILLED/no-write 条目。其他失败不碰——复检改码会把
    // WRITE_REVERTED / HOST_REJECTED 这些更具体的诊断洗掉。Combobox success
    // remains provisional until this block completes, and an already-filled
    // semantic match must remain stable without ever becoming `filled: 1`.
    if (input.lateRecheckMs !== undefined && input.lateRecheckMs > 0) {
      const sweepable = pending.filter((item) => results[item.index]?.ok === true);
      const semanticSweepable = pendingCombobox.filter((item) => {
        const result = results[item.index];
        return result?.ok === true || (
          item.ticket === null &&
          result?.ok === false &&
          result.reason === 'NOT_EMPTY'
        );
      });
      if (sweepable.length > 0 || semanticSweepable.length > 0 || deferredWidgetRechecks.length > 0) {
        // 刻意仍是 setTimeout：这个窗口等的是宿主自己排下的计时器。页面看不见时宿主的计时器同样被
        // 压到约一秒一次，按墙钟等 250 毫秒会在它们跑之前就读；跟它们走同一只钟，后台里这一下慢到
        // 约一秒（整轮只有这一次），读到的是真话。见 write/hostSchedule.ts。
        const delay = input.lateRecheckDelay
          ?? ((ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms); }));
        const semanticFenceError = currentExecutionError;
        let lateFence = semanticSweepable.length > 0 ? semanticFenceError() : null;
        let delayFailed = false;
        if (lateFence === null && !signal?.aborted) {
          try {
            await delay(input.lateRecheckMs);
          } catch {
            delayFailed = true;
          }
        }
        if (delayFailed) lateFence = 'ABORTED';
        else if (semanticSweepable.length > 0) lateFence ??= semanticFenceError();

        if (!signal?.aborted && !delayFailed) {
          for (const item of sweepable) {
            const entry = plan.entries[item.index];
            const expected = item.writtenValue;
            if (expected === undefined) continue;
            if (writtenValueStillHolds(entry, expected, root) !== false) continue;
            results[item.index] = {
              key: entry.key,
              label: entry.label,
              ok: false,
              reason: 'LATE_REVERTED',
            };
          }
          for (const item of deferredWidgetRechecks) {
            if (results[item.index]?.ok !== true) continue;
            let holds = false;
            try {
              holds = item.stillHolds();
            } catch {
              holds = false;
            }
            if (holds) continue;
            const entry = plan.entries[item.index];
            results[item.index] = { key: entry.key, label: entry.label, ok: false, reason: 'LATE_REVERTED' };
          }
        }
        for (const item of semanticSweepable) {
          const { entry, expectedOptionText, authority, undo, ticket } = item;
          let failureReason: ApplyErrorCode | null = lateFence;
          let hostVerdict: ReturnType<typeof classifyHostValidation> = 'unknown';
          let writtenStateCurrent = undo === null;
          let trustedUserEdit = false;
          if (failureReason === null) {
            let selection: ComboboxSelectionState = 'UNVERIFIABLE';
            try {
              selection = authority.readSelection(entry.element, expectedOptionText);
            } catch {
              selection = 'UNVERIFIABLE';
            }
            failureReason = semanticFenceError();

            if (failureReason === null) {
              try {
                hostVerdict = classifyHostValidation(input.readHostValidation!(entry.element));
              } catch {
                hostVerdict = 'unknown';
              }
              failureReason = semanticFenceError();
            }

            if (failureReason === null && undo === null) {
              // An already-filled entry has no write transaction whose
              // written-state seal can catch semantic drift. Host validation
              // is a callback and may change the selected backing while still
              // returning an accepted-shaped verdict, so make the rule-owned
              // selection read the final callback on this zero-click path.
              try {
                selection = authority.readSelection(entry.element, expectedOptionText);
              } catch {
                selection = 'UNVERIFIABLE';
              }
              failureReason = semanticFenceError();
            } else if (failureReason === null && undo !== null) {
              try {
                trustedUserEdit = undo.wasUserEdited();
              } catch {
                trustedUserEdit = true;
              }
              failureReason = semanticFenceError();
              if (failureReason === null && !trustedUserEdit) {
                try {
                  writtenStateCurrent = undo.isAtWrittenState();
                } catch {
                  writtenStateCurrent = false;
                }
                failureReason = semanticFenceError();
              }
            }
            if (
              failureReason === null &&
              entry.element.isConnected &&
              selection === 'MATCH' &&
              writtenStateCurrent &&
              hostVerdict === 'accepted'
            ) continue;
            failureReason ??= trustedUserEdit
              ? 'ABORTED'
              : hostVerdict === 'rejected'
                ? 'HOST_REJECTED'
                : 'LATE_REVERTED';
          }

          results[item.index] = {
            key: entry.key,
            label: entry.label,
            ok: false,
            reason: failureReason ?? 'LATE_REVERTED',
          };
          if (failureReason === 'HOST_SUBMITTED') {
            abortedBy = 'HOST_SUBMITTED';
            continue;
          }
          if (ticket === null || undo === null) continue;
          const compensation = compensateOrRetainSemanticFailure(journal, ticket, undo);
          if (compensation === 'USER_EDITED') {
            results[item.index] = {
              key: entry.key,
              label: entry.label,
              ok: false,
              reason: 'ABORTED',
            };
          } else if (compensation === 'RETAINED' || compensation === 'LOST') {
            results[item.index] = {
              key: entry.key,
              label: entry.label,
              ok: false,
              reason: 'IDENTITY_CHANGED',
            };
            // 整轮已经写完，这里没有可连坐的后续；保留它是为了照实说「我们点过的一栏停在了
            // 说不清的状态上」——与上面受控下拉那一段同一个理由，不是写前漂移。
            abortedBy ??= 'IDENTITY_CHANGED';
          }
        }
      }
    }

    // A submit that lands after the final verification but before listener
    // teardown still makes the reviewed preview stale, even though all fields
    // already have a verified result and remain undoable.
    if (hostSubmission.submitted()) abortedBy = 'HOST_SUBMITTED';
    // 整轮之后的复核清单（见 `ApplyRunSummary.recheck`）。只留「怎么再读一次」这件事，
    // 写入期望值随闭包留在这里，不进任何会被序列化的形状。
    const recheckable: Array<{ index: number; holds: () => boolean | null }> = [];
    for (const item of pending) {
      const expected = item.writtenValue;
      if (expected === undefined) continue;
      const entry = plan.entries[item.index]!;
      recheckable.push({ index: item.index, holds: () => writtenValueStillHolds(entry, expected, root) });
    }
    for (const item of pendingCombobox) {
      const { entry, authority, expectedOptionText } = item;
      recheckable.push({
        index: item.index,
        holds: () => {
          // 语义控件问规则自己的读取口，不去猜 DOM 值；读不到就是读不到。
          if (!entry.element.isConnected) return null;
          try {
            return authority.readSelection(entry.element, expectedOptionText) === 'MATCH';
          } catch {
            return null;
          }
        },
      });
    }
    // 下拉部件（listbox / typeahead / 分层菜单）交出来的那一问，2026-09-24 起也进整轮之后的复核。从前它只在
    // 收尾那一次延时复检里问：Lever 的「Current location」在简历解析回写之后被清空，面板却一直说「已填」。
    // 问的仍是部件自己那一句「页面上是不是还是我们选的那一项」；节点不在了是读不到，不是值没了。
    for (const item of deferredWidgetRechecks) {
      const entry = plan.entries[item.index]!;
      recheckable.push({
        index: item.index,
        holds: () => {
          if (!entry.element.isConnected) return null;
          try {
            return item.stillHolds();
          } catch {
            return null;
          }
        },
      });
    }
    return summarizeRun(plan, results, abortedBy, identityDrift, labelHintDrifted, recheckable);
  } finally {
    if (!authorityReleased) releaseAuthority(writeAuthority);
    for (const item of pending) {
      item.stopWatchingUserEdits();
      item.bridge?.abort();
    }
    submission?.stop();
    // 最后一次：延时复检的改判在这里出去，广播过的最后一条与 summary 逐条一致。
    announceSettled();
    if (drainLateVerifications) {
      // A page may be unloading while rAF is suspended. Own late promise
      // rejections without awaiting the one-second C6 watchdog after the host
      // has already begun submitting; these promises have no write side effect.
      void Promise.allSettled(pending.map((item) => item.verification));
    }
  }
}
