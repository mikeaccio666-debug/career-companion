/**
 * 一轮自动填写怎么收场（2026-10-04，前端体检 11-1：线上答不出「哪家 ATS、哪一页、多少人失败、为什么」）。
 *
 * 一轮 = 内容脚本里的一次 `runGestureFill`：按一下「自动填写」填的那一页，或连填（fill-to-review）翻到的下一页。每一轮收场时
 * 内容脚本交给 worker 一条闭集消息（`dock/run-outcome`），worker 校验后排进上报队列，送到 argoland 的
 * POST /telemetry/client-errors（`kind: "run_outcome"`），落进结构化日志 → Loki，并计入低基数指标。
 *
 * **契约权威在 argoland**（RULE-EXT-CONTRACT-CONSUMER）：`src/observability/extension-run-outcome.ts` 与 docs/API_CONTRACTS.md。
 * 这里的每一张表都是那边的镜像，服务端先加成员、本仓才跟着送；认不出的一律折成 `unknown` / `OTHER`。
 *
 * **只有闭集与分桶**（RULE-GLOBAL-DATA-L1）：没有网址、主机、路径、题目、标签、值、邮箱或任何自由文本；字段数也只给桶——
 * 一张表的确切字段数配上厂商，就可能认出是哪一家雇主的哪一张表。
 */
import type { ApplyVendor } from '@edaix/apply-kernel/contracts';

import type { DockChainStop, DockSubmitOutcome } from './autofillDock';

/** 哪一家 ATS：运行时包能放行的每一家，外加 `unknown`。`generic` 是公司自己做的表。 */
export const RUN_VENDORS = [
  'greenhouse', 'lever', 'ashby', 'workable', 'workday', 'icims', 'smartrecruiters', 'bamboohr',
  'dover', 'jobvite', 'rippling', 'avature', 'generic', 'unknown',
] as const;
export type RunVendor = (typeof RUN_VENDORS)[number];

/** 怎么认出这一家的：它自己的候选人主机、雇主域名上的指纹（白标）、还是谁家都不是（通用路）。 */
export const RUN_LANES = ['host', 'whitelabel', 'generic'] as const;
export type RunLane = (typeof RUN_LANES)[number];

/**
 * 这一轮在它那一页上怎么收场：
 *  · FILLED_ALL：写上了至少一项，没有必填留给他；NEEDS_YOU：写上了，还有必填要他；
 *  · NOTHING_FILLED：跑完了，一项都没写上（原因是第一条拒绝）；FAILED：没能填这一页（必须有原因）；
 *  · STOPPED：他按了「停止」、开了新的一轮、或离开了这一页；
 *  · CHAIN_ADVANCED / CHAIN_STOPPED：连填里的一页——连填从这一页翻到了下一页，或停在了这一页（原因：为什么停）。
 */
export const RUN_OUTCOMES = [
  'FILLED_ALL', 'NEEDS_YOU', 'NOTHING_FILLED', 'FAILED', 'STOPPED', 'CHAIN_ADVANCED', 'CHAIN_STOPPED',
] as const;
export type RunOutcome = (typeof RUN_OUTCOMES)[number];

