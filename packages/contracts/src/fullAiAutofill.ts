/**
 * 消费方拷贝：权威在 argoland `src/career-team/contracts/fullAiAutofill.ts`，除这段头注外逐字相同
 * （RULE-EXT-CONTRACT-CONSUMER：本仓不改 wire 形状，要改先在 argoland 提 additive 变更）。
 *
 * 插件拿它做「AI 代答」（2026-09-23 负责人决定）：规则答不了、页面上还空着的题，把题面、选项与旁边的说明文字
 * 交给服务端（不带选择器、不带页面上的现值），服务端读用户自己确认过的资料起草答案；以及用户在一栏旁按「生成」
 * 时的逐题写／改写（revise，只有这一步带那一栏的现值）与这个月的 AI 次数（quota）。
 * 2026-09-24 起（argoland #620）：一次「自动填写」只发一条 `plan/stream`，答案按 NDJSON 一行一行回来——选择题与
 * 短事实先到、开放题随后；请求可带岗位描述 `job`（页面 JSON-LD JobPosting 的纯文本，只作不可信的上下文）。
 */
/**
 * Server-owned, selector-free Full AI form protocol. No HTML; a current input
 * value travels only in the user-invoked single-field revise request.
 */
export const FULL_AI_PATH = '/api/v1/agent/full-ai-autofill/plan';
/** Same request as `plan`; answers stream back as NDJSON lines as each pass finishes. */
export const FULL_AI_STREAM_PATH = '/api/v1/agent/full-ai-autofill/plan/stream';
export const FULL_AI_REVISE_PATH = '/api/v1/agent/full-ai-autofill/revise';
export const FULL_AI_QUOTA_PATH = '/api/v1/agent/full-ai-autofill/quota';
/** `bytes` bounds the request without its optional `job`, which has its own caps. */
export const FULL_AI_LIMITS = { fields: 120, options: 160, bytes: 96_000, value: 6_000 } as const;
export const FULL_AI_REVISE_LIMITS = { instruction: 1_000 } as const;
/**
 * Character caps of the optional job posting. A longer member is refused
 * (`FULL_AI_REQUEST_INVALID`), so the client truncates before sending.
 */
export const FULL_AI_JOB_LIMITS = {
  title: 300,
  company: 200,
  location: 300,
  description: 12_000,
} as const;
export type FullAiFieldKind =
  | 'text'
  | 'textarea'
  | 'select'
  | 'combobox'
  | 'radio'
  | 'checkbox'
  | 'file'
  | 'date'
  | 'number';
const FULL_AI_FIELD_KINDS: readonly string[] = [
  'text',
  'textarea',
  'select',
  'combobox',
  'radio',
  'checkbox',
  'file',
  'date',
  'number',
] satisfies readonly FullAiFieldKind[];
/** A revise answer is prose for one free-text field, never a choice. */
export const FULL_AI_REVISE_FIELD_KINDS = ['text', 'textarea'] as const satisfies readonly FullAiFieldKind[];
export interface FullAiField {
  id: string;
  kind: FullAiFieldKind;
  label: string;
  context: string;
  autocomplete: string;
  required: boolean;
  hasValue: boolean;
  maxLength: number | null;
  options: { id: string; label: string }[];
  optionsComplete: boolean;
}
/**
 * The posting being applied to, as plain text (the extension reads the page's
 * JSON-LD JobPosting and strips markup). Every member is optional; send only
 * what the page states. Untrusted data: it explains what a question asks and
 * lets open answers relate the applicant's evidenced facts to the role, but it
 * is never evidence of the applicant's facts. Never logged or stored.
 */
