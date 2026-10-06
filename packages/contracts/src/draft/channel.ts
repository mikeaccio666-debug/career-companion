/**
 * ⚠️ DRAFT ⚠️ chat↔扩展通道协议（T10；全案唯一没有现成轮子的部分）。
 *
 * 通道跑在用户浏览器内部（web 页 ↔ 扩展），不经后端——它运送的是
 * **任务引用、进度与回执摘要**。凭证（JWS/lease）绝不经过本通道：
 * 由扩展在隔离环境向后端自领（契约 §4.1）；正式投递回执也不走这里，
 * 由扩展直报后端 §5.7，chat 从后端 API 读——本通道的 run/receipt
 * 只是**填写摘要**（见 RunReceiptSummary 注释）。
 *
 * 三条设计规矩：
 *  1. **信封带版本号**：新旧版本的 chat 与扩展会长期共存（商店审核 28 天），
 *     只接受明确支持的版本集合，认不得 fail-closed 拒收，绝不猜。
 *  2. **Data-L1 纪律**：通道消息只携带 key、状态与稳定原因码——字段值、
 *     标签文案、页面内容一律不进通道（进度播报"正在填 3/9"靠计数）。
 *  3. **稳定码闭集**：本文件导出每一个闭集常量（RUN_STEPS /
 *     NEEDS_USER_INPUT_KINDS / CHANNEL_ERROR_CODES / RECEIPT_REASON_CODES /
 *     SUBMISSION_STATES / CHANNEL_CONNECTION_STATES），解析器逐一验证
 *     运行时成员资格；含未知码的帧**整帧拒收**（不折叠、不猜、不透传）——
 *     UI 永远只需要穷举这些常量（PR #4 评审 Blocking 3 / 高3）。
 *
 * 运行时锁死（PR #4 评审 Blocking 2 / 高1）：逐 kind **精确键白名单**
 * （多一个键整帧拒收）+ 全消息**递归凭证/值类键拒收**——类型上的
 * `value?: never` 只是编译期绊线，真正的边界在 parseChannelMessage。
 *
 * NEEDS_USER_INPUT 的收口状态机（PR #4 评审 Blocking 1 终版）：
 *  - **IN_PAGE_ACTION 不收口**：当前 stable runtime 把所有尚无 positive authority 的动作留在页面上、
 *    与填写摘要并存（"我们填完了能填的，这几处你本人在页面完成"），run 正常走到
 *    DONE + 填写摘要，两张卡不矛盾；
 *  - **CHAT_ANSWER / SENSITIVE_CONFIRM 必收口**：这两类需要 chat 侧
 *    交互喂给**下一次** run——本次 run 不再进入 DONE/receipt，以闭集码
 *    `USER_ACTION_REQUIRED` 停止（协调器状态机保证，特征测试锁死）；
 *    已发生的写入照实直报后端 §5.7。
 *  - 答案属于字段值，**永不经本通道**：chat 把答案/确认写进后端材料面
 *    （关联 `inputRequestId`），后端并入下一次 Intent 签发的批准计划，
 *    扩展重走 issue→claim 执行新 run。T2 用 inputRequestId 把问题卡、
 *    回答与下一次 run 串起来。端点归属 = 后端对齐清单第⑥项。
 */

import {
  EXECUTION_RUNTIME_ACTIVE_VENDORS,
  type ExecutionRuntimeActiveVendor,
} from '../executionRuntime.ts';
import {
  APPLICATION_PROFILE_FIELD_KEYS,
  type ApplicationProfileFieldKey,
} from '../executionIntent.ts';
import { parseUuid } from '../common.ts';

export const CHANNEL_PROTOCOL_VERSION = 1;
/** 只接受明确支持的版本；比最大值新 → 提示升级，其余未知 → 畸形。 */
const ACCEPTED_VERSIONS: ReadonlySet<number> = new Set([1]);

/**
 * NEEDS_USER_INPUT 的三类语义（C-b/C-f 终裁版，源契约 b2e589b1）：
 *  - IN_PAGE_ACTION：当前 runtime 的密码／验证码／2FA／EEO／法律勾选——引导用户在页面上完成，
 *    值绝不经通道与 Chat。pending L2-P 只覆盖本地凭据密码、背景调查、仲裁与信用／药检授权，
 *    正式批准后也必须由独立 durable per-item release + local secret path 消费，不能复用本通道；
 *    验证码／2FA／CAPTCHA、营销订阅、联系现任雇主及未列明／混合授权始终人工；
 *  - CHAT_ANSWER：开放式申请问题——答案经后端材料面进入下一次签发（文件头
 *    注释的链路），不经本通道；
 *  - SENSITIVE_CONFIRM：敏感属性（C-b 终裁「存储+提示」）——确认卡**只展示
 *    存储的提示值并记录"已读"**。它不是 pending sensitive proposal 的 release wire，不能携带
 *    password、backend confirmation/digest、credential ref 或 write authority；当前 stable producer/consumer
 *    仍不据此写入任何字段。
 */