/** 稳定原因码（分组只是说明）。内部码不在表里的，送 `OTHER`。 */
export const RUN_REASONS = [
  // 没能开始、读不到这一页。
  'WORKER_UNREACHABLE', 'AUTHORITY_UNAVAILABLE', 'RUNTIME_UNRESOLVED', 'PROFILE_UNAVAILABLE', 'LOGIN_REQUIRED',
  'RUN_UNAVAILABLE', 'RUN_FAILED', 'NOTHING_FILLED', 'TIMED_OUT', 'NOT_FOUND', 'NO_MISSION_FOR_PAGE', 'INTENT_REJECTED',
  // 扫描停在哪。
  'NO_FORM_FOUND', 'ROOT_NOT_FOUND', 'APPLY_FORM_NOT_OPENED', 'NO_KEYED_FIELD', 'PATH_NOT_APPLY',
  'RULES_MATCHED_NOTHING', 'NO_AUTHORIZED_FIELD', 'NOT_SEALABLE', 'SCAN_NOT_SEALABLE',
  // 主机与页面否决。
  'EMPLOYER_CONSOLE', 'PUBLIC_SECTOR', 'REMOTE_DENYLIST', 'CHALLENGE_PAGE', 'ANONYMOUS_REPORT', 'CREDENTIAL_PAGE',
  'YIELDED_TO_FRAME', 'NO_VENDOR',
  // 内核的逐栏拒绝与写入失败（ApplyErrorCode）。
  'CLICK_DENIED', 'HONEYPOT', 'OTHER_PERSON', 'JOB_DEPENDENT', 'MANUAL_ONLY', 'PREFILLED_NEEDS_CONFIRMATION',
  'HOST_UNCONFIRMED', 'CHOICE_NO_DATA', 'NO_VALUE', 'SENSITIVE_OPT_OUT', 'LOW_CONFIDENCE', 'USER_ONLY', 'NOT_EMPTY',
  'NO_OPTION_MATCH', 'AMBIGUOUS_OPTION', 'OPTIONS_INCOMPLETE', 'WRITE_REVERTED', 'VALUE_COERCED', 'VERIFY_TIMEOUT',
  'HOST_REJECTED', 'TARGET_NOT_WRITABLE', 'DUPLICATE_FIELD', 'LATE_REVERTED', 'WIDGET_TIMEOUT', 'DETACHED',
  'IDENTITY_CHANGED', 'HOST_SUBMITTED', 'ABORTED', 'GESTURE_UNTRUSTED', 'GESTURE_FOREIGN', 'GESTURE_EXPIRED',
  'GRANT_CONSUMED', 'LEASE_INVALID', 'LEASE_EXPIRED', 'PLAN_STALE', 'POLICY_DISABLED', 'JOURNAL_UNAVAILABLE',
  'CAPABILITY_DISABLED', 'STORAGE_UNAVAILABLE', 'SCHEMA_TOO_NEW',
  // 连填为什么停在这一页（DockChainStop）。
  'REVIEW', 'NEEDS_USER', 'LOGIN', 'VERIFICATION', 'CAPTCHA', 'NOT_ADVANCED', 'UNAVAILABLE', 'UNKNOWN_PAGE',
  'PAGE_CAP', 'TIME_CAP', 'OFF', 'MOVED', 'STOPPED',
  // 不是按「停止」停下的那几种。
  'SUPERSEDED', 'PAGE_LEFT', 'PAGE_CHANGED', 'ADVANCED_EMPTY',
  'OTHER',
] as const;
export type RunReason = (typeof RUN_REASONS)[number];

/** 字段数的桶。 */
export const RUN_COUNT_BUCKETS = ['0', '1', '2', '3', '4-5', '6-10', '11-20', '21-40', '41+'] as const;
export type RunCountBucket = (typeof RUN_COUNT_BUCKETS)[number];

/** 写上的占这一轮列出的百分之几；一项都没列出是 `NONE`（只在 planned 为 0 时）。 */
export const RUN_FILL_RATE_BUCKETS = ['NONE', '0', '1-24', '25-49', '50-74', '75-99', '100'] as const;
export type RunFillRateBucket = (typeof RUN_FILL_RATE_BUCKETS)[number];

/** 从按下去到这一页收场。 */
export const RUN_DURATION_BUCKETS = ['LT_2S', '2_5S', '5_10S', '10_20S', '20_40S', '40_90S', 'GE_90S'] as const;
export type RunDurationBucket = (typeof RUN_DURATION_BUCKETS)[number];

/** 他在浮层里按的「提交」后来怎样：没按、网站确认了、没看到确认（或页面先走了）、网站没收、按不了。 */
export const RUN_SUBMIT_OUTCOMES = ['none', 'confirmed', 'unconfirmed', 'rejected', 'unavailable'] as const;
export type RunSubmitOutcome = (typeof RUN_SUBMIT_OUTCOMES)[number];

/** 连填远到不了这么多页（内核有页数上限）；更多就是坏消息。 */
export const RUN_MAX_CHAIN_PAGES = 30;
const RUN_ID = /^[a-f0-9]{16,32}$/;

