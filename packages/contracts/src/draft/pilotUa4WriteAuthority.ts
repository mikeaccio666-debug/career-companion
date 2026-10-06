import {
  PILOT_UA1_SCHEMA_VERSION,
  parsePilotUa1DiscoveryPacket,
  type PilotUa1PageBinding,
} from './pilotUa1Discovery.ts';
import {
  parsePilotUa3CandidateRule,
  type PilotUa3CandidateRule,
} from './pilotUa3CandidateRule.ts';

export const PILOT_UA4_SCHEMA_VERSION = 1 as const;

/**
 * The terminal ledger carries its own wire version. Version 2 (BREAKING-L2-T,
 * delivered ATOMIC with the UA-1 packet v2) adds `unobservedRegions`, required:
 * parts of the page the scan reached but could not observe into. A region is
 * expressed separately from the questions -- it is neither required nor
 * optional, it holds no terminal, and nothing is ever written to it -- and the
 * parser ties it to `discoveryComplete`, so a ledger can never both list an
 * unobserved region and claim the page complete. Version 1 ledgers are rejected;
 * every producer and consumer lives in this repository and moved together.
 */
export const PILOT_UA4_LEDGER_SCHEMA_VERSION = 2 as const;

/**
 * Why a region could not be observed. Neutral and exactly what the scan knows:
 * `FRAME_NOT_OBSERVED` says a frame/iframe was reached unhidden and not
 * descended into. Whether it is same- or cross-origin was not checked and is
 * not claimed.
 */
export const PILOT_UA4_UNOBSERVED_REGION_REASONS = ['FRAME_NOT_OBSERVED'] as const;
export type PilotUa4UnobservedRegionReason = (typeof PILOT_UA4_UNOBSERVED_REGION_REASONS)[number];
export type PilotUa4UnobservedRegion = Readonly<{
  /** The producer's identity digest for the region; never a selector, src or title. */
  regionId: string;
  reason: PilotUa4UnobservedRegionReason;
}>;
export const PILOT_UA4_MAX_UNOBSERVED_REGIONS = 64 as const;
export const PILOT_UA4_TRIGGER = 'USER_EXACT_PAGE' as const;
export const PILOT_UA4_WRITE_AUTHORITY_ERROR_CODE =
  'PILOT_WRITE_AUTHORITY_INPUT_INVALID' as const;

export const PILOT_UA4_FAILURE_CODES = [
  'PILOT_CAPABILITY_DISABLED',
  'PILOT_WRITE_AUTHORITY_INPUT_INVALID',
  'PILOT_EPHEMERAL_RULE_EXPIRED',
  'PILOT_TARGET_DRIFT',
] as const;
export type PilotUa4FailureCode = (typeof PILOT_UA4_FAILURE_CODES)[number];

export const PILOT_UA4_CONTROL_KINDS = [
  'TEXT',
  'TEXTAREA',
  'CONTENTEDITABLE',
  'NATIVE_SELECT',
  'COMBOBOX',
  'RADIO_GROUP',
  'CHECKBOX_GROUP',
  'DATE',
  'FILE',
  'EDUCATION_ROW',
  'EXPERIENCE_ROW',
] as const;
export type PilotUa4ControlKind = (typeof PILOT_UA4_CONTROL_KINDS)[number];

export const PILOT_UA4_ANSWER_AUTHORITIES = [
  'PROFILE_CONFIRMED',
  'SCOPED_MEMORY_CONFIRMED',
  'USER_CONFIRMED',
] as const;
export type PilotUa4AnswerAuthority = (typeof PILOT_UA4_ANSWER_AUTHORITIES)[number];

export type PilotUa4Question = Readonly<{
  questionId: string;
  controlKind: PilotUa4ControlKind;
  /** Complete logical-group membership, not raw option values or labels. */
  identityDigests: readonly string[];
  required: boolean;
  /**
   * DEPRECATED, compatibility-only, and IGNORED.
   *
   * A digest minted by the caller binds to whatever Profile revision the CALLER
   * read, and this rung resolves the owner's Profile again -- so a digest from
   * an older read would be accepted under a newer authority. The authoritative
   * digest is therefore minted on the response side, from the one snapshot this
   * rung resolved, for a question that snapshot actually confirms.
   *
   * The field stays on the wire so an older caller keeps parsing, and the parser
   * accepts it, checks only that it is well formed, and then DISCARDS it: no
   * parsed request carries it, so no caller value can reach the authority, a
   * receipt, the ledger, or any writer decision. Omit it in new callers.
   */
  answerDigest?: string;
  /** A structure fact. `accept` and visible option text are never completeness proof. */
  optionsIncomplete: boolean;
}>;