export interface FullAiJob {
  title?: string;
  company?: string;
  location?: string;
  description?: string;
}
export interface FullAiRequest {
  schemaVersion: 1;
  requestId: string;
  snapshotId: string;
  page: { origin: string; pathname: string; title: string };
  fields: FullAiField[];
  /** Optional and additive; see {@link FullAiJob}. */
  job?: FullAiJob;
}
export const FULL_AI_REASONS = [
  'PROFILE',
  'DRAFT',
  'MISSING_PROFILE',
  'MANUAL_REQUIRED',
  'LOW_CONFIDENCE',
  'EXISTING_VALUE',
  'UNSUPPORTED',
  'OPTIONS_UNAVAILABLE',
] as const;
export interface FullAiInstruction {
  id: string;
  action: 'fill' | 'review' | 'skip' | 'resume';
  value: string | null;
  optionIds: string[];
  sourcePaths: string[];
  confidence: number;
  reason: (typeof FULL_AI_REASONS)[number];
}
export const FULL_AI_FAILURES = [
  'FULL_AI_REQUEST_INVALID',
  'FULL_AI_DISABLED',
  'FULL_AI_PROFILE_UNAVAILABLE',
  'FULL_AI_PROFILE_CHANGED',
  'FULL_AI_ANSWERS_CHANGED',
  'FULL_AI_PROVIDER_FAILED',
  'FULL_AI_OUTPUT_INVALID',
  'FULL_AI_CANCELLED',
  'FULL_AI_BUSY',
  'AUTH_REQUIRED',
  'PAYWALL_REQUIRED',
  'QUOTA_EXCEEDED',
  'FULL_AI_UNAVAILABLE',
] as const;
export type FullAiFailure = (typeof FULL_AI_FAILURES)[number];
export type FullAiResponse =
  | { schemaVersion: 1; ok: false; code: FullAiFailure }
  | {
      schemaVersion: 1;
      ok: true;
      requestId: string;
      snapshotId: string;
      profileRevision: string;
      deletionEpoch: string;
      expiresAt: string;
      instructions: FullAiInstruction[];
      metrics: { planningMs: number; requestBytes: number; fieldCount: number; model: string };
    };

/**
 * Which pass released an answer: `direct` needed no model (a confirmed stored
 * answer, a protected or pre-filled field), `fast` covers choices, yes/no and
 * short facts, `long` covers open answers. Fast and long run in parallel.
 */
export const FULL_AI_LANES = ['direct', 'fast', 'long'] as const;
export type FullAiLane = (typeof FULL_AI_LANES)[number];

/**
 * One NDJSON line of `plan/stream` (UTF-8, one JSON object per `\n`-terminated
 * line; the HTTP status is 200 once the quota admits the round, and every
 * later outcome travels in-band).
 *
 * `answers` releases final instructions for some of the request's fields as
 * soon as their pass finishes; apply them right away. A field is released at
 * most once per stream. `done` is always the last line: with `ok: true`, every
 * field not released is listed once in `unanswered` with the failure that cost
 * it its answer (the other passes are unaffected); with `ok: false`, the round
 * produced no `answers` at all. A line that fails
 * {@link parseFullAiStreamEvent} ends the stream; answers already applied
 * stand, the rest count as unanswered.
 */
export interface FullAiStreamAnswers {
  schemaVersion: 1;
  type: 'answers';
  requestId: string;
  snapshotId: string;
  /**
   * 已知的道见 `FULL_AI_LANES`。读侧（插件）可能遇到更新的服务端加的一道（2026-09-28 起照收）：
   * 道只用来打时间点，不参与任何放行，所以这里是 `string`，消费端只拿已知值比对。
   */
  lane: FullAiLane | string;
  profileRevision: string;
  deletionEpoch: string;
  expiresAt: string;
  instructions: FullAiInstruction[];
}
export interface FullAiUnanswered {
  code: FullAiFailure;
  fieldIds: string[];
}
export interface FullAiStreamMetrics {
  planningMs: number;
  fieldCount: number;
  /** Model calls whose answers passed validation this round. */
  modelCalls: number;
  /** Milliseconds from the start of the round to the last `fast` / `long` answers; null when that pass had nothing. */
  fastMs: number | null;
  longMs: number | null;
  model: string;
}
export type FullAiStreamDone =
  | {
      schemaVersion: 1;
      type: 'done';
      ok: true;
      requestId: string;
      unanswered: FullAiUnanswered[];
      metrics: FullAiStreamMetrics;
    }
  | { schemaVersion: 1; type: 'done'; ok: false; code: FullAiFailure };
