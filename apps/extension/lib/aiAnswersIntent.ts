import {
  FULL_AI_LANES,
  FULL_AI_LIMITS,
  fullAiRequiresManual,
  parseFullAiRequest,
  parseFullAiReviseRequest,
  type FullAiField,
  type FullAiInstruction,
  type FullAiJob,
  type FullAiLane,
  type FullAiRequest,
} from '@edaix/contracts';
import {
  PILOT_UA5_CONNECTED_PROTOCOL_VERSION,
  createPilotUa5ConnectedPageReady,
} from './pilotUa5ConnectedProtocol';
import { documentPathField, keysBesidesDocumentPath, readDocumentPathname } from './documentPath';

/**
 * AI 代答（2026-09-23 负责人决定）：内容脚本与 worker 之间的那几条消息。
 *
 * 与答案记忆、AI 起草同一条边界：凭据、requestId 与配额都在 worker，内容脚本只说在哪一页、要问哪几道题。
 *  · `PLAN`：规则答不了、页面上还空着的题——题面、选项与旁边的说明文字，题号是不透明的 `f0`…（不带选择器、
 *    不带页面上的现值），另可带岗位描述 `job`（页面 JSON-LD JobPosting 的纯文本，2026-09-24）。它只走
 *    `AI_ANSWERS_STREAM_PORT` 那条长连接（一次「自动填写」一条）：worker 先看本地开关，关着就不发请求；开着才铸
 *    requestId 去打 argoland 的 `plan/stream`，答案一批一批经同一条连接交回（`DockAiStreamMessage`）。
 *  · `SETTINGS_GET` / `SETTINGS_SET`：那个开关（缺省开，按用户存在插件本地）。
 *  · `REPORT`：写成了几项、是不是改成了按钮——只落稳定原因码与个数，不带任何题面或答案。
 *  · `TIMING`（2026-09-24）：这一轮从点击起算的几个时刻（请求发出、响应头、第一批选择题、第一批开放题、每次写入、
 *    流结束），只有毫秒与个数，worker 记成诊断码（`AI_MS_…`，一条放不下就接着下一条）。
 *  · `REVISE`（2026-09-24）：用户在一栏旁的卡片里按「生成」——这一题、这一栏此刻的内容、他写的要求。
 *  · `QUOTA`（2026-09-24）：这个月还能用几次 AI（卡片里那一行）。
 *    这两步是 argoland 的 revise / quota 端点；调用失败（端点没上线时的 404 之类）一律当「暂时用不了」。
 *
 * Data-L1：题面、选项与答案只在内容脚本、worker 与第一方 API 之间走，不进日志、遥测、回执与错误上报。
 */
export type AiAnswersReportOutcome = 'APPLIED' | 'OFFERED' | 'OFFER_APPLIED';

interface DockAiAnswersIntentBase {
  readonly kind: 'dock/ai-answers-intent';
  readonly version: typeof PILOT_UA5_CONNECTED_PROTOCOL_VERSION;
  readonly origin: string;
  readonly pathname: string;
  /** 地址被单页应用改过时：文档加载时的路径（发信人核对用它比 sender.url）。 */
  readonly documentPathname?: string;
}

/** 这一轮从点击起算的一个时刻（毫秒）；`WRITE` 带写成了几栏，`READY` 带晚到、要再点一下的几栏。 */
export type AiTimingMark =
  | Readonly<{ at: 'SENT' | 'OPEN' | 'FAST' | 'LONG' | 'DONE'; ms: number }>
  | Readonly<{ at: 'WRITE' | 'READY'; ms: number; count: number }>;
/** 一轮最多交这么多个时刻（一轮最多 9 次模型调用外加一批直接答案，写入次数不会更多）。 */
export const AI_TIMING_MAX_MARKS = 24;

export type DockAiAnswersPayload =
  | Readonly<{ step: 'PLAN'; title: string; fields: readonly FullAiField[]; job?: FullAiJob }>
  | Readonly<{ step: 'REVISE'; title: string; field: FullAiField; currentValue: string; instruction: string }>
  | Readonly<{ step: 'QUOTA' }>
  | Readonly<{ step: 'SETTINGS_GET' }>
  | Readonly<{ step: 'SETTINGS_SET'; enabled: boolean }>
  | Readonly<{ step: 'REPORT'; outcome: AiAnswersReportOutcome; count: number }>
  | Readonly<{ step: 'TIMING'; marks: readonly AiTimingMark[] }>;