export type PilotUa4WriteAuthorityRequest = Readonly<{
  schemaVersion: typeof PILOT_UA4_SCHEMA_VERSION;
  trigger: typeof PILOT_UA4_TRIGGER;
  candidateRule: PilotUa3CandidateRule;
  currentBinding: PilotUa1PageBinding;
  currentControlIdentityDigests: readonly string[];
  questions: readonly PilotUa4Question[];
}>;

/**
 * The authority is derived by the Answer Resolution composition from UA-2 classification
 * and owner-scoped Profile facts. It is never accepted from the caller: a request that
 * could name its own authority could mint `PROFILE_CONFIRMED` for any field.
 */
/**
 * The response side, where both the authority and the digest are minted from the
 * one Profile snapshot this rung resolved -- never carried over from a request.
 */
export type PilotUa4QuestionAuthorization = Readonly<
  Omit<PilotUa4Question, 'optionsIncomplete' | 'answerDigest'> & {
    answerAuthority: PilotUa4AnswerAuthority;
    /**
     * Value-free binding to the confirmed fact behind this authorization:
     * owner, Profile revision, deletion epoch, source ref and fact refs. The
     * answer itself never crosses this wire, and a digest minted against an
     * older read cannot be presented under a newer authority, because nothing
     * outside this rung mints one.
     */
    answerDigest: string;
  }
>;
export type PilotUa4BlockedQuestion =
  | Readonly<{
      questionId: string;
      controlKind: Extract<
        PilotUa4ControlKind,
        'NATIVE_SELECT' | 'COMBOBOX' | 'RADIO_GROUP' | 'CHECKBOX_GROUP'
      >;
      identityDigests: readonly string[];
      required: boolean;
      code: 'OPTIONS_INCOMPLETE';
    }>
  /** No confirmed first-party answer authority resolved for this question. */
  | Readonly<{
      questionId: string;
      controlKind: PilotUa4ControlKind;
      identityDigests: readonly string[];
      required: boolean;
      code: 'ANSWER_AUTHORITY_NOT_RESOLVED';
    }>;

export type PilotUa4WriteAuthority = Readonly<{
  authorityId: string;
  binding: PilotUa1PageBinding;
  pageIdentityDigest: string;
  /** Exact UA-1 observation set; authorizations may cover only an eligible subset. */
  observedControlIdentityDigests: readonly string[];
  expiresAtMs: number;
  questionAuthorizations: readonly PilotUa4QuestionAuthorization[];
  blockedQuestions: readonly PilotUa4BlockedQuestion[];
  constraints: Readonly<{
    exactTargetBinding: 'REQUIRED';
    semanticReadback: 'REQUIRED';
    hostValidation: 'REQUIRED';
    lateRecheck: 'REQUIRED';
    undo: 'REQUIRED' | 'FROZEN';
    submit: 'FORBIDDEN';
    activationState: 'DEFAULT_OFF';
    releaseState: 'NOT_RELEASED';
  }>;
}>;

export type PilotUa4WriteAuthorityResponse =
  | Readonly<{
      ok: true;
      schemaVersion: typeof PILOT_UA4_SCHEMA_VERSION;
      authority: PilotUa4WriteAuthority;
    }>
  | Readonly<{
      ok: false;
      schemaVersion: typeof PILOT_UA4_SCHEMA_VERSION;
      code: PilotUa4FailureCode;
    }>;

export const PILOT_UA4_TERMINAL_STATES = [
  'PREFILLED',
  'FILLED',
  'AI_SUGGESTED',
  'USER_CONFIRMATION_REQUIRED',
  'MANUAL_REQUIRED',
  'POLICY_BLOCKED',
  'DISCOVERY_INCOMPLETE',
] as const;
export type PilotUa4TerminalState = (typeof PILOT_UA4_TERMINAL_STATES)[number];

export type PilotUa4WriteEffect = 'MAY_HAVE_CHANGED';