export type FullAiStreamEvent = FullAiStreamAnswers | FullAiStreamDone;

/**
 * One user-invoked generation for one free-text field: write it from the
 * profile (empty `currentValue`) or rewrite the current value. `instruction` is
 * the user's wish about tone, length, focus or language; it never licenses new
 * facts. Protected fields (see `fullAiManualField`) are not revisable. A fresh
 * `requestId` belongs to every generation: an identical repeated body is the
 * same metered action and is not generated twice.
 */
export interface FullAiReviseRequest {
  schemaVersion: 1;
  requestId: string;
  page: { origin: string; pathname: string; title: string };
  field: FullAiField;
  currentValue: string;
  instruction: string;
  /** Optional and additive; see {@link FullAiJob}. */
  job?: FullAiJob;
}
/**
 * `value: ''` means the profile holds too little evidence for a truthful
 * answer; it then cites no `sourcePaths`. Quota refusals are transport
 * statuses shared with `plan` (402 `PAYWALL_REQUIRED`, 429 `USAGE_EXHAUSTED`),
 * which clients report as `PAYWALL_REQUIRED` / `QUOTA_EXCEEDED`.
 */
export type FullAiReviseResponse =
  | { schemaVersion: 1; ok: false; code: FullAiFailure }
  | {
      schemaVersion: 1;
      ok: true;
      requestId: string;
      value: string;
      confidence: number;
      sourcePaths: string[];
    };
/**
 * The caller's AI application answer allowance, shared by `plan` and `revise`.
 * Members and ADMIN are `unlimited` (the other three members are null);
 * otherwise `limit`/`remaining` count generations in the window ending at
 * `resetsAt`.
 */
export interface FullAiQuota {
  schemaVersion: 1;
  unlimited: boolean;
  limit: number | null;
  remaining: number | null;
  resetsAt: string | null;
}

function record(v: unknown): v is Record<string, unknown> {
  return (
    !!v &&
    typeof v === 'object' &&
    !Array.isArray(v) &&
    [Object.prototype, null].includes(Object.getPrototypeOf(v))
  );
}
function keys(v: Record<string, unknown>, expected: string[]) {
  return (
    Object.keys(v).length === expected.length &&
    expected.every((k) => Object.prototype.hasOwnProperty.call(v, k))
  );
}
/**
 * 应答（服务端 → 插件）用的键检查（2026-09-28）：认得的一个都不能少，多出来的不拒——后端先发的
 * 加法不该让旧包把整条流判坏。多出来的成员不解释、不转发：解析结果只从认得的字段重建。
 * 请求（插件 → 服务端）照旧用 `keys`，精确到每一个键。
 */
function hasKeys(v: Record<string, unknown>, required: string[]) {
  return (
    required.every((k) => Object.prototype.hasOwnProperty.call(v, k)) &&
    Object.keys(v).every((k) => k !== '__proto__' && k !== 'constructor' && k !== 'prototype')
  );
}
/**
 * 应答里的失败码：认得的原样；这一版不认识、但长得像码的（后端新加的一种）读作 `FULL_AI_UNAVAILABLE`——
 * 这一次确实没成，原因这一版说不上来；不像码的是坏数据（null）。
 */