export const NEEDS_USER_INPUT_KINDS = ['IN_PAGE_ACTION', 'CHAT_ANSWER', 'SENSITIVE_CONFIRM'] as const;
export type NeedsUserInputKind = (typeof NEEDS_USER_INPUT_KINDS)[number];

/** 运行阶段（进度卡片"正在填 3/9"的数据源）。 */
export const RUN_STEPS = ['VERIFYING_INTENT', 'SCANNING', 'PLANNING', 'FILLING', 'VERIFYING', 'DONE'] as const;
export type RunStep = (typeof RUN_STEPS)[number];

/**
 * 字段结果原因码闭集 = apply-kernel `APPLY_ERROR_CODES` 的通道镜像。
 * 依赖方向（kernel→contracts）不允许 import，故字面复制；
 * apply-kernel/tests/apply-channel-reason-parity.test.ts 锁双向一致。
 */
export const RECEIPT_REASON_CODES = [
  'CLICK_DENIED', 'HONEYPOT', 'OTHER_PERSON', 'JOB_DEPENDENT', 'HOST_UNCONFIRMED',
  // 当前 stable runtime 的 fail-closed 合并原因码：已有 conditional 乙档字段（如 EEO、
  // work authorization 与信息属实）、default-off pending proposal 的密码／四类窄授权，
  // 以及验证码、2FA、人机验证、营销订阅、联系现任雇主、未列明／混合授权等始终人工类别。
  // 本 stable wire 不承载 pending proposal 的 release 或 secret；各类当前均保持零写入。
  // 对后端当前语义 = NEEDS_USER_INPUT outcome（后端用的是另一套词汇表，见 §5.7）。
  'MANUAL_ONLY',
  // 乙档：已按档案值预填，等用户放行。与 MANUAL_ONLY 的下一步动作相反。
  // 产出它不等于已经写入：没有那次确认就保持零写入。
  'PREFILLED_NEEDS_CONFIRMATION',
  'CHOICE_NO_DATA', 'NO_VALUE',
  // 用户主动关掉的一类：静默跳过、不进必填分母。与 NO_VALUE 的下一步动作相反。
  'SENSITIVE_OPT_OUT',
  'UNSUPPORTED_CONTROL', 'LOW_CONFIDENCE',
  // 这题只有用户能答（作文 / 开放题、与这家公司的历史）：不是我们没认出来，下一步在用户手上。
  'USER_ONLY',
  'NOT_EMPTY',
  'NO_OPTION_MATCH', 'AMBIGUOUS_OPTION', 'OPTIONS_INCOMPLETE', 'WRITE_REVERTED', 'VALUE_COERCED',
  'VERIFY_TIMEOUT',
  // 值留住了但宿主自己判它无效（aria-invalid / 约束校验 / 关联红字）。
  'HOST_REJECTED',
  // 身份没变但此刻写不进去（disabled / 无可见触发器）。不是页面级信号。
  'TARGET_NOT_WRITABLE',
  // 同节同键重复控件里落选的那个；信息已由孪生条目写入。
  'DUPLICATE_FIELD',
  // 写入当时对，稍后被宿主改回或覆盖（受控框架重渲染 / 上传后解析回填）。
  'LATE_REVERTED',
  'WIDGET_TIMEOUT', 'DETACHED', 'IDENTITY_CHANGED', 'HOST_SUBMITTED',
  'ABORTED', 'GESTURE_UNTRUSTED', 'GESTURE_FOREIGN', 'GESTURE_EXPIRED', 'GRANT_CONSUMED',
  'LEASE_INVALID', 'LEASE_EXPIRED', 'PLAN_STALE', 'POLICY_DISABLED', 'JOURNAL_UNAVAILABLE',
  'CAPABILITY_DISABLED', 'STORAGE_UNAVAILABLE', 'SCHEMA_TOO_NEW',
] as const;
export type ReceiptReasonCode = (typeof RECEIPT_REASON_CODES)[number];
const RECEIPT_REASONS: ReadonlySet<string> = new Set(RECEIPT_REASON_CODES);