export interface RunOutcomeEvent {
  /** 每一轮随机一个：一条丢了答复、重送的上报与第二轮分得开。 */
  readonly runId: string;
  readonly vendor: RunVendor;
  readonly lane: RunLane;
  readonly outcome: RunOutcome;
  readonly reason?: RunReason;
  /** 这一轮列出的栏（浮层上的行）。 */
  readonly planned: RunCountBucket;
  /** 写上的（规则或 AI）。 */
  readonly filled: RunCountBucket;
  /** 留给他的必填。 */
  readonly needsYou: RunCountBucket;
  readonly aiAnswered: RunCountBucket;
  /** 以他的名义代填的条款、声明、签名。 */
  readonly signedOnBehalf: RunCountBucket;
  /** 收场那一刻网页上还空着的必填。 */
  readonly requiredEmptyOnPage: RunCountBucket;
  readonly fillRate: RunFillRateBucket;
  readonly durationBucket: RunDurationBucket;
  /** 这一页在连填里是第几页；不是连填就是 0。 */
  readonly chainPages: number;
  readonly submitOutcome: RunSubmitOutcome;
}

const OUTCOME_SET: ReadonlySet<string> = /* @__PURE__ */ new Set(RUN_OUTCOMES);
const REASON_SET: ReadonlySet<string> = /* @__PURE__ */ new Set(RUN_REASONS);
const VENDOR_SET: ReadonlySet<string> = /* @__PURE__ */ new Set(RUN_VENDORS);

export function countBucket(count: number): RunCountBucket {
  if (!Number.isFinite(count) || count <= 0) return '0';
  if (count < 4) return String(Math.floor(count)) as RunCountBucket;
  return count <= 5 ? '4-5' : count <= 10 ? '6-10' : count <= 20 ? '11-20' : count <= 40 ? '21-40' : '41+';
}

/** 按确切的数算百分比再分桶（比两个桶相除准）。 */
export function fillRateBucket(filled: number, planned: number): RunFillRateBucket {
  if (!(planned > 0)) return 'NONE';
  const percent = Math.min(100, Math.max(0, (filled / planned) * 100));
  if (percent === 0) return '0';
  if (percent >= 100) return '100';
  return percent < 25 ? '1-24' : percent < 50 ? '25-49' : percent < 75 ? '50-74' : '75-99';
}

export function durationBucket(ms: number): RunDurationBucket {
  const seconds = Number.isFinite(ms) ? Math.max(0, ms) / 1000 : 0;
  return seconds < 2 ? 'LT_2S' : seconds < 5 ? '2_5S' : seconds < 10 ? '5_10S' : seconds < 20 ? '10_20S'
    : seconds < 40 ? '20_40S' : seconds < 90 ? '40_90S' : 'GE_90S';
}

export function runVendor(vendor: ApplyVendor | string | null | undefined): RunVendor {
  return typeof vendor === 'string' && VENDOR_SET.has(vendor) ? vendor as RunVendor : 'unknown';
}

/**
 * 内部码 → 闭集原因。带后缀的（`NOT_SEALABLE:ROOT_MUTATED`）取前面那一段；连填的（`CHAIN_CAPTCHA`）取停因本身；
 * 不在表里的一律 `OTHER`——原文从不出内容脚本。
 */
export function runReason(code: string | null | undefined): RunReason {
  if (typeof code !== 'string') return 'OTHER';
  const base = code.split(':', 1)[0] ?? '';
  const stop = base.startsWith('CHAIN_') ? base.slice('CHAIN_'.length) : base;
  return REASON_SET.has(stop) ? stop as RunReason : 'OTHER';
}

export function submitOutcomeOf(outcome: DockSubmitOutcome): RunSubmitOutcome {
  return outcome === 'SUBMITTED' ? 'confirmed'
    : outcome === 'UNCONFIRMED' ? 'unconfirmed'
      : outcome === 'NOT_SUBMITTED' ? 'rejected' : 'unavailable';
}

/** 连填停因 → 原因（DockChainStop 的每一个都在表里）。 */
export function chainStopReason(stop: DockChainStop): RunReason {
  return runReason(stop);
}