export type PilotUa4FinalDisposition =
  | Readonly<{ state: 'PREFILLED'; semanticReadback: 'CURRENT' }>
  | Readonly<{
      state: 'FILLED';
      semanticReadback: 'HOST_ACCEPTED';
      lateRecheck: 'STABLE';
      undo: 'OWNED' | 'FROZEN';
    }>
  | Readonly<{
      state: 'AI_SUGGESTED';
      candidateDigest: string;
      provenance: 'SELF_OWNED_AI';
    }>
  | Readonly<{
      state: 'USER_CONFIRMATION_REQUIRED';
      reason: 'AI_SUGGESTION' | 'ANSWER_AUTHORITY_MISSING' | 'SENSITIVE_CONFIRMATION';
    }>
  | Readonly<{
      state: 'MANUAL_REQUIRED';
      reason:
        | 'PASSWORD'
        | 'OTP_OR_2FA'
        | 'CAPTCHA_OR_HUMAN_CHALLENGE'
        | 'LEGAL_OR_SUBSTANTIVE_AUTHORIZATION'
        | 'MARKETING_SUBSCRIPTION'
        | 'CONTACT_CURRENT_EMPLOYER'
        | 'OTHER_PERSON'
        | 'HUMAN_ACTION'
        | 'FINAL_SUBMIT';
    }>
  | Readonly<{
      state: 'POLICY_BLOCKED';
      /** A setter was attempted; inspect the host page before proceeding. */
      writeEffect?: PilotUa4WriteEffect;
      reason:
        | 'OPTIONS_INCOMPLETE'
        | 'ANSWER_AUTHORITY_UNAVAILABLE'
        | 'TARGET_NOT_ELIGIBLE'
        | 'EXACT_TARGET_DRIFT'
        | 'HOST_REJECTED'
        | 'LATE_REVERTED'
        | 'UNDO_UNAVAILABLE'
        | 'WRITER_EXECUTION_FAILED';
    }>
  | Readonly<{
      state: 'DISCOVERY_INCOMPLETE';
      reachability:
        | 'CROSS_ORIGIN_IFRAME_UNREACHABLE'
        | 'FUTURE_STEP_NOT_OPENED'
        | 'DISCOVERY_BUDGET_EXHAUSTED'
        | 'DOM_GENERATION_CHANGED';
    }>;

export type PilotUa4TerminalLedger = Readonly<{
  schemaVersion: typeof PILOT_UA4_LEDGER_SCHEMA_VERSION;
  binding: PilotUa1PageBinding;
  /**
   * False whenever any question is DISCOVERY_INCOMPLETE or any region was not
   * observed. The parser enforces the equivalence in both directions.
   */
  discoveryComplete: boolean;
  /** Question/group denominator for this exact DOM generation. */
  questions: readonly Readonly<{ questionId: string; required: boolean }>[];
  dispositions: readonly Readonly<{
    questionId: string;
    disposition: PilotUa4FinalDisposition;
  }>[];
  /**
   * Parts of the page the scan reached but could not observe into. Not
   * questions: no required/optional, no terminal, never written. Their presence
   * is what makes `requiredFieldFinalDispositionCoverage` a statement about the
   * OBSERVED questions only, never about the page.
   */
  unobservedRegions: readonly PilotUa4UnobservedRegion[];
  summary: Readonly<{
    observableQuestions: number;
    requiredQuestions: number;
    terminalQuestions: number;
    terminalRequiredQuestions: number;
    /** Over observed questions only; see `unobservedRegions` and `discoveryComplete`. */
    requiredFieldFinalDispositionCoverage: 100;
    unobservedRegions: number;
  }>;
}>;

export type PilotUa4ParseResult<T> =
  | Readonly<{ ok: true; value: T }>
  | Readonly<{ ok: false; code: typeof PILOT_UA4_WRITE_AUTHORITY_ERROR_CODE }>;

type DataValues = Readonly<Record<string, unknown>>;
const SHA256_HEX = /^[a-f0-9]{64}$/;
const SAFE_ID = /^[A-Za-z0-9._:-]{1,128}$/;
const CONTROL_KINDS = new Set<string>(PILOT_UA4_CONTROL_KINDS);
const ANSWER_AUTHORITIES = new Set<string>(PILOT_UA4_ANSWER_AUTHORITIES);
const FAILURE_CODES = new Set<string>(PILOT_UA4_FAILURE_CODES);
const OPTIONS_KINDS = new Set<PilotUa4ControlKind>([
  'NATIVE_SELECT', 'COMBOBOX', 'RADIO_GROUP', 'CHECKBOX_GROUP',
]);

function failure<T>(): PilotUa4ParseResult<T> {
  return Object.freeze({ ok: false, code: PILOT_UA4_WRITE_AUTHORITY_ERROR_CODE });
}

function exactDataValues(value: unknown, keys: readonly string[]): DataValues | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return null;
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.length !== keys.length || ownKeys.some(
    (key) => typeof key !== 'string' || !keys.includes(key),
  )) return null;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const copy: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of keys) {
    const descriptor = descriptors[key];
    if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) return null;
    copy[key] = descriptor.value;
  }
  return copy;
}

function exactArray(value: unknown, max: number): readonly unknown[] | null {
  if (!Array.isArray(value)) return null;
  const length = Object.getOwnPropertyDescriptor(value, 'length')?.value;
  if (!Number.isSafeInteger(length) || length < 0 || length > max) return null;
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.length !== length + 1 || ownKeys.some((key) => typeof key !== 'string')) return null;
  const result: unknown[] = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) return null;
    result.push(descriptor.value);
  }
  return Object.freeze(result);
}

function parseBinding(value: unknown): PilotUa1PageBinding | null {
  const parsed = parsePilotUa1DiscoveryPacket({ schemaVersion: PILOT_UA1_SCHEMA_VERSION, binding: value, controls: [], observation: { suppressedControls: [], hiddenNotObservedCount: 0, opaqueBoundaries: [] } });
  return parsed.ok ? parsed.value.binding : null;
}