/**
 * 提交状态闭集。本通道是填写摘要：档位 L1 停在提交前，v1 只有
 * NOT_SUBMITTED——"已投递/提交失败"属于正式回执语义，只能来自后端
 * receipt API（供应商证据才能标 SUBMISSION_CONFIRMED，§5.7）。
 * L2+ 的通道侧提交播报届时扩集，UI 现在就按闭集穷举。
 */
export const SUBMISSION_STATES = ['NOT_SUBMITTED'] as const;
export type SubmissionState = (typeof SUBMISSION_STATES)[number];

/** 连接状态闭集（chat 侧 ChannelClient 的 onConnectionState 消费面）。 */
export const CHANNEL_CONNECTION_STATES = ['CONNECTED', 'LOST'] as const;
export type ChannelConnectionState = (typeof CHANNEL_CONNECTION_STATES)[number];

/**
 * Portal 与 unpacked Extension 建立连接后必须先完成的能力握手。
 *
 * `v` 只说明双方理解同一条通道协议；它不能证明当前 Extension binary
 * 真的包含某项能力，也不能证明 Extension 登录态属于当前 Portal user。
 * 因此 discovery 在收到同 request 的 READY ACK 之前始终保持零执行。
 */
export const CHANNEL_CAPABILITIES = [
  'DISCOVERY_V1',
  // 2026-09-24（argoland 权威，本仓镜像，additive）：扩展自己的浮层填写已验证的申请页、
  // 自己向后端报回执与提交。门户看到它（而没有 GUIDED_AUTOFILL_V1）就把岗位开在新标签页，
  // 不再经通道发 form/prepare、run/start。
  'DOCK_AUTOFILL_V1',
  // 门户的引导式填写词汇。本仓**认得这两个词**（好解析门户的 hello），但不支持它们：
  // 回 READY 时只报下面 EXTENSION_SUPPORTED_CHANNEL_CAPABILITIES 那一份。
  'FORM_PLAN_V1',
  'GUIDED_AUTOFILL_V1',
] as const;
export type ChannelCapability = (typeof CHANNEL_CAPABILITIES)[number];

/**
 * 本扩展**支持**的能力（2026-09-24）：握手的 READY 回答只报这一份，与请求点名了什么无关——
 * 门户据此选引导式还是浮层式填写。与上面的词汇表分开：认得一个词不等于会做那件事。
 */
export const EXTENSION_SUPPORTED_CHANNEL_CAPABILITIES = [
  'DISCOVERY_V1',
  'DOCK_AUTOFILL_V1',
] as const satisfies readonly ChannelCapability[];

/**
 * 能力清单是协商用的词汇，不是闭集（2026-09-24，argoland 权威）。
 *
 * `channel/hello.requiredCapabilities` 与 `channel/ready.capabilities` 收任何形状合法的词
 * （升序、去重、至多这么多个）；本版本不认得的词从解析结果里丢掉，代码看到的永远只是
 * `ChannelCapability`。从前门户多学一个词，每一个旧扩展都会静默丢掉它的 hello，门户干等到超时。
 */
export const CHANNEL_CAPABILITY_LIST_MAX = 16;
const CHANNEL_CAPABILITY_TOKEN = /^[A-Z][A-Z0-9_]{0,63}$/;

/** Extension 对当前 Portal owner/install authority 的闭集判断。 */
export const EXTENSION_CONNECTION_READINESS_STATES = [
  'READY',
  'UNAUTHENTICATED',
  'OWNER_MISMATCH',
  'INSTALL_UNLINKED',
  'AUTHORITY_UNAVAILABLE',
] as const;
export type ExtensionConnectionReadinessState =
  (typeof EXTENSION_CONNECTION_READINESS_STATES)[number];

/** Read-only discovery never falls back from one unavailable authority to another. */
export const DISCOVERY_UNAVAILABLE_CODES = [
  'TARGET_UNAVAILABLE',
  'RUNTIME_UNAVAILABLE',
  'TAB_UNAVAILABLE',
  'SCAN_UNAVAILABLE',
] as const;
export type DiscoveryUnavailableCode = (typeof DISCOVERY_UNAVAILABLE_CODES)[number];

/** 写入来源的闭集。缺省 = 用户档案，本仓一直以来的唯一来源。 */
export const RECEIPT_OUTCOME_SOURCES = ['REMEMBERED_ANSWER'] as const;
export type ReceiptOutcomeSource = (typeof RECEIPT_OUTCOME_SOURCES)[number];