export type DockAiAnswersIntent = DockAiAnswersIntentBase & DockAiAnswersPayload;

/** 这个月的 AI 次数（会员不限）。 */
export interface AiQuota {
  readonly unlimited: boolean;
  readonly limit: number | null;
  readonly remaining: number | null;
  /** 哪天恢复（ISO 时间；会员是 null）。 */
  readonly resetsAt: string | null;
}

/** 一道题的 AI 答案（worker 已按契约与门槛筛过）：文本题放 `value`，选择题放 `optionIds`。 */
export interface AiFill {
  readonly id: string;
  readonly value: string | null;
  readonly optionIds: readonly string[];
}

/** 浮层只分这几种：开关关着、要重新登录、次数用完（两种）、其余一律「这次没有」。 */
export type AiAnswersRefusal = 'SWITCHED_OFF' | 'AUTH_REQUIRED' | 'PAYWALL_REQUIRED' | 'QUOTA_EXCEEDED' | 'UNAVAILABLE';

export type DockAiAnswersReply =
  | Readonly<{ kind: 'AI_REVISED'; value: string }>
  | Readonly<{ kind: 'AI_QUOTA'; quota: AiQuota }>
  | Readonly<{ kind: 'AI_ANSWERS_SETTINGS'; enabled: boolean }>
  | Readonly<{ kind: 'AI_ANSWERS_NOTED' }>
  | Readonly<{ kind: 'REFUSED'; code: AiAnswersRefusal }>;

/**
 * 一次「自动填写」的那一条长连接（2026-09-24）：内容脚本连上、发一条 `PLAN`；worker 打 `plan/stream`，
 * 按到达的先后交回 `DockAiStreamMessage`，最后一条永远是 `AI_STREAM_END` 或 `REFUSED`，然后断开。
 * 任何一边断开，另一边就停（worker 中止请求；内容脚本把还没到的题当没答上）。
 */
export const AI_ANSWERS_STREAM_PORT = 'ai-answers/stream';

export type DockAiStreamMessage =
  /** 服务端收下了这一轮（响应头到了）。 */
  | Readonly<{ kind: 'AI_STREAM_OPEN' }>
  /**
   * 一批答案（worker 已按契约与门槛筛过）：`fills` 能直接写的，`noEvidence` 送出去、AI 看过但在资料里没找到依据的
   * 题号（服务端说 skip／review，理由是 MISSING_PROFILE 或 LOW_CONFIDENCE）。`lane` 说是哪一道答的：已知的见
   * `FULL_AI_LANES`，更新的服务端可能多一道（2026-09-28 起照收）——它只用来打时间点，不参与任何放行。
   */
  | Readonly<{ kind: 'AI_STREAM_ANSWERS'; lane: FullAiLane | string; fills: readonly AiFill[]; noEvidence: readonly string[] }>
  /** 流结束了：`unanswered` 是这一轮一个答案都没拿到的题号（那一道失败、流断了、或一行不合格就不再读）。 */
  | Readonly<{ kind: 'AI_STREAM_END'; unanswered: readonly string[] }>
  | Readonly<{ kind: 'REFUSED'; code: AiAnswersRefusal }>;

const BASE_KEYS = ['kind', 'version', 'origin', 'pathname', 'step'] as const;
const TIMING_AT: readonly string[] = ['SENT', 'OPEN', 'FAST', 'LONG', 'DONE', 'WRITE', 'READY'];
/** 一轮最多等这么久（服务端 75 秒、worker 80 秒），更大的毫秒数不是这一轮的。 */
const TIMING_MAX_MS = 600_000;
const REFUSALS: readonly string[] = ['SWITCHED_OFF', 'AUTH_REQUIRED', 'PAYWALL_REQUIRED', 'QUOTA_EXCEEDED', 'UNAVAILABLE'];
const REPORTS: readonly string[] = ['APPLIED', 'OFFERED', 'OFFER_APPLIED'];
/** 契约解析器要两个 uuid；意图里没有（worker 铸），用固定占位过形状校验。 */
const PLACEHOLDER_ID = '00000000-0000-4000-8000-000000000000';
const TOKEN = /^[a-zA-Z0-9_-]{1,64}$/;