function parseDigestArray(value: unknown, allowEmpty = false): readonly string[] | null {
  const source = exactArray(value, 500);
  if (!source || (!allowEmpty && source.length === 0)) return null;
  const seen = new Set<string>();
  const result: string[] = [];
  for (const item of source) {
    if (typeof item !== 'string' || !SHA256_HEX.test(item) || seen.has(item)) return null;
    seen.add(item);
    result.push(item);
  }
  return Object.freeze(result);
}

const QUESTION_KEYS = [
  'questionId', 'controlKind', 'identityDigests', 'required', 'optionsIncomplete',
] as const;

/**
 * True when the caller sent the deprecated `answerDigest`. Read as an own
 * enumerable data property, so a getter or an inherited key is not mistaken for
 * one and cannot run during parsing.
 */
function carriesDeprecatedAnswerDigest(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false;
  const descriptor = Object.getOwnPropertyDescriptor(value, 'answerDigest');
  return descriptor !== undefined && 'value' in descriptor && descriptor.enumerable === true;
}

function parseQuestion(value: unknown): PilotUa4Question | null {
  // An older caller still sends the deprecated digest. It is accepted, checked
  // for shape so a malformed request is still refused exactly as before, and
  // then dropped: the parsed question below never carries it.
  const deprecated = carriesDeprecatedAnswerDigest(value);
  const fields = exactDataValues(
    value,
    deprecated ? [...QUESTION_KEYS, 'answerDigest'] : QUESTION_KEYS,
  );
  if (
    !fields ||
    (deprecated && (typeof fields.answerDigest !== 'string' || !SHA256_HEX.test(fields.answerDigest))) ||
    typeof fields.questionId !== 'string' || !SAFE_ID.test(fields.questionId) ||
    typeof fields.controlKind !== 'string' || !CONTROL_KINDS.has(fields.controlKind) ||
    typeof fields.required !== 'boolean' ||
    typeof fields.optionsIncomplete !== 'boolean'
  ) return null;
  const controlKind = fields.controlKind as PilotUa4ControlKind;
  if (fields.optionsIncomplete && !OPTIONS_KINDS.has(controlKind)) return null;
  const identityDigests = parseDigestArray(fields.identityDigests);
  if (!identityDigests) return null;
  return Object.freeze({
    questionId: fields.questionId,
    controlKind,
    identityDigests,
    required: fields.required,
    optionsIncomplete: fields.optionsIncomplete,
  });
}

function parseQuestions(value: unknown): readonly PilotUa4Question[] | null {
  const source = exactArray(value, 500);
  if (!source) return null;
  const ids = new Set<string>();
  const identities = new Set<string>();
  const result: PilotUa4Question[] = [];
  for (const item of source) {
    const question = parseQuestion(item);
    if (!question || ids.has(question.questionId)) return null;
    if (question.identityDigests.some((identity) => identities.has(identity))) return null;
    ids.add(question.questionId);
    question.identityDigests.forEach((identity) => identities.add(identity));
    result.push(question);
  }
  return Object.freeze(result);
}

function sameDigestSet(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value) => right.includes(value));
}

export function parsePilotUa4WriteAuthorityRequest(
  value: unknown,
): PilotUa4ParseResult<PilotUa4WriteAuthorityRequest> {
  try {
    const fields = exactDataValues(value, [
      'schemaVersion',
      'trigger',
      'candidateRule',
      'currentBinding',
      'currentControlIdentityDigests',
      'questions',
    ]);
    if (!fields || fields.schemaVersion !== 1 || fields.trigger !== PILOT_UA4_TRIGGER) return failure();
    const candidateRule = parsePilotUa3CandidateRule(fields.candidateRule);
    const currentBinding = parseBinding(fields.currentBinding);
    const currentIdentities = parseDigestArray(fields.currentControlIdentityDigests, true);
    const questions = parseQuestions(fields.questions);
    if (!candidateRule.ok || !currentBinding || !currentIdentities || !questions) return failure();
    const candidateIdentities = candidateRule.value.classifications.map((item) => item.identityDigest);
    const groupedIdentities = questions.flatMap((question) => question.identityDigests);
    if (
      candidateRule.value.binding.origin !== currentBinding.origin ||
      candidateRule.value.binding.pathname !== currentBinding.pathname ||
      candidateRule.value.binding.domGeneration !== currentBinding.domGeneration ||
      !sameDigestSet(candidateIdentities, currentIdentities) ||
      groupedIdentities.some((identity) => !currentIdentities.includes(identity))
    ) return failure();
    return Object.freeze({
      ok: true,
      value: Object.freeze({
        schemaVersion: 1,
        trigger: PILOT_UA4_TRIGGER,
        candidateRule: candidateRule.value,
        currentBinding,
        currentControlIdentityDigests: currentIdentities,
        questions,
      }),
    });
  } catch {
    return failure();
  }
}