/** 回执里的单字段结果：key + 结果 + 原因码。绝无字段值（Data-L1 绊线同 Intent）。 */
export interface ReceiptFieldOutcome {
  readonly key: string;
  readonly ok: boolean;
  /** 失败或跳过时的稳定原因码（闭集 RECEIPT_REASON_CODES）。 */
  readonly reason?: ReceiptReasonCode;
  /**
   * 这一条不是从档案填的时候，它是从哪来的（闭集）。审计面板靠它显示
   * 「用了你记住的答案」——而不是让用户自己从 key 的前缀猜。
   */
  readonly source?: ReceiptOutcomeSource;
  readonly value?: never;
  readonly label?: never;
}

/**
 * 填写摘要（上行给 chat 展示）。**不是投递回执**：正式回执由扩展直报
 * 后端 §5.7、chat 从后端读；这里只够渲染"填了多少、每个 key 什么结果、
 * 是否停在提交前"。
 */
export interface RunReceiptSummary {
  readonly runId: string;
  readonly jobId: string;
  readonly missionId: string;
  readonly missionStepId: string;
  readonly filled: number;
  readonly total: number;
  readonly outcomes: readonly ReceiptFieldOutcome[];
  /** 闭集 SUBMISSION_STATES；档位 L1 恒为 NOT_SUBMITTED。 */
  readonly submission: SubmissionState;
  /** Unix 秒。 */
  readonly finishedAt: number;
}

export const CHANNEL_ERROR_CODES = [
  'CHANNEL_MALFORMED', // 信封结构不对 / 白名单外的键 / 闭集外的码
  'CHANNEL_VERSION_TOO_NEW', // 对端比我新——fail-closed，提示升级而不是猜
  'INTENT_REJECTED', // 验签失败 / 载荷校验失败 / 已被 claim / 过期
  'RESCAN_MISMATCH', // 重扫与批准字段清单不一致——立即停（授权链第 2 段）
  'RUN_ABORTED', // 用户点停 / SW 断连 fail-closed / 页面导航
  'USER_ACTION_REQUIRED', // CHAT_ANSWER/SENSITIVE_CONFIRM 收口：等 chat 侧交互，回答后开新 run
] as const;
export type ChannelErrorCode = (typeof CHANNEL_ERROR_CODES)[number];

/**
 * chat → 扩展。
 *
 * 第三刀重构（§4.1）：网页通道**只传任务引用，绝不传凭证**——JWS 由扩展
 * 在隔离环境里向后端自领（issue → 本地验签 → claim）。原 `intent/deliver`
 * 已废除：让 web 页经手凭证 = 给页面脚本多一分窥探面。
 */
export type ChannelCommand =
  | {
      readonly v: typeof CHANNEL_PROTOCOL_VERSION;
      readonly kind: 'channel/hello';
      readonly clientRequestId: string;
      /** 当前正常 Portal session 的 canonical owner UUID。 */
      readonly expectedOwnerId: string;
      /** 本次操作所需能力；握手只证明闭集成员，不协商降级。 */
      readonly requiredCapabilities: readonly ChannelCapability[];
    }
  | {
      readonly v: typeof CHANNEL_PROTOCOL_VERSION;
      readonly kind: 'run/start';
      /** chat 生成的请求关联号：run/accepted 用它把权威 runId 对回卡片。 */
      readonly clientRequestId: string;
      readonly missionId: string;
      readonly missionStepId: string;
      /** 签发端点（§5.4）必填的乐观并发号——任务引用的一部分，非凭证。 */
      readonly missionRevision: string;
    }
  | {
      readonly v: typeof CHANNEL_PROTOCOL_VERSION;
      readonly kind: 'discovery/start';
      readonly clientRequestId: string;
      readonly missionId: string;
      readonly missionRevision: string;
    }
  | { readonly v: typeof CHANNEL_PROTOCOL_VERSION; readonly kind: 'run/stop'; readonly runId: string }
  | { readonly v: typeof CHANNEL_PROTOCOL_VERSION; readonly kind: 'channel/ping'; readonly seq: number };

/**
 * 心跳（第四刀）：chat 侧周期发 ping，扩展侧回 pong。双重用途——
 * ①保活 MV3 service worker（空闲 30s 会被杀，长流程填写期间不能断）；
 * ②探活：超时收不到 pong = 扩展失联（ChannelClient 折算为闭集
 *   ChannelConnectionState），扩展侧同时由 port onDisconnect 触发
 *   fail-closed（绝不半途提交）。
 */