/** 32 位小写十六进制。 */
export function newRunId(random: (bytes: Uint8Array) => Uint8Array = (bytes) => crypto.getRandomValues(bytes)): string {
  return Array.from(random(new Uint8Array(16)), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

const NEEDS_REASON: ReadonlySet<string> = /* @__PURE__ */ new Set(['FAILED', 'CHAIN_STOPPED']);
const NO_REASON: ReadonlySet<string> = /* @__PURE__ */ new Set(['FILLED_ALL', 'NEEDS_YOU', 'CHAIN_ADVANCED']);

/** 与服务端同一套跨字段规则（extension-run-outcome.ts 的 extensionRunOutcomeProblem）：不一致的那一条服务端会整批拒收。 */
export function runOutcomeConsistent(event: RunOutcomeEvent): boolean {
  if (NEEDS_REASON.has(event.outcome) && event.reason === undefined) return false;
  if (NO_REASON.has(event.outcome) && event.reason !== undefined) return false;
  if ((event.outcome === 'CHAIN_ADVANCED' || event.outcome === 'CHAIN_STOPPED') && event.chainPages === 0) return false;
  return (event.planned === '0') === (event.fillRate === 'NONE');
}

export const DOCK_RUN_OUTCOME = 'dock/run-outcome' as const;

/**
 * 内容脚本 → worker。`final: false`：这一页还可能在浮层里按「提交」，worker 先拿着（最多半小时），等同一个 runId 的终稿；
 * `final: true`：这就是终稿。这条消息不授予任何东西。
 */
export interface DockRunOutcomeMessage {
  readonly kind: typeof DOCK_RUN_OUTCOME;
  readonly final: boolean;
  readonly event: RunOutcomeEvent;
}

export function createDockRunOutcome(event: RunOutcomeEvent, final: boolean): DockRunOutcomeMessage {
  return Object.freeze({ kind: DOCK_RUN_OUTCOME, final, event });
}

const EVENT_KEYS = [
  'runId', 'vendor', 'lane', 'outcome', 'planned', 'filled', 'needsYou', 'aiAnswered', 'signedOnBehalf',
  'requiredEmptyOnPage', 'fillRate', 'durationBucket', 'chainPages', 'submitOutcome',
] as const;
const COUNT_KEYS = ['planned', 'filled', 'needsYou', 'aiAnswered', 'signedOnBehalf', 'requiredEmptyOnPage'] as const;

const isIn = <T extends string>(list: readonly T[], value: unknown): value is T =>
  typeof value === 'string' && (list as readonly string[]).includes(value);

/** worker 收消息：只认恰好这几个键、每一项都在闭集里、跨字段也一致的那一条；别的一律 null。 */
export function parseDockRunOutcome(value: unknown): Readonly<{ event: RunOutcomeEvent; final: boolean }> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const message = value as Record<string, unknown>;
  if (message.kind !== DOCK_RUN_OUTCOME || typeof message.final !== 'boolean' || Object.keys(message).length !== 3) return null;
  const raw = message.event;
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const event = raw as Record<string, unknown>;
  const keys = Object.keys(event);
  const hasReason = Object.prototype.hasOwnProperty.call(event, 'reason');
  if (keys.length !== EVENT_KEYS.length + (hasReason ? 1 : 0) || !EVENT_KEYS.every((key) => Object.prototype.hasOwnProperty.call(event, key))) {
    return null;
  }
  if (typeof event.runId !== 'string' || !RUN_ID.test(event.runId)) return null;
  if (!isIn(RUN_VENDORS, event.vendor) || !isIn(RUN_LANES, event.lane) || !OUTCOME_SET.has(event.outcome as string)) return null;
  if (hasReason && !REASON_SET.has(event.reason as string)) return null;
  if (!COUNT_KEYS.every((key) => isIn(RUN_COUNT_BUCKETS, event[key]))) return null;
  if (!isIn(RUN_FILL_RATE_BUCKETS, event.fillRate) || !isIn(RUN_DURATION_BUCKETS, event.durationBucket)) return null;
  if (!Number.isSafeInteger(event.chainPages) || (event.chainPages as number) < 0 || (event.chainPages as number) > RUN_MAX_CHAIN_PAGES) return null;
  if (!isIn(RUN_SUBMIT_OUTCOMES, event.submitOutcome)) return null;
  const parsed = Object.freeze({ ...event }) as unknown as RunOutcomeEvent;
  return runOutcomeConsistent(parsed) ? Object.freeze({ event: parsed, final: message.final }) : null;
}