function parseConstraints(value: unknown): PilotUa4WriteAuthority['constraints'] | null {
  const fields = exactDataValues(value, [
    'exactTargetBinding', 'semanticReadback', 'hostValidation', 'lateRecheck', 'undo',
    'submit', 'activationState', 'releaseState',
  ]);
  if (
    !fields ||
    fields.exactTargetBinding !== 'REQUIRED' ||
    fields.semanticReadback !== 'REQUIRED' ||
    fields.hostValidation !== 'REQUIRED' ||
    fields.lateRecheck !== 'REQUIRED' ||
    (fields.undo !== 'REQUIRED' && fields.undo !== 'FROZEN') ||
    fields.submit !== 'FORBIDDEN' ||
    fields.activationState !== 'DEFAULT_OFF' ||
    fields.releaseState !== 'NOT_RELEASED'
  ) return null;
  return Object.freeze({
    exactTargetBinding: 'REQUIRED',
    semanticReadback: 'REQUIRED',
    hostValidation: 'REQUIRED',
    lateRecheck: 'REQUIRED',
    undo: fields.undo,
    submit: 'FORBIDDEN',
    activationState: 'DEFAULT_OFF',
    releaseState: 'NOT_RELEASED',
  });
}

function parseAuthorization(value: unknown): PilotUa4QuestionAuthorization | null {
  const fields = exactDataValues(value, [
    'questionId', 'controlKind', 'identityDigests', 'required', 'answerAuthority', 'answerDigest',
  ]);
  if (
    !fields ||
    typeof fields.answerAuthority !== 'string' ||
    !ANSWER_AUTHORITIES.has(fields.answerAuthority) ||
    // Validated here rather than through the request shape: the request has no
    // such field, and a digest only exists once this rung has minted one.
    typeof fields.answerDigest !== 'string' || !SHA256_HEX.test(fields.answerDigest)
  ) return null;
  const { answerAuthority, answerDigest, ...questionFields } = fields;
  const question = parseQuestion({ ...questionFields, optionsIncomplete: false });
  if (!question) return null;
  const { optionsIncomplete: _ignored, ...rest } = question;
  return Object.freeze({
    ...rest,
    answerAuthority: answerAuthority as PilotUa4AnswerAuthority,
    answerDigest,
  });
}

function parseBlocked(value: unknown): PilotUa4BlockedQuestion | null {
  const fields = exactDataValues(value, [
    'questionId', 'controlKind', 'identityDigests', 'required', 'code',
  ]);
  if (
    !fields ||
    typeof fields.questionId !== 'string' || !SAFE_ID.test(fields.questionId) ||
    typeof fields.controlKind !== 'string' || !CONTROL_KINDS.has(fields.controlKind) ||
    typeof fields.required !== 'boolean' ||
    (fields.code !== 'OPTIONS_INCOMPLETE' && fields.code !== 'ANSWER_AUTHORITY_NOT_RESOLVED') ||
    (fields.code === 'OPTIONS_INCOMPLETE'
      && !OPTIONS_KINDS.has(fields.controlKind as PilotUa4ControlKind))
  ) return null;
  const identityDigests = parseDigestArray(fields.identityDigests);
  if (!identityDigests) return null;
  return Object.freeze({
    questionId: fields.questionId,
    controlKind: fields.controlKind as PilotUa4BlockedQuestion['controlKind'],
    identityDigests,
    required: fields.required,
    code: fields.code as PilotUa4BlockedQuestion['code'],
  }) as PilotUa4BlockedQuestion;
}