export interface ChannelPong {
  readonly v: typeof CHANNEL_PROTOCOL_VERSION;
  readonly kind: 'channel/pong';
  readonly seq: number;
}

/** 扩展 → chat。 */
export type ChannelEvent =
  | {
      readonly v: typeof CHANNEL_PROTOCOL_VERSION;
      readonly kind: 'channel/ready';
      readonly clientRequestId: string;
      /** Chrome manifest version；与通道协议版本分离。 */
      readonly extensionVersion: string;
      readonly capabilities: readonly ChannelCapability[];
      readonly state: ExtensionConnectionReadinessState;
    }
  | {
      readonly v: typeof CHANNEL_PROTOCOL_VERSION;
      /** run/start 的接收确认：卡片立即拿到权威 runId，不再有归属空窗。 */
      readonly kind: 'run/accepted';
      readonly clientRequestId: string;
      readonly runId: string;
      readonly missionId: string;
      readonly missionStepId: string;
    }
  | {
      readonly v: typeof CHANNEL_PROTOCOL_VERSION;
      readonly kind: 'run/progress';
      readonly runId: string;
      readonly jobId: string;
      readonly step: RunStep;
      readonly filled: number;
      readonly total: number;
    }
  | {
      readonly v: typeof CHANNEL_PROTOCOL_VERSION;
      readonly kind: 'run/needs-user-input';
      readonly runId: string;
      /** 稳定关联号：T2 用它串起问题卡 ↔ 后端材料面回答 ↔ 下一次 run。 */
      readonly inputRequestId: string;
      readonly inputKind: NeedsUserInputKind;
      /** CHAT_ANSWER / SENSITIVE_CONFIRM 时给字段 key；IN_PAGE_ACTION 不携带任何定位信息。 */
      readonly fieldKey?: string;
    }
  | {
      readonly v: typeof CHANNEL_PROTOCOL_VERSION;
      readonly kind: 'run/receipt';
      readonly runId: string;
      readonly receipt: RunReceiptSummary;
    }
  | {
      readonly v: typeof CHANNEL_PROTOCOL_VERSION;
      readonly kind: 'run/stopped';
      readonly runId: string;
      readonly code: ChannelErrorCode;
    }
  | {
      readonly v: typeof CHANNEL_PROTOCOL_VERSION;
      readonly kind: 'discovery/result';
      readonly clientRequestId: string;
      readonly missionId: string;
      readonly missionRevision: string;
      readonly status: 'AVAILABLE';
      /** Server-verified canonical HTTPS origin. */
      readonly canonicalOrigin: string;
      /** Pathname from the fresh canonical application target, never inferred from the tab. */
      readonly pathname: string;
      /** Vendor resolved from the verified backend runtime mapping. */
      readonly vendor: ExecutionRuntimeActiveVendor;
      /** Canonical server freshness fence copied from the final target revalidation. */
      readonly freshUntil: string;
      /** Stable application-profile keys only; no labels, selectors, values, or DOM. */
      readonly fieldKeys: readonly ApplicationProfileFieldKey[];
    }
  | {
      readonly v: typeof CHANNEL_PROTOCOL_VERSION;
      readonly kind: 'discovery/result';
      readonly clientRequestId: string;
      readonly missionId: string;
      readonly missionRevision: string;
      readonly status: 'UNAVAILABLE';
      readonly code: DiscoveryUnavailableCode;
    };

export type ChannelMessage = ChannelCommand | ChannelEvent | ChannelPong;

export type ChannelParseResult =
  | { readonly ok: true; readonly value: ChannelMessage }
  | { readonly ok: false; readonly code: ChannelErrorCode };

/**
 * 凭证/值类键黑名单：出现在消息**任意深度**即整帧拒收。别名从宽收录
 * ——"绊线漏一个别名"的代价是走私通道，误伤的代价只是改个字段名。
 */