function exactKeys(value: object, keys: readonly string[]): boolean {
  const present = keysBesidesDocumentPath(value);
  return present.length === keys.length && keys.every((key) => present.includes(key));
}

/** 精确键集，不另外放过任何键（长连接上的消息与时刻不带页面路径）。 */
function onlyKeys(value: object, keys: readonly string[]): boolean {
  const present = Object.keys(value);
  return present.length === keys.length && keys.every((key) => present.includes(key));
}

/**
 * 内容脚本这一侧：造一条消息。只规范化页面（与其它 dock 消息同一套），题目的形状由 worker 按契约全量校验——
 * 那一份解析器留在 worker 里，不进内容脚本的包。
 */
export function createDockAiAnswersIntent(
  origin: string,
  pathname: string,
  payload: DockAiAnswersPayload,
): DockAiAnswersIntent | null {
  const ready = createPilotUa5ConnectedPageReady(origin, pathname);
  if (ready === null) return null;
  return Object.freeze({
    kind: 'dock/ai-answers-intent',
    version: PILOT_UA5_CONNECTED_PROTOCOL_VERSION,
    origin: ready.origin,
    pathname: ready.pathname,
    ...payload,
  }) as DockAiAnswersIntent;
}

/** worker 这一侧：精确键集，题目按契约的请求解析器全量校验（占位的两个 uuid 由 worker 换成真的）。 */
export function parseDockAiAnswersIntent(value: unknown): DockAiAnswersIntent | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  if (
    candidate.kind !== 'dock/ai-answers-intent' ||
    candidate.version !== PILOT_UA5_CONNECTED_PROTOCOL_VERSION ||
    typeof candidate.origin !== 'string' ||
    typeof candidate.pathname !== 'string'
  ) return null;
  const ready = createPilotUa5ConnectedPageReady(candidate.origin, candidate.pathname);
  if (ready === null) return null;
  const loaded = readDocumentPathname(candidate, ready.origin);
  if (loaded === null) return null;
  const base = {
    kind: 'dock/ai-answers-intent' as const,
    version: PILOT_UA5_CONNECTED_PROTOCOL_VERSION,
    origin: ready.origin,
    pathname: ready.pathname,
    ...documentPathField(loaded, ready.pathname),
  };
  switch (candidate.step) {
    case 'SETTINGS_GET':
    case 'QUOTA':
      return exactKeys(candidate, BASE_KEYS) ? Object.freeze({ ...base, step: candidate.step }) : null;
    case 'REVISE': {
      if (!exactKeys(candidate, [...BASE_KEYS, 'title', 'field', 'currentValue', 'instruction'])) return null;
      const request = parseFullAiReviseRequest({
        schemaVersion: 1,
        requestId: PLACEHOLDER_ID,
        page: { origin: ready.origin, pathname: ready.pathname, title: candidate.title },
        field: candidate.field,
        currentValue: candidate.currentValue,
        instruction: candidate.instruction,
      });
      return request === null
        ? null
        : Object.freeze({
            ...base,
            step: 'REVISE' as const,
            title: request.page.title,
            field: request.field,
            currentValue: request.currentValue,
            instruction: request.instruction,
          });
    }
    case 'SETTINGS_SET':
      return exactKeys(candidate, [...BASE_KEYS, 'enabled']) && typeof candidate.enabled === 'boolean'
        ? Object.freeze({ ...base, step: 'SETTINGS_SET' as const, enabled: candidate.enabled })
        : null;
    case 'TIMING': {
      if (!exactKeys(candidate, [...BASE_KEYS, 'marks']) || !Array.isArray(candidate.marks)) return null;
      if (candidate.marks.length === 0 || candidate.marks.length > AI_TIMING_MAX_MARKS) return null;
      const marks: AiTimingMark[] = [];
      for (const raw of candidate.marks) {
        const mark = parseTimingMark(raw);
        if (mark === null) return null;
        marks.push(mark);
      }
      return Object.freeze({ ...base, step: 'TIMING' as const, marks: Object.freeze(marks) });
    }
    case 'REPORT':
      return exactKeys(candidate, [...BASE_KEYS, 'outcome', 'count']) &&
        typeof candidate.outcome === 'string' && REPORTS.includes(candidate.outcome) &&
        Number.isSafeInteger(candidate.count) && Number(candidate.count) >= 0 && Number(candidate.count) <= FULL_AI_LIMITS.fields
        ? Object.freeze({ ...base, step: 'REPORT' as const, outcome: candidate.outcome as AiAnswersReportOutcome, count: Number(candidate.count) })
        : null;
    case 'PLAN': {
      const withJob = Object.prototype.hasOwnProperty.call(candidate, 'job');
      if (!exactKeys(candidate, [...BASE_KEYS, 'title', 'fields', ...(withJob ? ['job'] : [])])) return null;
      const request = parseFullAiRequest({
        schemaVersion: 1,
        requestId: PLACEHOLDER_ID,
        snapshotId: PLACEHOLDER_ID,
        page: { origin: ready.origin, pathname: ready.pathname, title: candidate.title },
        fields: candidate.fields,
        ...(withJob ? { job: candidate.job } : {}),
      });
      return request === null
        ? null
        : Object.freeze({
            ...base,
            step: 'PLAN' as const,
            title: request.page.title,
            fields: request.fields,
            ...(request.job === undefined ? {} : { job: request.job }),
          });
    }
    default:
      return null;
  }
}