function parseAuthority(value: unknown): PilotUa4WriteAuthority | null {
  const fields = exactDataValues(value, [
    'authorityId', 'binding', 'pageIdentityDigest', 'observedControlIdentityDigests', 'expiresAtMs',
    'questionAuthorizations', 'blockedQuestions', 'constraints',
  ]);
  if (
    !fields ||
    typeof fields.authorityId !== 'string' || !SHA256_HEX.test(fields.authorityId) ||
    typeof fields.pageIdentityDigest !== 'string' || !SHA256_HEX.test(fields.pageIdentityDigest) ||
    typeof fields.expiresAtMs !== 'number' || !Number.isSafeInteger(fields.expiresAtMs) ||
    fields.expiresAtMs < 0
  ) return null;
  const binding = parseBinding(fields.binding);
  const observedControlIdentityDigests = parseDigestArray(fields.observedControlIdentityDigests, true);
  const constraints = parseConstraints(fields.constraints);
  const authorizationSource = exactArray(fields.questionAuthorizations, 500);
  const blockedSource = exactArray(fields.blockedQuestions, 500);
  if (!binding || !observedControlIdentityDigests || !constraints || !authorizationSource || !blockedSource) return null;
  const authorizations: PilotUa4QuestionAuthorization[] = [];
  const blocked: PilotUa4BlockedQuestion[] = [];
  const questionIds = new Set<string>();
  const identities = new Set<string>();
  for (const item of authorizationSource) {
    const authorization = parseAuthorization(item);
    if (!authorization || questionIds.has(authorization.questionId)) return null;
    if (authorization.identityDigests.some((identity) => identities.has(identity))) return null;
    questionIds.add(authorization.questionId);
    authorization.identityDigests.forEach((identity) => identities.add(identity));
    authorizations.push(authorization);
  }
  for (const item of blockedSource) {
    const blockedQuestion = parseBlocked(item);
    if (!blockedQuestion || questionIds.has(blockedQuestion.questionId)) return null;
    if (blockedQuestion.identityDigests.some((identity) => identities.has(identity))) return null;
    questionIds.add(blockedQuestion.questionId);
    blockedQuestion.identityDigests.forEach((identity) => identities.add(identity));
    blocked.push(blockedQuestion);
  }
  if ([...identities].some((identity) => !observedControlIdentityDigests.includes(identity))) return null;
  return Object.freeze({
    authorityId: fields.authorityId,
    binding,
    pageIdentityDigest: fields.pageIdentityDigest,
    observedControlIdentityDigests,
    expiresAtMs: fields.expiresAtMs,
    questionAuthorizations: Object.freeze(authorizations),
    blockedQuestions: Object.freeze(blocked),
    constraints,
  });
}

export function parsePilotUa4WriteAuthorityResponse(
  value: unknown,
): PilotUa4ParseResult<PilotUa4WriteAuthorityResponse> {
  try {
    const failed = exactDataValues(value, ['ok', 'schemaVersion', 'code']);
    if (failed) {
      if (
        failed.ok !== false || failed.schemaVersion !== 1 ||
        typeof failed.code !== 'string' || !FAILURE_CODES.has(failed.code)
      ) return failure();
      return Object.freeze({
        ok: true,
        value: Object.freeze({
          ok: false,
          schemaVersion: 1,
          code: failed.code as PilotUa4FailureCode,
        }),
      });
    }
    const fields = exactDataValues(value, ['ok', 'schemaVersion', 'authority']);
    if (!fields || fields.ok !== true || fields.schemaVersion !== 1) return failure();
    const authority = parseAuthority(fields.authority);
    if (!authority) return failure();
    return Object.freeze({
      ok: true,
      value: Object.freeze({ ok: true, schemaVersion: 1, authority }),
    });
  } catch {
    return failure();
  }
}

export function pilotUa4AuthorityMatchesLivePage(
  authorityValue: unknown,
  bindingValue: unknown,
  currentControlIdentityDigests: unknown,
  nowMs: unknown,
): boolean {
  try {
    const parsed = parsePilotUa4WriteAuthorityResponse({
      ok: true,
      schemaVersion: 1,
      authority: authorityValue,
    });
    const binding = parseBinding(bindingValue);
    const identities = parseDigestArray(currentControlIdentityDigests, true);
    if (
      !parsed.ok || !parsed.value.ok || !binding || !identities ||
      typeof nowMs !== 'number' || !Number.isSafeInteger(nowMs) || nowMs < 0 ||
      nowMs >= parsed.value.authority.expiresAtMs
    ) return false;
    const authority = parsed.value.authority;
    return authority.binding.origin === binding.origin &&
      authority.binding.pathname === binding.pathname &&
      authority.binding.domGeneration === binding.domGeneration &&
      sameDigestSet(authority.observedControlIdentityDigests, identities);
  } catch {
    return false;
  }
}

/** Shared canonical terminal decoder for value-free checkpoint projections. */
export function parsePilotUa4FinalDisposition(value: unknown): PilotUa4FinalDisposition | null {
  try { return parseDisposition(value); } catch { return null; }
}

