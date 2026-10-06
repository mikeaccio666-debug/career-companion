import type { AutofillAffordance } from '../product-panel/affordance';
import type { DockRunOutcome, DockRunStep } from './dock/types';

/**
 * 申请页上的 ArgoLand.AI 浮层（2026-09-23 按设计交接 `ArgoAI Autofill.dc.html` 重做）。
 *
 * 这个文件只是出口：浮层本身在 `lib/dock/`。两个内容脚本、进度映射与测试都从这里取，
 * 所以内部怎么拆都不牵动调用方。
 *
 * 铁律照旧：浮层是关着的 shadow root 里我们自己的一棵树，宿主页上只多我们一个宿主节点；
 * 每一颗按钮只认 `isTrusted`；页面派发的点击什么都决定不了。
 */

export { mountDock as mountAutofillDock, affordanceFaceKey } from './dock/dock';
export type {
  AutofillDockEntry,
  AutofillDockFace,
  AutofillDockFieldRow,
  AutofillDockHandle,
  AutofillDockHandlers,
  AutofillDockJob,
  AutofillDockProgress,
  DockAccount,
  DockAccountHandlers,
  DockAccountPrompt,
  DockAccountSettings,
  DockAccountStatus,
  DockAccountWall,
  DockAdvanceOutcome,
  DockAiAnswersState,
  DockAiGenerateOutcome,
  DockAiQuota,
  DockAiSwitch,
  DockAiTools,
  DockAnswerOutcome,
  DockAnswers,
  DockQuestion,
  DockAuditHandle,
  DockAuditHandlers,
  DockBlockedAction,
  DockCodeHandlers,
  DockCodeOutcome,
  DockCodePrompt,
  DockMailHint,
  DockChainState,
  DockChainStop,
  DockJobCard,
  DockJobFacts,
  DockJobHighlight,
  DockJobSalary,
  DockNextStepHandlers,
  DockPortalPage,
  DockRetireReason,
  DockRowState,
  DockRunOutcome,
  DockRunState,
  DockRunStep,
  DockScene,
  DockSubmitHandlers,
  DockSubmitOutcome,
} from './dock/types';

/**
 * 两张白名单，钉在 `AutofillAffordance` 上，不是手抄的字面量。
 *
 * 这里是收的那一侧：后台算出那张脸，过一次 `sendMessage` 才到这儿，认不出的一律返回 null。
 * 危险的是**只往发的那一侧加**：决策层加一个 reason 不用动这里就能编译过，于是新那张脸在
 * 生产上永远返回 null，而 null 的意思是一声不吭地不挂浮层。`satisfies Record<…, true>` 让漏抄
 * 变成编译错误（2026-09-18 `RULES_UNAVAILABLE` 就是这么丢的）。
 */
type DockGuidance = Extract<AutofillAffordance, { kind: 'GUIDANCE' }>['guidance'];
type DockUnavailableReason = Extract<AutofillAffordance, { kind: 'UNAVAILABLE' }>['reason'];
const GUIDANCE_ALLOWED = {
  SIGN_IN_FIRST: true, NO_FORM_FOUND: true,
} as const satisfies Record<DockGuidance, true>;
const REASON_ALLOWED = {
  PORTAL_UNLINKED: true, NO_MISSION: true, RULES_UNAVAILABLE: true, VENDOR_CLOSED: true,
} as const satisfies Record<DockUnavailableReason, true>;
const isGuidance = (value: unknown): value is DockGuidance =>
  typeof value === 'string' && Object.hasOwn(GUIDANCE_ALLOWED, value);
const isUnavailableReason = (value: unknown): value is DockUnavailableReason =>
  typeof value === 'string' && Object.hasOwn(REASON_ALLOWED, value);

/**
 * 后台对这一页的回答，HIDDEN 也算——它是「这一页什么都不挂」的结论。null 只留给「没答上来」与认不出的形状。
 *
 * 要不要重问（`nextFaceRetryDelayMs`）看的是这一个，不是下面那个「能不能挂浮层」：那里 HIDDEN 与「没答上来」
 * 都是 null，普通网页上每次导航白白重问三次、worker 一直醒到约 54 秒（2026-10-03 全网注入实测）。
 */
export function parseDockFaceReply(reply: unknown): AutofillAffordance | null {
  if (reply === null || typeof reply !== 'object') return null;
  const dock = (reply as { dock?: unknown }).dock;
  if (dock === null || typeof dock !== 'object') return null;
  const keys = Object.keys(dock).sort();
  const { kind } = dock as { kind?: unknown };
  if (kind === 'HIDDEN' && keys.length === 1) return { kind: 'HIDDEN' };
  if (kind === 'READY' && keys.length === 1) return { kind: 'READY' };
  if (kind === 'DORMANT' && keys.length === 1) return { kind: 'DORMANT' };
  if (kind === 'GUIDANCE' && keys.join() === 'guidance,kind') {
    const { guidance } = dock as { guidance?: unknown };
    return isGuidance(guidance) ? { kind: 'GUIDANCE', guidance } : null;
  }
  if (kind === 'UNAVAILABLE' && keys.join() === 'kind,reason') {
    const { reason } = dock as { reason?: unknown };
    return isUnavailableReason(reason) ? { kind: 'UNAVAILABLE', reason } : null;
  }
  return null;
}

/**
 * The face the background says this page may show, or null.
 *
 * The reply is an untrusted boundary like any other: an unrecognised face mounts
 * nothing rather than something we cannot name, and HIDDEN is never an
 * instruction to appear.
 */
export function parseAutofillDockInstruction(reply: unknown): AutofillAffordance | null {
  const face = parseDockFaceReply(reply);
  return face === null || face.kind === 'HIDDEN' ? null : face;
}

/** The worker's reply to a fill gesture, or null for a shape we cannot name. */
export function parseDockRunReply(reply: unknown): DockRunOutcome | null {
  if (reply === null || typeof reply !== 'object' || Array.isArray(reply)) return null;
  const record = reply as { started?: unknown; code?: unknown; outcome?: unknown };
  if (record.started === false) {
    return typeof record.code === 'string' && /^[A-Z][A-Z0-9_]{1,63}$/u.test(record.code)
      ? { started: false, code: record.code } : { started: false, code: 'RUN_UNAVAILABLE' };
  }
  if (record.started !== true) return null;
  const outcome = record.outcome;
  if (outcome !== 'FILLED' && outcome !== 'STOPPED' && outcome !== 'NEEDS_USER_INPUT' && outcome !== 'TIMED_OUT') return null;
  const code = typeof record.code === 'string' && /^[A-Z][A-Z0-9_]{1,63}$/u.test(record.code) ? record.code : undefined;
  return code === undefined ? { started: true, outcome } : { started: true, outcome, code };
}

/** The worker's step report, or null for a shape we cannot name. */
export function parseDockRunStep(message: unknown): DockRunStep | null {
  if (message === null || typeof message !== 'object' || Array.isArray(message)) return null;
  const record = message as { kind?: unknown; step?: unknown };
  if (record.kind !== 'dock/run-progress') return null;
  const step = record.step;
  return step === 'VERIFYING_INTENT' || step === 'SCANNING' || step === 'PLANNING' || step === 'FILLING' || step === 'VERIFYING' || step === 'DONE'
    ? step : null;
}