/** 内容脚本解码 worker 的答复。答案要写进网页，逐条按上限校验。 */
export function parseDockAiAnswersReply(value: unknown): DockAiAnswersReply | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  switch (candidate.kind) {
    case 'REFUSED':
      return typeof candidate.code === 'string' && REFUSALS.includes(candidate.code)
        ? Object.freeze({ kind: 'REFUSED' as const, code: candidate.code as AiAnswersRefusal })
        : null;
    case 'AI_ANSWERS_SETTINGS':
      return typeof candidate.enabled === 'boolean' ? Object.freeze({ kind: 'AI_ANSWERS_SETTINGS' as const, enabled: candidate.enabled }) : null;
    case 'AI_ANSWERS_NOTED':
      return Object.freeze({ kind: 'AI_ANSWERS_NOTED' as const });
    case 'AI_REVISED':
      return typeof candidate.value === 'string' && candidate.value.length <= FULL_AI_LIMITS.value
        ? Object.freeze({ kind: 'AI_REVISED' as const, value: candidate.value })
        : null;
    case 'AI_QUOTA': {
      const quota = candidate.quota as Record<string, unknown> | null;
      const count = (value: unknown): value is number | null => value === null || (Number.isSafeInteger(value) && Number(value) >= 0);
      const resetsAt = quota?.resetsAt;
      const when = resetsAt === null || (typeof resetsAt === 'string' && resetsAt.length <= 40 && Number.isFinite(Date.parse(resetsAt)));
      return quota !== null && typeof quota === 'object' && typeof quota.unlimited === 'boolean' && count(quota.limit) && count(quota.remaining) && when
        ? Object.freeze({ kind: 'AI_QUOTA' as const, quota: Object.freeze({ unlimited: quota.unlimited, limit: quota.limit, remaining: quota.remaining, resetsAt: resetsAt as string | null }) })
        : null;
    }
    default:
      return null;
  }
}

function parseTimingMark(raw: unknown): AiTimingMark | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const mark = raw as Record<string, unknown>;
  if (typeof mark.at !== 'string' || !TIMING_AT.includes(mark.at)) return null;
  if (!Number.isSafeInteger(mark.ms) || Number(mark.ms) < 0 || Number(mark.ms) > TIMING_MAX_MS) return null;
  const counted = mark.at === 'WRITE' || mark.at === 'READY';
  if (!onlyKeys(mark, counted ? ['at', 'ms', 'count'] : ['at', 'ms'])) return null;
  if (!counted) return Object.freeze({ at: mark.at as 'SENT', ms: Number(mark.ms) });
  if (!Number.isSafeInteger(mark.count) || Number(mark.count) < 0 || Number(mark.count) > FULL_AI_LIMITS.fields) return null;
  return Object.freeze({ at: mark.at as 'WRITE', ms: Number(mark.ms), count: Number(mark.count) });
}