function parseDisposition(value: unknown): PilotUa4FinalDisposition | null {
  const state = exactDataValues(value, ['state', 'semanticReadback']);
  if (state?.state === 'PREFILLED' && state.semanticReadback === 'CURRENT') {
    return Object.freeze({ state: 'PREFILLED', semanticReadback: 'CURRENT' });
  }
  const filled = exactDataValues(value, ['state', 'semanticReadback', 'lateRecheck', 'undo']);
  if (
    filled?.state === 'FILLED' && filled.semanticReadback === 'HOST_ACCEPTED' &&
    filled.lateRecheck === 'STABLE' && (filled.undo === 'OWNED' || filled.undo === 'FROZEN')
  ) return Object.freeze({
    state: 'FILLED', semanticReadback: 'HOST_ACCEPTED', lateRecheck: 'STABLE', undo: filled.undo,
  });
  const suggested = exactDataValues(value, ['state', 'candidateDigest', 'provenance']);
  if (
    suggested?.state === 'AI_SUGGESTED' &&
    typeof suggested.candidateDigest === 'string' && SHA256_HEX.test(suggested.candidateDigest) &&
    suggested.provenance === 'SELF_OWNED_AI'
  ) return Object.freeze({
    state: 'AI_SUGGESTED',
    candidateDigest: suggested.candidateDigest,
    provenance: 'SELF_OWNED_AI',
  });
  const changed = exactDataValues(value, ['state', 'reason', 'writeEffect']);
  if (changed && (changed.state !== 'POLICY_BLOCKED' || changed.writeEffect !== 'MAY_HAVE_CHANGED')) return null;
  const reasoned = exactDataValues(value, ['state', 'reason']) ?? changed;
  if (!reasoned || typeof reasoned.reason !== 'string') {
    const incomplete = exactDataValues(value, ['state', 'reachability']);
    if (
      incomplete?.state !== 'DISCOVERY_INCOMPLETE' ||
      ![
        'CROSS_ORIGIN_IFRAME_UNREACHABLE',
        'FUTURE_STEP_NOT_OPENED',
        'DISCOVERY_BUDGET_EXHAUSTED',
        'DOM_GENERATION_CHANGED',
      ].includes(incomplete.reachability as string)
    ) return null;
    return Object.freeze({
      state: 'DISCOVERY_INCOMPLETE',
      reachability: incomplete.reachability as Extract<
        PilotUa4FinalDisposition,
        { state: 'DISCOVERY_INCOMPLETE' }
      >['reachability'],
    });
  }
  if (
    reasoned.state === 'USER_CONFIRMATION_REQUIRED' &&
    ['AI_SUGGESTION', 'ANSWER_AUTHORITY_MISSING', 'SENSITIVE_CONFIRMATION'].includes(reasoned.reason)
  ) return Object.freeze({
    state: 'USER_CONFIRMATION_REQUIRED',
    reason: reasoned.reason as Extract<
      PilotUa4FinalDisposition,
      { state: 'USER_CONFIRMATION_REQUIRED' }
    >['reason'],
  });
  if (
    reasoned.state === 'MANUAL_REQUIRED' &&
    [
      'PASSWORD', 'OTP_OR_2FA', 'CAPTCHA_OR_HUMAN_CHALLENGE',
      'LEGAL_OR_SUBSTANTIVE_AUTHORIZATION', 'MARKETING_SUBSCRIPTION',
      'CONTACT_CURRENT_EMPLOYER', 'OTHER_PERSON', 'HUMAN_ACTION', 'FINAL_SUBMIT',
    ].includes(reasoned.reason)
  ) return Object.freeze({
    state: 'MANUAL_REQUIRED',
    reason: reasoned.reason as Extract<
      PilotUa4FinalDisposition,
      { state: 'MANUAL_REQUIRED' }
    >['reason'],
  });
  if (
    reasoned.state === 'POLICY_BLOCKED' &&
    [
      'OPTIONS_INCOMPLETE', 'ANSWER_AUTHORITY_UNAVAILABLE', 'TARGET_NOT_ELIGIBLE',
      'EXACT_TARGET_DRIFT', 'HOST_REJECTED', 'LATE_REVERTED', 'UNDO_UNAVAILABLE',
      'WRITER_EXECUTION_FAILED',
    ].includes(reasoned.reason)
  ) return Object.freeze({
    state: 'POLICY_BLOCKED',
    ...(changed ? { writeEffect: 'MAY_HAVE_CHANGED' as const } : {}),
    reason: reasoned.reason as Extract<
      PilotUa4FinalDisposition,
      { state: 'POLICY_BLOCKED' }
    >['reason'],
  });
  return null;
}

const UNOBSERVED_REGION_REASONS = new Set<string>(PILOT_UA4_UNOBSERVED_REGION_REASONS);

/**
 * Regions are identities plus a neutral reason, unique among themselves and
 * disjoint from the question ids they sit beside. Shared by the ledger and the
 * run projection so the two cannot drift on what a region is.
 */
export function parseUnobservedRegions(
  source: readonly unknown[],
  takenIds: ReadonlySet<string>,
): readonly PilotUa4UnobservedRegion[] | null {
  const regions: PilotUa4UnobservedRegion[] = [];
  const seen = new Set<string>();
  for (const item of source) {
    const region = exactDataValues(item, ['regionId', 'reason']);
    if (
      !region || typeof region.regionId !== 'string' || !SAFE_ID.test(region.regionId) ||
      seen.has(region.regionId) || takenIds.has(region.regionId) ||
      typeof region.reason !== 'string' || !UNOBSERVED_REGION_REASONS.has(region.reason)
    ) return null;
    seen.add(region.regionId);
    regions.push(Object.freeze({
      regionId: region.regionId,
      reason: region.reason as PilotUa4UnobservedRegionReason,
    }));
  }
  return Object.freeze(regions);
}