const FORBIDDEN_KEYS: ReadonlySet<string> = new Set([
  'jws', 'jwt', 'token', 'accessToken', 'refreshToken', 'bearer',
  'intent', 'executionIntent', 'lease', 'executionLease',
  'credential', 'credentials', 'password', 'otp', 'cookie', 'cookies',
  'value', 'values', 'label', 'labels', 'answer', 'answers',
  'selector', 'selectors', 'resumeText', 'jobDescription', 'html', 'dom', 'screenshot',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function containsForbiddenKey(value: unknown): boolean {
  if (Array.isArray(value)) return value.some((item) => containsForbiddenKey(item));
  if (!isRecord(value)) return false;
  for (const [key, nested] of Object.entries(value)) {
    if (FORBIDDEN_KEYS.has(key)) return true;
    if (containsForbiddenKey(nested)) return true;
  }
  return false;
}

/** 精确键集合：必填全在场 + 场上没有白名单外的键（多一个都拒）。 */
function hasExactKeys(
  record: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  for (const key of required) if (!(key in record)) return false;
  for (const key of Object.keys(record)) {
    if (!required.includes(key) && !optional.includes(key)) return false;
  }
  return true;
}

const nonEmpty = (value: unknown): value is string => typeof value === 'string' && value !== '';
const isCount = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

const STEP_SET: ReadonlySet<string> = new Set(RUN_STEPS);
const INPUT_KIND_SET: ReadonlySet<string> = new Set(NEEDS_USER_INPUT_KINDS);
const ERROR_CODE_SET: ReadonlySet<string> = new Set(CHANNEL_ERROR_CODES);
const SUBMISSION_SET: ReadonlySet<string> = new Set(SUBMISSION_STATES);
const DISCOVERY_ERROR_SET: ReadonlySet<string> = new Set(DISCOVERY_UNAVAILABLE_CODES);
const DISCOVERY_VENDOR_SET: ReadonlySet<string> = new Set(EXECUTION_RUNTIME_ACTIVE_VENDORS);
const DISCOVERY_FIELD_KEY_SET: ReadonlySet<string> = new Set(APPLICATION_PROFILE_FIELD_KEYS);
const CHANNEL_CAPABILITY_SET: ReadonlySet<string> = new Set(CHANNEL_CAPABILITIES);
const EXTENSION_READINESS_SET: ReadonlySet<string> =
  new Set(EXTENSION_CONNECTION_READINESS_STATES);

function isClientRequestId(value: unknown): value is string {
  return typeof value === 'string' &&
    /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);
}

/**
 * 升序、去重、形状合法的能力词；不认得的词从结果里丢掉。清单本身畸形（空、过长、乱序、重复、
 * 坏词）时为 null。
 */
function parseCapabilityList(value: unknown): readonly ChannelCapability[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > CHANNEL_CAPABILITY_LIST_MAX) {
    return null;
  }
  let previous: string | undefined;
  const known: ChannelCapability[] = [];
  for (const capability of value) {
    if (
      typeof capability !== 'string' ||
      !CHANNEL_CAPABILITY_TOKEN.test(capability) ||
      (previous !== undefined && previous >= capability)
    ) return null;
    previous = capability;
    if (CHANNEL_CAPABILITY_SET.has(capability)) known.push(capability as ChannelCapability);
  }
  return Object.freeze(known);
}

/** Chrome manifest version: one to four canonical uint16 dot components. */
function isManifestVersion(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 47) return false;
  const components = value.split('.');
  return components.length >= 1 &&
    components.length <= 4 &&
    components.every((component) =>
      /^(?:0|[1-9][0-9]{0,4})$/.test(component) && Number(component) <= 65_535);
}

/** Canonical UTC RFC3339 timestamp with millisecond precision. */
function isCanonicalTimestamp(value: unknown): value is string {
  if (typeof value !== 'string' || value.length !== 24) return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function isExactHttpsOrigin(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 512) return false;
  try {
    const parsed = new URL(value);
    return (
      parsed.protocol === 'https:' &&
      parsed.origin === value &&
      parsed.username === '' &&
      parsed.password === '' &&
      parsed.pathname === '/' &&
      parsed.search === '' &&
      parsed.hash === ''
    );
  } catch {
    return false;
  }
}

function isCanonicalPathname(value: unknown, canonicalOrigin: unknown): value is string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 2_048 ||
    value !== value.trim() ||
    !value.startsWith('/') ||
    value.startsWith('//') ||
    value.includes('\\') ||
    value.includes('?') ||
    value.includes('#') ||
    /[\u0000-\u001F\u007F]/.test(value) ||
    /%(?![0-9A-F]{2})/i.test(value) ||
    /%(?:2E|2F|5C|25|00)/i.test(value) ||
    !isExactHttpsOrigin(canonicalOrigin)
  ) return false;
  try {
    const parsed = new URL(value, canonicalOrigin);
    return parsed.origin === canonicalOrigin && parsed.pathname === value && parsed.search === '' && parsed.hash === '';
  } catch {
    return false;
  }
}