/** 浮层与审计面板只摆这种形状的诊断码（`^[A-Z0-9_]{3,64}$`），计时码也照这个来。 */
const TIMING_CODE_MAX = 64;
const TIMING_CODE_PREFIX = 'AI_MS_';

/**
 * 诊断码（只有码与数字）：`AI_MS_SENT850_OPEN1100_FAST3400_W3500X4_LONG5200_W5260X3_DONE5300`。
 * 时刻按发生的先后排；`W` 是那一刻写成了几栏，`R` 是晚到、要再点一下的几栏。一条码最多 64 个字符，放不下就接着
 * 下一条 `AI_MS_…`（一轮的第一条永远从 `SENT` 开始，不从 `SENT` 开始的就是上一条的续）。
 */
export function aiTimingCodes(marks: readonly AiTimingMark[]): string[] {
  const tokens = [...marks]
    .sort((left, right) => left.ms - right.ms)
    .map((mark) => mark.at === 'WRITE' ? `W${mark.ms}X${mark.count}`
      : mark.at === 'READY' ? `R${mark.ms}X${mark.count}`
        : `${mark.at}${mark.ms}`);
  const codes: string[] = [];
  let code = '';
  for (const token of tokens) {
    const longer = code === '' ? `${TIMING_CODE_PREFIX}${token}` : `${code}_${token}`;
    if (longer.length <= TIMING_CODE_MAX) {
      code = longer;
      continue;
    }
    codes.push(code);
    code = `${TIMING_CODE_PREFIX}${token}`;
  }
  if (code !== '') codes.push(code);
  return codes;
}

/** 上报用的时长桶（码里不嵌毫秒，体检 11-4）。 */
export function aiTimingBucket(ms: number): 'LT2S' | 'LT5S' | 'LT10S' | 'LT20S' | 'LT40S' | 'GE40S' {
  return ms < 2_000 ? 'LT2S' : ms < 5_000 ? 'LT5S' : ms < 10_000 ? 'LT10S' : ms < 20_000 ? 'LT20S' : ms < 40_000 ? 'LT40S' : 'GE40S';
}

/**
 * 上报的那一份计时（2026-10-04，体检 11-4）：固定的码，只有「第一批答案写上」与「流结束」两个时刻、各落进一个桶——
 * 线上看得出慢在哪一段，又不会每一轮造出一个新码。逐个时刻的那一串（`aiTimingCodes`）只进本机。
 */
export function aiTimingBuckets(marks: readonly AiTimingMark[]): string[] {
  const firstWrite = marks.filter((mark) => mark.at === 'WRITE').map((mark) => mark.ms).sort((left, right) => left - right)[0];
  const done = marks.find((mark) => mark.at === 'DONE')?.ms;
  return [
    ...(firstWrite === undefined ? [] : [`AI_TIMING_FIRST_WRITE_${aiTimingBucket(firstWrite)}`]),
    ...(done === undefined ? [] : [`AI_TIMING_DONE_${aiTimingBucket(done)}`]),
  ];
}