export function parsePilotUa4TerminalLedger(
  value: unknown,
): PilotUa4ParseResult<PilotUa4TerminalLedger> {
  try {
    const fields = exactDataValues(value, [
      'schemaVersion', 'binding', 'discoveryComplete', 'questions', 'dispositions',
      'unobservedRegions', 'summary',
    ]);
    if (
      !fields ||
      fields.schemaVersion !== PILOT_UA4_LEDGER_SCHEMA_VERSION ||
      typeof fields.discoveryComplete !== 'boolean'
    ) return failure();
    const binding = parseBinding(fields.binding);
    const questionSource = exactArray(fields.questions, 500);
    const dispositionSource = exactArray(fields.dispositions, 500);
    const regionSource = exactArray(fields.unobservedRegions, PILOT_UA4_MAX_UNOBSERVED_REGIONS);
    const summary = exactDataValues(fields.summary, [
      'observableQuestions', 'requiredQuestions', 'terminalQuestions',
      'terminalRequiredQuestions', 'requiredFieldFinalDispositionCoverage', 'unobservedRegions',
    ]);
    if (!binding || !questionSource || !dispositionSource || !regionSource || !summary) return failure();
    const questions: Array<Readonly<{ questionId: string; required: boolean }>> = [];
    const questionIds = new Set<string>();
    for (const item of questionSource) {
      const question = exactDataValues(item, ['questionId', 'required']);
      if (
        !question || typeof question.questionId !== 'string' || !SAFE_ID.test(question.questionId) ||
        typeof question.required !== 'boolean' || questionIds.has(question.questionId)
      ) return failure();
      questionIds.add(question.questionId);
      questions.push(Object.freeze({ questionId: question.questionId, required: question.required }));
    }
    const dispositions: Array<Readonly<{
      questionId: string;
      disposition: PilotUa4FinalDisposition;
    }>> = [];
    const dispositionIds = new Set<string>();
    let hasIncomplete = false;
    for (const item of dispositionSource) {
      const entry = exactDataValues(item, ['questionId', 'disposition']);
      if (
        !entry || typeof entry.questionId !== 'string' || !questionIds.has(entry.questionId) ||
        dispositionIds.has(entry.questionId)
      ) return failure();
      const disposition = parseDisposition(entry.disposition);
      if (!disposition) return failure();
      if (disposition.state === 'DISCOVERY_INCOMPLETE') hasIncomplete = true;
      dispositionIds.add(entry.questionId);
      dispositions.push(Object.freeze({ questionId: entry.questionId, disposition }));
    }
    const regions = parseUnobservedRegions(regionSource, questionIds);
    if (regions === null) return failure();
    const requiredQuestions = questions.filter((question) => question.required).length;
    const terminalRequiredQuestions = questions.filter(
      (question) => question.required && dispositionIds.has(question.questionId),
    ).length;
    // Incomplete in either way -- a question that was never reached, or a region
    // that was never observed -- and the claim must say so; complete, and it
    // must have neither. No third combination parses.
    const incomplete = hasIncomplete || regions.length > 0;
    if (
      dispositionIds.size !== questionIds.size ||
      fields.discoveryComplete === incomplete ||
      summary.observableQuestions !== questions.length ||
      summary.requiredQuestions !== requiredQuestions ||
      summary.terminalQuestions !== dispositions.length ||
      summary.terminalRequiredQuestions !== terminalRequiredQuestions ||
      summary.requiredFieldFinalDispositionCoverage !== 100 ||
      summary.unobservedRegions !== regions.length
    ) return failure();
    return Object.freeze({
      ok: true,
      value: Object.freeze({
        schemaVersion: PILOT_UA4_LEDGER_SCHEMA_VERSION,
        binding,
        discoveryComplete: fields.discoveryComplete,
        questions: Object.freeze(questions),
        dispositions: Object.freeze(dispositions),
        unobservedRegions: regions,
        summary: Object.freeze({
          observableQuestions: questions.length,
          requiredQuestions,
          terminalQuestions: dispositions.length,
          terminalRequiredQuestions,
          requiredFieldFinalDispositionCoverage: 100,
          unobservedRegions: regions.length,
        }),
      }),
    });
  } catch {
    return failure();
  }
}

/** Reuse the existing strict shapes at the P1 original-source boundary. */
export function parsePilotUa4PageBinding(value: unknown): PilotUa1PageBinding | null {
  try { return parseBinding(value); } catch { return null; }
}
export function parsePilotUa4QuestionAuthorization(value: unknown): PilotUa4QuestionAuthorization | null {
  try { return parseAuthorization(value); } catch { return null; }
}