function failureCode(v: unknown): FullAiFailure | null {
  if (FULL_AI_FAILURES.includes(v as FullAiFailure)) return v as FullAiFailure;
  return typeof v === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(v) ? 'FULL_AI_UNAVAILABLE' : null;
}
function text(v: unknown, max: number, empty = false): v is string {
  return (
    typeof v === 'string' &&
    v.length <= max &&
    (empty || v.trim().length > 0) &&
    ![...v].some((char) => char.charCodeAt(0) < 32 && !['\t', '\n', '\r'].includes(char))
  );
}
const uuid = (v: unknown): v is string =>
  typeof v === 'string' &&
  /^[\da-f]{8}-[\da-f]{4}-[1-8][\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/i.test(v);
const token = (v: unknown): v is string => typeof v === 'string' && /^[a-zA-Z0-9_-]{1,64}$/.test(v);

const count = (v: unknown): v is number => Number.isSafeInteger(v) && Number(v) >= 0;
const bytesOf = (v: unknown) => new TextEncoder().encode(JSON.stringify(v)).length;
/** The request's byte bound excludes its job posting, which has its own caps. */
const bytesWithoutJob = (v: Record<string, unknown>) => bytesOf({ ...v, job: undefined });

/** Strict job posting: known members only, each plain bounded text (empty allowed). */
function validJob(j: unknown): j is FullAiJob {
  return (
    record(j) &&
    Object.keys(j).every(
      (key) =>
        Object.prototype.hasOwnProperty.call(FULL_AI_JOB_LIMITS, key) &&
        text(j[key], FULL_AI_JOB_LIMITS[key as keyof typeof FULL_AI_JOB_LIMITS], true),
    )
  );
}

/** Exactly `members`, plus an optional valid `job`. */
function membersWithOptionalJob(v: Record<string, unknown>, members: string[]): boolean {
  return Object.prototype.hasOwnProperty.call(v, 'job')
    ? keys(v, [...members, 'job']) && validJob(v.job)
    : keys(v, members);
}

/** Page binding shared by every Full AI request. May throw on a malformed origin. */
function validPage(p: unknown): p is FullAiRequest['page'] {
  if (
    !record(p) ||
    !keys(p, ['origin', 'pathname', 'title']) ||
    !text(p.origin, 300) ||
    !text(p.pathname, 1500) ||
    !p.pathname.startsWith('/') ||
    /[?#\\]/.test(p.pathname) ||
    !text(p.title, 240, true)
  )
    return false;
  const url = new URL(p.origin);
  return !(
    url.origin !== p.origin ||
    url.username ||
    url.password ||
    (url.protocol !== 'https:' &&
      !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))
  );
}

/** One semantic field descriptor: opaque ids, no selectors and no current value. */
function validField(f: unknown): f is FullAiField {
  if (
    !record(f) ||
    !keys(f, [
      'id',
      'kind',
      'label',
      'context',
      'autocomplete',
      'required',
      'hasValue',
      'maxLength',
      'options',
      'optionsComplete',
    ]) ||
    !token(f.id) ||
    !FULL_AI_FIELD_KINDS.includes(String(f.kind)) ||
    !text(f.label, 600) ||
    !text(f.context, 600, true) ||
    !text(f.autocomplete, 80, true) ||
    typeof f.required !== 'boolean' ||
    typeof f.hasValue !== 'boolean' ||
    typeof f.optionsComplete !== 'boolean' ||
    !(
      f.maxLength === null ||
      (Number.isInteger(f.maxLength) &&
        Number(f.maxLength) > 0 &&
        Number(f.maxLength) <= 1_000_000)
    ) ||
    !Array.isArray(f.options) ||
    f.options.length > FULL_AI_LIMITS.options
  )
    return false;
  const options = new Set<string>();
  for (const o of f.options) {
    if (
      !record(o) ||
      !keys(o, ['id', 'label']) ||
      !token(o.id) ||
      options.has(o.id) ||
      !text(o.label, 300)
    )
      return false;
    options.add(o.id);
  }
  return true;
}

export function parseFullAiRequest(raw: unknown): FullAiRequest | null {
  try {
    if (
      !record(raw) ||
      !membersWithOptionalJob(raw, ['schemaVersion', 'requestId', 'snapshotId', 'page', 'fields']) ||
      raw.schemaVersion !== 1 ||
      !uuid(raw.requestId) ||
      !uuid(raw.snapshotId) ||
      bytesWithoutJob(raw) > FULL_AI_LIMITS.bytes ||
      !validPage(raw.page)
    )
      return null;
    if (
      !Array.isArray(raw.fields) ||
      raw.fields.length < 1 ||
      raw.fields.length > FULL_AI_LIMITS.fields
    )
      return null;
    const ids = new Set<string>();
    for (const f of raw.fields) {
      if (!validField(f) || ids.has(f.id)) return null;
      ids.add(f.id);
    }
    return raw as unknown as FullAiRequest;
  } catch {
    return null;
  }
}

/** Strict revise request: one unprotected free-text field, bounded draft and instruction. */
export function parseFullAiReviseRequest(raw: unknown): FullAiReviseRequest | null {
  try {
    if (
      !record(raw) ||
      !membersWithOptionalJob(raw, [
        'schemaVersion',
        'requestId',
        'page',
        'field',
        'currentValue',
        'instruction',
      ]) ||
      raw.schemaVersion !== 1 ||
      !uuid(raw.requestId) ||
      !text(raw.currentValue, FULL_AI_LIMITS.value, true) ||
      !text(raw.instruction, FULL_AI_REVISE_LIMITS.instruction, true) ||
      bytesWithoutJob(raw) > FULL_AI_LIMITS.bytes ||
      !validPage(raw.page) ||
      !validField(raw.field) ||
      !(FULL_AI_REVISE_FIELD_KINDS as readonly string[]).includes(raw.field.kind) ||
      // Prose never chooses among options; the descriptor carries none.
      raw.field.options.length !== 0 ||
      // Work authorization, EEO, consent, signatures, credentials and the like
      // are answered by the applicant, never generated.
      fullAiManualField(raw.field)
    )
      return null;
    return raw as unknown as FullAiReviseRequest;
  } catch {
    return null;
  }
}

/** Actions that cannot be delegated by remembering an answer to a previous form. */
export function fullAiHumanActionField(
  field: Pick<FullAiField, 'label' | 'context' | 'autocomplete'> &
    Partial<Pick<FullAiField, 'options'>>,
): boolean {
  return /\b(password|passcode|captcha|verification code|one.time|social security|ssn|passport|signature|sign here|certify|attest|consent|agree|terms|privacy|marketing|subscribe|permissions|(?:i|we) authorize|contact.*(?:employer|reference)|(?:receive|send).*(?:sms|text messages|job alerts|recruiting updates))\b|密码|验证码|同意|签名|联系现任雇主/i.test(
    `${field.label} ${field.context} ${field.autocomplete} ${field.options?.map((o) => o.label).join(' ') ?? ''}`,
  );
}

/** AI must not infer protected applicant facts, even at high confidence. */
export function fullAiManualField(
  field: Pick<FullAiField, 'label' | 'context' | 'autocomplete'> &
    Partial<Pick<FullAiField, 'options'>>,
): boolean {
  return (
    fullAiHumanActionField(field) ||
    /\b(password|passcode|captcha|verification code|one.time|social security|ssn|passport|signature|sign here|certify|attest|consent|agree|terms|privacy|marketing|subscribe|contact.*(?:employer|reference)|authorized|authorised|authorization|sponsorship|visa|citizenship|nationality|race|racial|ethnicity|ethnic|gender|transgender|pronouns?|sex|sexual orientation|diversity|demographic|veteran|disability|disabled|date of birth|birth date|criminal|convicted|over 18|age)\b|密码|验证码|同意|签名|授权|国籍|残疾|性别/i.test(
      `${field.label} ${field.context} ${field.autocomplete}`,
    )
  );
}

/** Only the server's exact, current owner-confirmed answer can release a protected fact. */
export function fullAiRequiresManual(
  field: Pick<FullAiField, 'id' | 'label' | 'context' | 'autocomplete'> &
    Partial<Pick<FullAiField, 'options'>>,
  sourcePaths: readonly string[],
): boolean {
  return (
    fullAiHumanActionField(field) ||
    (fullAiManualField(field) &&
      !(sourcePaths.length === 1 && sourcePaths[0] === `confirmedAnswers.${field.id}`))
  );
}

/** Revision, deletion epoch and expiry that bind released answers to one profile state. */
function validBinding(raw: Record<string, unknown>): boolean {
  return (
    text(raw.profileRevision, 30) &&
    /^\d+$/.test(raw.profileRevision) &&
    text(raw.deletionEpoch, 30) &&
    /^\d+$/.test(raw.deletionEpoch) &&
    text(raw.expiresAt, 40) &&
    Number.isFinite(Date.parse(raw.expiresAt))
  );
}

/** The action and reason this build knows how to act on. */
function knownInstruction(i: Record<string, unknown>): boolean {
  return (
    ['fill', 'review', 'skip', 'resume'].includes(String(i.action)) &&
    FULL_AI_REASONS.includes(i.reason as FullAiInstruction['reason'])
  );
}

/** One instruction for a field of `request`: known action and reason, bounded value, known options. */
function validInstruction(i: unknown, request: FullAiRequest): i is FullAiInstruction {
  return record(i) && knownInstruction(i) && validInstructionShape(i, request);
}

/**
 * Everything but the action/reason vocabulary: a field of `request`, bounded value, known options.
 * The stream reader (2026-09-28) accepts an action or reason this build does not know as long as it
 * is shaped like one: the field counts as released, but the instruction is not handed on.
 */
function validInstructionShape(i: unknown, request: FullAiRequest): i is Record<string, unknown> {
  if (
    !record(i) ||
    !token(i.id) ||
    !token(i.action) ||
    !token(i.reason) ||
    !(i.value === null || text(i.value, FULL_AI_LIMITS.value, true)) ||
    !Array.isArray(i.optionIds) ||
    !i.optionIds.every(token) ||
    !Array.isArray(i.sourcePaths) ||
    i.sourcePaths.length > 16 ||
    !i.sourcePaths.every((p) => text(p, 160)) ||
    typeof i.confidence !== 'number' ||
    i.confidence < 0 ||
    i.confidence > 1
  )
    return false;
  const field = request.fields.find((f) => f.id === i.id);
  return (
    !!field &&
    !(typeof i.value === 'string' && i.value.length > (field.maxLength ?? FULL_AI_LIMITS.value)) &&
    (i.optionIds as unknown[]).every((id) => field.options.some((o) => o.id === id))
  );
}

export function parseFullAiResponse(raw: unknown, request: FullAiRequest): FullAiResponse | null {
  if (!record(raw) || raw.schemaVersion !== 1) return null;
  if (raw.ok === false)
    return FULL_AI_FAILURES.includes(raw.code as FullAiFailure)
      ? { schemaVersion: 1, ok: false, code: raw.code as FullAiFailure }
      : null;
  if (
    raw.ok !== true ||
    raw.requestId !== request.requestId ||
    raw.snapshotId !== request.snapshotId ||
    !validBinding(raw) ||
    !Array.isArray(raw.instructions) ||
    raw.instructions.length !== request.fields.length ||
    !record(raw.metrics)
  )
    return null;
  const seen = new Set<string>();
  for (const i of raw.instructions) {
    if (!validInstruction(i, request) || seen.has(i.id)) return null;
    seen.add(i.id);
  }
  return raw as unknown as FullAiResponse;
}

const msOrNull = (v: unknown) => v === null || count(v);

/** A released instruction, rebuilt from the members this build knows (unknown members are dropped). */
function rebuildInstruction(i: Record<string, unknown>): FullAiInstruction {
  return {
    id: i.id as string,
    action: i.action as FullAiInstruction['action'],
    value: i.value as string | null,
    optionIds: [...(i.optionIds as string[])],
    sourcePaths: [...(i.sourcePaths as string[])],
    confidence: i.confidence as number,
    reason: i.reason as FullAiInstruction['reason'],
  };
}

/**
 * A line this reader skips instead of treating as invalid (2026-09-28): the right schema
 * version and a `type` shaped like a line type, but neither `answers` nor `done`. A backend
 * that adds a kind of line (progress, heartbeat, …) must not break readers that predate it.
 * {@link parseFullAiStreamEvent} still returns null for such a line; call this first.
 */
export function isIgnorableFullAiStreamLine(raw: unknown): boolean {
  return (
    record(raw) &&
    raw.schemaVersion === 1 &&
    typeof raw.type === 'string' &&
    /^[a-z][a-z0-9_-]{0,31}$/.test(raw.type) &&
    raw.type !== 'answers' &&
    raw.type !== 'done'
  );
}

/**
 * One line of the `plan/stream` NDJSON body, checked against its request.
 * `released` holds the field ids earlier `answers` lines of this stream
 * released; an accepted `answers` line adds its own. `done` must account for
 * every field it did not release. Null means the stream is invalid: stop
 * reading it (see {@link FullAiStreamAnswers}).
 *
 * Additive backend changes (2026-09-28): members this build does not know are
 * ignored and never handed on (the result is rebuilt from known members); an
 * unknown lane is accepted (it only marks timing); an instruction whose action
 * or reason this build does not know releases its field but is not handed on
 * (this build cannot act on it, so it fills nothing); an unknown failure code
 * reads as `FULL_AI_UNAVAILABLE`. Request/snapshot binding, profile binding,
 * field and option membership, release-once and `done` accounting are unchanged.
 */
export function parseFullAiStreamEvent(
  raw: unknown,
  request: FullAiRequest,
  released: Set<string>,
): FullAiStreamEvent | null {
  if (!record(raw) || raw.schemaVersion !== 1) return null;
  if (raw.type === 'answers') {
    if (
      !hasKeys(raw, [
        'schemaVersion',
        'type',
        'requestId',
        'snapshotId',
        'lane',
        'profileRevision',
        'deletionEpoch',
        'expiresAt',
        'instructions',
      ]) ||
      raw.requestId !== request.requestId ||
      raw.snapshotId !== request.snapshotId ||
      !token(raw.lane) ||
      !validBinding(raw) ||
      !Array.isArray(raw.instructions) ||
      raw.instructions.length === 0
    )
      return null;
    const ids = new Set<string>();
    const known: FullAiInstruction[] = [];
    for (const i of raw.instructions) {
      if (!validInstructionShape(i, request) || ids.has(i.id as string) || released.has(i.id as string)) return null;
      ids.add(i.id as string);
      if (knownInstruction(i)) known.push(rebuildInstruction(i));
    }
    for (const id of ids) released.add(id);
    return {
      schemaVersion: 1,
      type: 'answers',
      requestId: raw.requestId as string,
      snapshotId: raw.snapshotId as string,
      lane: raw.lane,
      profileRevision: raw.profileRevision as string,
      deletionEpoch: raw.deletionEpoch as string,
      expiresAt: raw.expiresAt as string,
      instructions: known,
    };
  }
  if (raw.type !== 'done') return null;
  if (raw.ok === false) {
    const code = failureCode(raw.code);
    return hasKeys(raw, ['schemaVersion', 'type', 'ok', 'code']) && code !== null && released.size === 0
      ? { schemaVersion: 1, type: 'done', ok: false, code }
      : null;
  }
  const metrics = raw.metrics;
  if (
    raw.ok !== true ||
    !hasKeys(raw, ['schemaVersion', 'type', 'ok', 'requestId', 'unanswered', 'metrics']) ||
    raw.requestId !== request.requestId ||
    !Array.isArray(raw.unanswered) ||
    !record(metrics) ||
    !hasKeys(metrics, ['planningMs', 'fieldCount', 'modelCalls', 'fastMs', 'longMs', 'model']) ||
    !count(metrics.planningMs) ||
    !count(metrics.fieldCount) ||
    !count(metrics.modelCalls) ||
    !msOrNull(metrics.fastMs) ||
    !msOrNull(metrics.longMs) ||
    !text(metrics.model, 120)
  )
    return null;
  const pending = new Set(request.fields.map((f) => f.id).filter((id) => !released.has(id)));
  const unanswered: FullAiUnanswered[] = [];
  for (const u of raw.unanswered) {
    const code = record(u) ? failureCode(u.code) : null;
    if (
      !record(u) ||
      !hasKeys(u, ['code', 'fieldIds']) ||
      code === null ||
      !Array.isArray(u.fieldIds) ||
      u.fieldIds.length === 0
    )
      return null;
    // Unknown, already released or listed twice.
    for (const id of u.fieldIds) if (!token(id) || !pending.delete(id)) return null;
    unanswered.push({ code, fieldIds: [...(u.fieldIds as string[])] });
  }
  return pending.size === 0
    ? {
        schemaVersion: 1,
        type: 'done',
        ok: true,
        requestId: raw.requestId as string,
        unanswered,
        metrics: {
          planningMs: metrics.planningMs as number,
          fieldCount: metrics.fieldCount as number,
          modelCalls: metrics.modelCalls as number,
          fastMs: metrics.fastMs as number | null,
          longMs: metrics.longMs as number | null,
          model: metrics.model as string,
        },
      }
    : null;
}

export function parseFullAiReviseResponse(
  raw: unknown,
  request: FullAiReviseRequest,
): FullAiReviseResponse | null {
  if (!record(raw) || raw.schemaVersion !== 1) return null;
  // 2026-09-28：多出来的成员不拒、不转发（结果从认得的字段重建）；不认识的失败码读作 FULL_AI_UNAVAILABLE。
  if (raw.ok === false) {
    const code = failureCode(raw.code);
    return hasKeys(raw, ['schemaVersion', 'ok', 'code']) && code !== null
      ? { schemaVersion: 1, ok: false, code }
      : null;
  }
  if (
    raw.ok !== true ||
    !hasKeys(raw, ['schemaVersion', 'ok', 'requestId', 'value', 'confidence', 'sourcePaths']) ||
    raw.requestId !== request.requestId ||
    !text(
      raw.value,
      Math.min(request.field.maxLength ?? FULL_AI_LIMITS.value, FULL_AI_LIMITS.value),
      true,
    ) ||
    (raw.value !== '' && raw.value.trim() === '') ||
    typeof raw.confidence !== 'number' ||
    !(raw.confidence >= 0 && raw.confidence <= 1) ||
    !Array.isArray(raw.sourcePaths) ||
    raw.sourcePaths.length > 16 ||
    !raw.sourcePaths.every((p) => text(p, 160)) ||
    new Set(raw.sourcePaths).size !== raw.sourcePaths.length ||
    (raw.value === '' && raw.sourcePaths.length > 0)
  )
    return null;
  return {
    schemaVersion: 1,
    ok: true,
    requestId: raw.requestId as string,
    value: raw.value,
    confidence: raw.confidence,
    sourcePaths: [...(raw.sourcePaths as string[])],
  } as FullAiReviseResponse;
}

export function parseFullAiQuota(raw: unknown): FullAiQuota | null {
  if (
    !record(raw) ||
    // 2026-09-28：多出来的成员不拒（卡片上的一行字不该因为后端多给一样东西就消失）；结果只带认得的五项。
    !hasKeys(raw, ['schemaVersion', 'unlimited', 'limit', 'remaining', 'resetsAt']) ||
    raw.schemaVersion !== 1 ||
    typeof raw.unlimited !== 'boolean'
  )
    return null;
  const valid = raw.unlimited
    ? raw.limit === null && raw.remaining === null && raw.resetsAt === null
    : count(raw.limit) &&
      count(raw.remaining) &&
      raw.remaining <= raw.limit &&
      text(raw.resetsAt, 40) &&
      Number.isFinite(Date.parse(raw.resetsAt));
  return valid
    ? {
        schemaVersion: 1,
        unlimited: raw.unlimited,
        limit: raw.limit as number | null,
        remaining: raw.remaining as number | null,
        resetsAt: raw.resetsAt as string | null,
      } as FullAiQuota
    : null;
}