function isFieldKeyList(value: unknown): value is readonly ApplicationProfileFieldKey[] {
  if (!Array.isArray(value) || value.length > APPLICATION_PROFILE_FIELD_KEYS.length) return false;
  let previous: string | undefined;
  for (const key of value) {
    if (
      typeof key !== 'string' ||
      !DISCOVERY_FIELD_KEY_SET.has(key) ||
      (previous !== undefined && previous >= key)
    ) return false;
    previous = key;
  }
  return true;
}

function isDiscoveryReference(
  clientRequestId: unknown,
  missionId: unknown,
  missionRevision: unknown,
): boolean {
  return typeof clientRequestId === 'string' &&
    isClientRequestId(clientRequestId) &&
    parseUuid(missionId) !== null &&
    typeof missionRevision === 'string' &&
    missionRevision.length <= 32 &&
    /^[1-9][0-9]*$/.test(missionRevision);
}

const RECEIPT_SOURCES: ReadonlySet<string> = new Set(RECEIPT_OUTCOME_SOURCES);

function isValidOutcome(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (!hasExactKeys(value, ['key', 'ok'], ['reason', 'source'])) return false;
  if (!nonEmpty(value['key']) || typeof value['ok'] !== 'boolean') return false;
  if ('reason' in value && !RECEIPT_REASONS.has(value['reason'] as string)) return false;
  if ('source' in value && !RECEIPT_SOURCES.has(value['source'] as string)) return false;
  return true;
}

function isValidReceipt(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (
    !hasExactKeys(value, [
      'runId', 'jobId', 'missionId', 'missionStepId', 'filled', 'total',
      'outcomes', 'submission', 'finishedAt',
    ])
  ) {
    return false;
  }
  if (!nonEmpty(value['runId']) || typeof value['jobId'] !== 'string') return false;
  if (!nonEmpty(value['missionId']) || !nonEmpty(value['missionStepId'])) return false;
  if (!isCount(value['filled']) || !isCount(value['total']) || !isCount(value['finishedAt'])) {
    return false;
  }
  if ((value['filled'] as number) > (value['total'] as number)) return false;
  if (!SUBMISSION_SET.has(value['submission'] as string)) return false;
  const outcomes = value['outcomes'];
  if (!Array.isArray(outcomes) || !outcomes.every(isValidOutcome)) return false;
  return true;
}

/**
 * 通道入口的 fail-closed 解析：逐 kind 精确键白名单 + 闭集成员验证 +
 * 全消息递归凭证/值类键拒收。任何一条不满足 → 整帧 CHANNEL_MALFORMED，
 * 不折叠、不猜、不部分接受。
 */