/** 内容脚本解码长连接上的一条消息。答案要写进网页，逐条按上限校验；认不出的一条就是整条流到此为止。 */
export function parseDockAiStreamMessage(value: unknown): DockAiStreamMessage | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  const ids = (list: unknown): list is string[] =>
    Array.isArray(list) && list.length <= FULL_AI_LIMITS.fields && list.every((id) => typeof id === 'string' && TOKEN.test(id));
  switch (candidate.kind) {
    case 'AI_STREAM_OPEN':
      return onlyKeys(candidate, ['kind']) ? Object.freeze({ kind: 'AI_STREAM_OPEN' as const }) : null;
    case 'AI_STREAM_END':
      return onlyKeys(candidate, ['kind', 'unanswered']) && ids(candidate.unanswered)
        ? Object.freeze({ kind: 'AI_STREAM_END' as const, unanswered: Object.freeze([...candidate.unanswered]) })
        : null;
    case 'REFUSED':
      return onlyKeys(candidate, ['kind', 'code']) && typeof candidate.code === 'string' && REFUSALS.includes(candidate.code)
        ? Object.freeze({ kind: 'REFUSED' as const, code: candidate.code as AiAnswersRefusal })
        : null;
    case 'AI_STREAM_ANSWERS': {
      if (!onlyKeys(candidate, ['kind', 'lane', 'fills', 'noEvidence'])) return null;
      // 道只用来打时间点：长得像道名就收（这一版不认识的那一道也收，见类型注释）。
      if (typeof candidate.lane !== 'string' || !TOKEN.test(candidate.lane)) return null;
      if (!Array.isArray(candidate.fills) || candidate.fills.length > FULL_AI_LIMITS.fields) return null;
      const fills: AiFill[] = [];
      for (const raw of candidate.fills) {
        if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
        const item = raw as Record<string, unknown>;
        if (!onlyKeys(item, ['id', 'value', 'optionIds'])) return null;
        if (typeof item.id !== 'string' || !TOKEN.test(item.id)) return null;
        if (!(item.value === null || (typeof item.value === 'string' && item.value.length <= FULL_AI_LIMITS.value))) return null;
        if (!Array.isArray(item.optionIds) || item.optionIds.length > FULL_AI_LIMITS.options) return null;
        if (!item.optionIds.every((id) => typeof id === 'string' && TOKEN.test(id))) return null;
        fills.push(Object.freeze({ id: item.id, value: item.value as string | null, optionIds: Object.freeze([...item.optionIds as string[]]) }));
      }
      if (!ids(candidate.noEvidence)) return null;
      return Object.freeze({
        kind: 'AI_STREAM_ANSWERS' as const,
        lane: candidate.lane,
        fills: Object.freeze(fills),
        noEvidence: Object.freeze([...candidate.noEvidence]),
      });
    }
    default:
      return null;
  }
}

/** 服务端要求 `fill` 至少这么有把握；这里再核一遍，不信任何一条低于它的。 */
export const AI_FILL_MIN_CONFIDENCE = 0.85;

/**
 * 一批指令里能直接写的那几条（worker 这一侧，流上的一行按契约解析过之后）。
 *
 * 只收 `fill`、有把握（≥ 0.85）、理由是「资料」或「按资料起草」、至少引了一条资料的；引的是
 * `confirmedAnswers.*`（服务端拿用户记住的答案答的）一律不收——记住的答案归答案记忆那两个开关管，
 * 用户没打开「自动带出」就不该因为开着 AI 代答而被带出来。只能本人答的题（工作授权、EEO、同意……）
 * 按契约同一个判据再挡一次。
 */
export function usableAiFills(instructions: readonly FullAiInstruction[], request: FullAiRequest): AiFill[] {
  const fields = new Map(request.fields.map((field) => [field.id, field]));
  return instructions.flatMap((instruction) => {
    const field = fields.get(instruction.id);
    if (
      field === undefined ||
      field.hasValue ||
      field.kind === 'file' ||
      instruction.action !== 'fill' ||
      !(instruction.confidence >= AI_FILL_MIN_CONFIDENCE) ||
      (instruction.reason !== 'PROFILE' && instruction.reason !== 'DRAFT') ||
      instruction.sourcePaths.length === 0 ||
      instruction.sourcePaths.some((path) => path.startsWith('confirmedAnswers.')) ||
      fullAiRequiresManual(field, instruction.sourcePaths) ||
      (instruction.value === null && instruction.optionIds.length === 0)
    ) return [];
    return [Object.freeze({ id: instruction.id, value: instruction.value, optionIds: Object.freeze([...instruction.optionIds]) })];
  });
}

/**
 * 送出去、AI 看过却在资料里没找到依据的题（worker 这一侧，契约解析过之后）：服务端没给 `fill`，理由是资料里没有
 * （MISSING_PROFILE）或证据不够（LOW_CONFIDENCE）。只能本人答（MANUAL_REQUIRED）、控件不支持、选项读不全、已经有值的
 * 不算——那几类的原因不是「资料里没有」，浮层照旧说它们原来的原因。
 */
export function noEvidenceIds(instructions: readonly FullAiInstruction[], request: FullAiRequest): string[] {
  const sent = new Set(request.fields.filter((field) => !field.hasValue).map((field) => field.id));
  return instructions
    .filter((instruction) => sent.has(instruction.id) && instruction.action !== 'fill' &&
      (instruction.reason === 'MISSING_PROFILE' || instruction.reason === 'LOW_CONFIDENCE'))
    .map((instruction) => instruction.id);
}