export function parseChannelMessage(input: unknown): ChannelParseResult {
  if (!isRecord(input)) return { ok: false, code: 'CHANNEL_MALFORMED' };
  const v = input['v'];
  if (typeof v !== 'number') return { ok: false, code: 'CHANNEL_MALFORMED' };
  if (v > CHANNEL_PROTOCOL_VERSION) return { ok: false, code: 'CHANNEL_VERSION_TOO_NEW' };
  if (!ACCEPTED_VERSIONS.has(v)) return { ok: false, code: 'CHANNEL_MALFORMED' };

  // 黑名单先于白名单：走私优先拒，别让"键数刚好"的帧滑过去。
  if (containsForbiddenKey(input)) return { ok: false, code: 'CHANNEL_MALFORMED' };

  const kind = input['kind'];
  const bad: ChannelParseResult = { ok: false, code: 'CHANNEL_MALFORMED' };
  switch (kind) {
    case 'channel/hello': {
      if (!hasExactKeys(input, [
        'v', 'kind', 'clientRequestId', 'expectedOwnerId', 'requiredCapabilities',
      ])) return bad;
      if (!isClientRequestId(input['clientRequestId'])) return bad;
      if (parseUuid(input['expectedOwnerId']) === null) return bad;
      const requiredCapabilities = parseCapabilityList(input['requiredCapabilities']);
      if (requiredCapabilities === null) return bad;
      return { ok: true, value: { ...input, requiredCapabilities } as unknown as ChannelMessage };
    }
    case 'channel/ready': {
      if (!hasExactKeys(input, [
        'v', 'kind', 'clientRequestId', 'extensionVersion', 'capabilities', 'state',
      ])) return bad;
      if (!isClientRequestId(input['clientRequestId'])) return bad;
      if (!isManifestVersion(input['extensionVersion'])) return bad;
      const capabilities = parseCapabilityList(input['capabilities']);
      if (capabilities === null) return bad;
      if (!EXTENSION_READINESS_SET.has(input['state'] as string)) return bad;
      return { ok: true, value: { ...input, capabilities } as unknown as ChannelMessage };
    }
    case 'run/start': {
      if (!hasExactKeys(input, ['v', 'kind', 'clientRequestId', 'missionId', 'missionStepId', 'missionRevision'])) return bad;
      if (!nonEmpty(input['clientRequestId']) || !nonEmpty(input['missionId'])) return bad;
      if (!nonEmpty(input['missionStepId']) || !nonEmpty(input['missionRevision'])) return bad;
      break;
    }
    case 'discovery/start': {
      if (!hasExactKeys(input, ['v', 'kind', 'clientRequestId', 'missionId', 'missionRevision'])) return bad;
      if (!isDiscoveryReference(input['clientRequestId'], input['missionId'], input['missionRevision'])) return bad;
      break;
    }
    case 'discovery/result': {
      const common = ['v', 'kind', 'clientRequestId', 'missionId', 'missionRevision', 'status'] as const;
      if (!isDiscoveryReference(input['clientRequestId'], input['missionId'], input['missionRevision'])) return bad;
      if (input['status'] === 'AVAILABLE') {
        if (!hasExactKeys(input, [
          ...common, 'canonicalOrigin', 'pathname', 'vendor', 'freshUntil', 'fieldKeys',
        ])) return bad;
        if (!isCanonicalPathname(input['pathname'], input['canonicalOrigin'])) return bad;
        if (!isCanonicalTimestamp(input['freshUntil'])) return bad;
        if (!DISCOVERY_VENDOR_SET.has(input['vendor'] as string) || !isFieldKeyList(input['fieldKeys'])) return bad;
      } else if (input['status'] === 'UNAVAILABLE') {
        if (!hasExactKeys(input, [...common, 'code'])) return bad;
        if (!DISCOVERY_ERROR_SET.has(input['code'] as string)) return bad;
      } else {
        return bad;
      }
      break;
    }
    case 'run/stop': {
      if (!hasExactKeys(input, ['v', 'kind', 'runId']) || !nonEmpty(input['runId'])) return bad;
      break;
    }
    case 'run/accepted': {
      if (!hasExactKeys(input, ['v', 'kind', 'clientRequestId', 'runId', 'missionId', 'missionStepId'])) return bad;
      if (!nonEmpty(input['clientRequestId']) || !nonEmpty(input['runId'])) return bad;
      if (!nonEmpty(input['missionId']) || !nonEmpty(input['missionStepId'])) return bad;
      break;
    }
    case 'run/progress': {
      if (!hasExactKeys(input, ['v', 'kind', 'runId', 'jobId', 'step', 'filled', 'total'])) return bad;
      if (!nonEmpty(input['runId']) || typeof input['jobId'] !== 'string') return bad;
      if (!STEP_SET.has(input['step'] as string)) return bad;
      if (!isCount(input['filled']) || !isCount(input['total'])) return bad;
      if ((input['filled'] as number) > (input['total'] as number)) return bad;
      break;
    }
    case 'run/needs-user-input': {
      if (!hasExactKeys(input, ['v', 'kind', 'runId', 'inputRequestId', 'inputKind'], ['fieldKey'])) return bad;
      if (!nonEmpty(input['runId']) || !nonEmpty(input['inputRequestId'])) return bad;
      if (!INPUT_KIND_SET.has(input['inputKind'] as string)) return bad;
      if ('fieldKey' in input && !nonEmpty(input['fieldKey'])) return bad;
      break;
    }
    case 'run/receipt': {
      if (!hasExactKeys(input, ['v', 'kind', 'runId', 'receipt'])) return bad;
      if (!nonEmpty(input['runId']) || !isValidReceipt(input['receipt'])) return bad;
      break;
    }
    case 'run/stopped': {
      if (!hasExactKeys(input, ['v', 'kind', 'runId', 'code'])) return bad;
      if (!nonEmpty(input['runId']) || !ERROR_CODE_SET.has(input['code'] as string)) return bad;
      break;
    }
    case 'channel/ping':
    case 'channel/pong': {
      if (!hasExactKeys(input, ['v', 'kind', 'seq']) || !isCount(input['seq'])) return bad;
      break;
    }
    default:
      return bad;
  }
  return { ok: true, value: input as unknown as ChannelMessage };
}
