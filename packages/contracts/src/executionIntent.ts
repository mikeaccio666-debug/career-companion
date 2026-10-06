/** ExecutionIntent/JWKS/claim/receipt wire types from AGENT-API-CONTRACT.md §5. */

import type {
  AgentErrorCode,
  AgentSchemaEnvelope,
  DecimalString,
  IsoDateTime,
  Sha256Digest,
  Uuid,
} from './common.ts';
import type {
  AtsProviderCode,
  AutomationLevel,
  ExecutionAllowedAction,
  MissionStatus,
  SourcePlatformCode,
} from './missions.ts';
import type {
  ActualSensitiveItemsV2,
  Base64Url43,
  IsoCountryCode,
  OneToTwenty,
  SafeToken,
  SensitiveWriteReleaseRefV1,
} from './sensitiveWrite.ts';

/** §5.3 positive provider allowlist; unknown/new providers remain non-executable. */
export const EXECUTION_INTENT_EXECUTABLE_ATS_PROVIDER_CODES = [
  'ASHBY',
  // 2026-09-24 追加（argoland 权威，本仓镜像）：运行时包早已映射并放行这三家。
  'BAMBOOHR',
  'GREENHOUSE',
  'LEVER',
  'SMARTRECRUITERS',
  'WORKABLE',
  'WORKDAY',
] as const satisfies readonly AtsProviderCode[];
export type ExecutionIntentExecutableAtsProviderV1 =
  (typeof EXECUTION_INTENT_EXECUTABLE_ATS_PROVIDER_CODES)[number];

export const EXECUTION_INTENT_ATS_PROVIDER_DENIAL_CODE =
  'EXECUTION_INTENT_NOT_ALLOWED' as const satisfies AgentErrorCode;

const EXECUTABLE_ATS_PROVIDERS = new Set<string>(
  EXECUTION_INTENT_EXECUTABLE_ATS_PROVIDER_CODES,
);

export function isExecutionIntentAtsProviderExecutable(
  provider: AtsProviderCode,
): provider is ExecutionIntentExecutableAtsProviderV1 {
  return EXECUTABLE_ATS_PROVIDERS.has(provider);
}

export const EXECUTION_INTENT_VERSION = 1 as const;
export const EXECUTION_INTENT_VERSION_V2 = 2 as const;
export const EXECUTION_INTENT_ALGORITHM = 'ES256' as const;
export const EXECUTION_INTENT_TYPE = 'edaix-execution-intent+jwt' as const;
export const EXECUTION_INTENT_AUDIENCE = 'edaix-job-agent-extension' as const;

export type CompactExecutionIntent = string;
export type CanonicalHttpsOrigin = string;

export interface ExecutionIntentProtectedHeader {
  readonly alg: typeof EXECUTION_INTENT_ALGORITHM;
  readonly kid: string;
  readonly typ: typeof EXECUTION_INTENT_TYPE;
  readonly crit?: never;
  readonly b64?: never;
  readonly jku?: never;
  readonly x5u?: never;
}

/** §5.2 GET /.well-known/edaix-execution-intent-jwks.json */
export interface ExecutionIntentPublicJwk {
  readonly kty: 'EC';
  readonly crv: 'P-256';
  readonly use: 'sig';
  readonly alg: typeof EXECUTION_INTENT_ALGORITHM;
  readonly kid: string;
  readonly x: string;
  readonly y: string;
  /** Public key responses must never contain the EC private scalar. */
  readonly d?: never;
}

export interface GetExecutionIntentJwksResponse {
  readonly keys: readonly ExecutionIntentPublicJwk[];
}

export interface ExecutionTargetClaims {
  readonly jobId: string;
  readonly sourcePlatform: SourcePlatformCode;
  readonly atsProvider: AtsProviderCode;
  readonly canonicalOrigin: CanonicalHttpsOrigin;
  readonly pathRuleId: string;
  readonly postingFingerprint: Sha256Digest;
}

export interface ExecutionProfileSnapshotClaims {
  readonly revision: DecimalString;
  readonly deletionEpoch: DecimalString;
  readonly snapshotDigest: Sha256Digest;
}

export interface ExecutionResumeSnapshotClaims {
  readonly versionId: Uuid;
  readonly contentHash: Sha256Digest;
  readonly contentRevision: DecimalString;
  readonly libraryRevision: DecimalString;
}

/** §5.3 compact-JWS payload, version 1. */
export interface ExecutionIntentClaims {
  readonly ver: typeof EXECUTION_INTENT_VERSION;
  readonly iss: string;
  readonly aud: typeof EXECUTION_INTENT_AUDIENCE;
  readonly sub: Uuid;
  /** 精确 43 字符 base64url（≥256bit 随机），不是 UUID（§5.4 切片 e4191043）。 */
  readonly jti: Base64Url43;
  readonly iat: number;
  readonly nbf: number;
  readonly exp: number;
  readonly missionId: Uuid;
  /**
   * **签发后**的 mission revision，等于请求里那个 R **加一**。
   *
   * §5.4 签发时会新建一个 execution step，那次写入使 revision 从 R 走到 R+1。
   * 拿它跟 `IssueExecutionIntentRequest.missionRevision` 比对**必然不等**。
   */
  readonly missionRevision: DecimalString;
  /**
   * **execution step** 的 id——签发时新建的那一个，不是请求里的 approval step。
   *
   * ⚠️ 同名不同物（§5.4 切片 e4191043）：`IssueExecutionIntentRequest.missionStepId`
   * 是用户批准的那一步（approval step），这里的是为本次执行新建的那一步
   * （execution step）。两者**必然不相等**——拿它们做相等核对是错的，
   * 会把每一次合法签发都拒掉。本仓曾经就是这么写的，2026-08-15 按源契约删掉。
   *
   * 需要核对时只能核 {@link ExecutionIntentClaims.missionId}。
   */
  readonly missionStepId: Uuid;
  readonly stepAttempt: number;
  readonly intentVersion: number;
  readonly extensionInstallId: Uuid;
  readonly target: ExecutionTargetClaims;
  readonly fieldKeys: readonly string[];
  readonly fieldSchemaVersion: number;
  readonly automationLevel: AutomationLevel;
  readonly allowedActions: readonly ExecutionAllowedAction[];
  readonly planDigest: Sha256Digest;
  readonly approvalMessageId: Uuid;
  readonly profile: ExecutionProfileSnapshotClaims;
  readonly resume: ExecutionResumeSnapshotClaims;
  readonly policyVersion: string;
  readonly killSwitchVersion: string;
  readonly consentVersion: string;

  /** Data-L1 tripwires: claims contain identifiers/hashes only, never values. */
  readonly values?: never;
  readonly answers?: never;
  readonly resumeText?: never;
  readonly jobDescription?: never;
  readonly cookie?: never;
  readonly otp?: never;
}

/** §5.9.6 compact-JWS payload common allowlist, version 2. */
export interface ExecutionIntentTargetClaimsV2 {
  readonly jobId: string;
  readonly sourcePlatform: SourcePlatformCode;
  readonly atsProvider: AtsProviderCode;
  readonly canonicalOrigin: CanonicalHttpsOrigin;
  readonly pathRuleId: SafeToken;
  readonly postingFingerprint: Sha256Digest;
  readonly targetCountryCode: IsoCountryCode;
}

export interface ExecutionIntentCommonV2 {
  readonly ver: typeof EXECUTION_INTENT_VERSION_V2;
  readonly iss: string;
  readonly aud: typeof EXECUTION_INTENT_AUDIENCE;
  readonly sub: Uuid;
  readonly jti: Base64Url43;
  readonly iat: number;
  readonly nbf: number;
  readonly exp: number;
  readonly missionId: Uuid;
  readonly missionRevision: DecimalString;
  readonly missionStepId: Uuid;
  readonly stepAttempt: number;
  readonly intentVersion: number;
  readonly extensionInstallId: Uuid;
  readonly target: ExecutionIntentTargetClaimsV2;
  readonly automationLevel:
    | 'L1_FILL_STOP_BEFORE_SUBMIT'
    | 'L2_CONFIRM_EACH_SUBMISSION'
    | 'L3_MANAGED_BATCH';
  readonly planDigest: Sha256Digest;
  readonly approvalMessageId: Uuid;
  readonly resume: ExecutionResumeSnapshotClaims;
  readonly policyVersion: SafeToken;
  readonly killSwitchVersion: DecimalString;
  /** Job-automation consent only; it is not sensitive-write consent. */
  readonly consentVersion: SafeToken;

  readonly values?: never;
  readonly answers?: never;
  readonly statementText?: never;
  readonly statementDigest?: never;
  readonly resumeText?: never;
  readonly jobDescription?: never;
  readonly cookie?: never;
  readonly otp?: never;
}

export type ExecutionIntentSensitiveVariantV2 =
  | {
      readonly executionMode: 'STANDARD';
      readonly fieldSchemaVersion: 1;
      readonly fieldKeys: readonly ApplicationProfileFieldKey[];
      readonly profile: ExecutionProfileSnapshotClaims;
      readonly allowedActions: readonly ('FILL' | 'SUBMIT' | 'DISCOVER_SENSITIVE')[];
      readonly sensitiveWriteRelease: null;
      readonly releaseItemIds: readonly [];
      readonly basePlanDigest?: never;
      readonly sensitiveSettingRevision?: never;
      readonly sensitiveConsentVersion?: never;
      readonly sensitiveReleasePolicyVersion?: never;
      readonly uiCopyVersion?: never;
    }
  | {
      readonly executionMode: 'SENSITIVE_RELEASE';
      readonly allowedActions: readonly ['FILL_SENSITIVE'];
      readonly sensitiveWriteRelease: SensitiveWriteReleaseRefV1;
      readonly releaseItemIds: OneToTwenty<Uuid>;
      readonly basePlanDigest: Sha256Digest;
      readonly sensitiveSettingRevision: DecimalString;
      readonly sensitiveConsentVersion: SafeToken;
      readonly sensitiveReleasePolicyVersion: SafeToken;
      readonly uiCopyVersion: SafeToken;
      readonly fieldSchemaVersion?: never;
      readonly fieldKeys?: never;
      readonly profile?: never;
    };

export type ExecutionIntentPayloadV2 = ExecutionIntentCommonV2 &
  ExecutionIntentSensitiveVariantV2;

export type AnyExecutionIntentClaims = ExecutionIntentClaims | ExecutionIntentPayloadV2;

/** §5.4 POST /api/v1/agent/missions/:missionId/execution-intents */
export interface IssueExecutionIntentParams {
  readonly missionId: Uuid;
}

export interface IssueExecutionIntentRequest {
  /**
   * **签发前**的 mission revision（R），客户端读到的当前值。
   *
   * 签发会新建 execution step 并把 revision 推到 R+1，所以返回的
   * {@link ExecutionIntentClaims.missionRevision} 一定比这个值大一。
   */
  readonly missionRevision: DecimalString;
  /**
   * **approval step** 的 id——用户批准的那一步。
   *
   * ⚠️ 同名不同物：{@link ExecutionIntentClaims.missionStepId} 指的是签发时
   * 新建的 execution step，与这里传的**必然不相等**。详见那一侧的注释。
   */
  readonly missionStepId: Uuid;
  readonly extensionInstallId: Uuid;
  /**
   * 本次目标页上、可能已被记住的题目身份摘要（value-free：只有摘要，永远没有题干）。
   *
   * 它**不是** authority：服务端拿它当过滤条件，自己按 owner 的 autoReuse、记忆是否
   * 存在、scope 是否覆盖本次申请、类别是否可记忆来决定签发哪些 `question:` key。
   * 缺省（旧版扩展）= 一个记忆键都不签，保持 default-off。
   */
  readonly reusableQuestionDigests?: readonly Sha256Digest[];

  readonly executionProtocolVersion?: never;
  readonly authority?: never;

  /** Signed authority is rebuilt server-side and cannot be supplied here. */
  readonly jobId?: never;
  readonly target?: never;
  readonly fieldKeys?: never;
  readonly automationLevel?: never;
  readonly allowedActions?: never;
  readonly profile?: never;
  readonly resume?: never;
  readonly policyVersion?: never;
}

export interface IssueExecutionIntentResponse extends AgentSchemaEnvelope {
  readonly executionIntent: CompactExecutionIntent;
  readonly expiresAt: IsoDateTime;
  readonly intentVersion: number;
  readonly kid: string;
}

export type IssueExecutionIntentRequestV1 = IssueExecutionIntentRequest;
export type IssueExecutionIntentResponseV1 = IssueExecutionIntentResponse;

/** §5.9.6 exact v2 issue union; the client never supplies fields or signed authority. */
export interface ExecutionIntentIssueRequestV2 {
  readonly executionProtocolVersion: 2;
  readonly missionRevision: DecimalString;
  readonly extensionInstallId: Uuid;
  readonly authority:
    | {
        readonly kind: 'APPROVAL';
        readonly missionStepId: Uuid;
        readonly sensitiveWriteRelease?: never;
      }
    | {
        readonly kind: 'SENSITIVE_WRITE_RELEASE';
        readonly sensitiveWriteRelease: SensitiveWriteReleaseRefV1;
        readonly missionStepId?: never;
      };

  readonly missionStepId?: never;
  readonly jobId?: never;
  readonly target?: never;
  readonly fieldKeys?: never;
  readonly automationLevel?: never;
  readonly allowedActions?: never;
  readonly profile?: never;
  readonly resume?: never;
  readonly policyVersion?: never;
}

export interface IssueExecutionIntentResponseV2 {
  readonly schemaVersion: 2;
  readonly executionProtocolVersion: 2;
  readonly executionIntent: CompactExecutionIntent;
  readonly expiresAt: IsoDateTime;
  readonly intentVersion: number;
  readonly kid: string;
}

export type IssueExecutionIntentRequestContract =
  | IssueExecutionIntentRequestV1
  | ExecutionIntentIssueRequestV2;
export type IssueExecutionIntentResponseContract =
  | IssueExecutionIntentResponseV1
  | IssueExecutionIntentResponseV2;

export interface ActualExecutionTarget {
  readonly canonicalOrigin: CanonicalHttpsOrigin;
  readonly pathRuleId: string;
  readonly postingFingerprint: Sha256Digest;
}

export interface ActualExecutionTargetV2 {
  readonly canonicalOrigin: CanonicalHttpsOrigin;
  readonly pathRuleId: SafeToken;
  readonly postingFingerprint: Sha256Digest;
}

/** §5.6 POST /api/v1/agent/execution-intents/claim */
export interface ClaimExecutionIntentRequest {
  readonly executionIntent: CompactExecutionIntent;
  readonly extensionInstallId: Uuid;
  readonly actualTarget: ActualExecutionTarget;
  readonly actualFieldKeys: readonly string[];
  readonly scanDigest: Sha256Digest;

  readonly executionProtocolVersion?: never;
  readonly actualSensitiveItems?: never;
}

export interface ClaimedExecutionIntentView {
  readonly missionId: Uuid;
  readonly missionStepId: Uuid;
  readonly intentVersion: number;
  readonly executionLease: string;
  readonly leaseExpiresAt: IsoDateTime;
  readonly allowedActions: readonly ExecutionAllowedAction[];
}

export interface ClaimExecutionIntentResponse extends AgentSchemaEnvelope {
  readonly claim: ClaimedExecutionIntentView;
}

export type ClaimExecutionIntentRequestV1 = ClaimExecutionIntentRequest;
export type ClaimExecutionIntentResponseV1 = ClaimExecutionIntentResponse;

interface ClaimExecutionIntentRequestCommonV2 {
  readonly executionProtocolVersion: 2;
  readonly executionIntent: CompactExecutionIntent;
  readonly extensionInstallId: Uuid;
  readonly actualTarget: ActualExecutionTargetV2;
  readonly scanDigest: Sha256Digest;
}

/** §5.9.6 request arms are closed by actualFieldKeys vs actualSensitiveItems. */
export type ClaimExecutionIntentRequestV2 =
  | (ClaimExecutionIntentRequestCommonV2 & {
      readonly actualFieldKeys: readonly ApplicationProfileFieldKey[];
      readonly actualSensitiveItems?: never;
    })
  | (ClaimExecutionIntentRequestCommonV2 & {
      readonly actualFieldKeys?: never;
      readonly actualSensitiveItems: ActualSensitiveItemsV2;
    });

interface ClaimedExecutionIntentViewCommonV2 {
  readonly missionId: Uuid;
  readonly missionStepId: Uuid;
  readonly intentVersion: number;
  readonly executionLease: string;
  readonly leaseExpiresAt: IsoDateTime;
}

export type ClaimedExecutionIntentViewV2 =
  | (ClaimedExecutionIntentViewCommonV2 & {
      readonly allowedActions: readonly ('FILL' | 'SUBMIT' | 'DISCOVER_SENSITIVE')[];
      readonly sensitiveWriteRelease: null;
    })
  | (ClaimedExecutionIntentViewCommonV2 & {
      readonly allowedActions: readonly ['FILL_SENSITIVE'];
      readonly sensitiveWriteRelease: SensitiveWriteReleaseRefV1;
    });

export interface ClaimExecutionIntentResponseV2 {
  readonly schemaVersion: 2;
  readonly executionProtocolVersion: 2;
  readonly claim: ClaimedExecutionIntentViewV2;
}

export type ClaimExecutionIntentRequestContract =
  | ClaimExecutionIntentRequestV1
  | ClaimExecutionIntentRequestV2;
export type ClaimExecutionIntentResponseContract =
  | ClaimExecutionIntentResponseV1
  | ClaimExecutionIntentResponseV2;

/** §5.8 GET /api/v1/agent/application-profile（第⑦项；owner-only 档案快照读取）。 */
export const APPLICATION_PROFILE_FIELD_KEYS = [
  'firstName', 'lastName', 'fullName', 'preferredName', 'email', 'phone',
  'linkedinUrl', 'githubUrl', 'portfolioUrl', 'city', 'location',
  // argoland #469 起端点就在发这三个，插件这边一直停在十一个——于是它们每次都
  // 发过来、每次都被丢掉。实测语料里 currentCompany 一项就命中 48 次。
  'addressLine1', 'addressRegion', 'currentCompany',
  // 第二批：国家 97 次、职位 16 次、邮编 12 次（352 页实测）。addressCountry 是
  // ISO 双字母码，dict/regions.ts 已有码→名展开，下拉按展开后的名字匹配。
  'addressCountry', 'addressPostalCode', 'currentJobTitle',
  // EEO 自我认同与「你从哪听说」：352 页实测里分别命中 139 与 59 次。
  // 键名刻意小于 'question:'——claim key 的分区靠这条不变式。
  'eeoGender', 'eeoRace', 'eeoVeteran', 'eeoDisability', 'heardAboutSource',
  // 2026-09-21 填写键扩展（P1-5，argoland #535）。值一律 string|null：布尔 'true'/'false'，
  // 整数十进制串，日期 YYYY-MM-DD，集合逗号连接（'REMOTE,HYBRID'）。命名全部小于
  // 'question:'，claim key 分区不动；代词叫 preferredPronouns 是为了绕开旧插件敏感键
  // 绊线里的 'pronouns'。
  'preferredPronouns', 'earliestStartDate', 'noticePeriodDays', 'profileSummary',
  'expectedSalaryAmount', 'expectedSalaryCurrency', 'expectedSalaryPeriod',
  'over18', 'openToRelocation', 'openToRelocationCities', 'preferredWorkModes',
  'profileTwitterUrl', 'otherWebsiteUrl',
] as const;
export type ApplicationProfileFieldKey = (typeof APPLICATION_PROFILE_FIELD_KEYS)[number];

/**
 * 请求必须携带的无 PII header：值 = 已验签 JWS 的 fieldKeys，ASCII 升序、
 * 去重、逗号间无空格；unknown/空项/重复/乱序 → 400 VALIDATION_FAILED。
 * 它只选择 snapshotDigest 的摘要上下文，不扩大字段 authority。
 */
export const APPLICATION_PROFILE_FIELD_KEYS_HEADER = 'X-EdAIX-Profile-Field-Keys' as const;

/**
 * §5.3 第二类 claim key：被记住的答案（PRODUCT-AUTHORITY §3「Question memory」Reuse）。
 *
 * 稳定 id 取自题目**身份**的摘要（题干、控件类型、选项文本——与 question memory
 * 落库时同一份身份），不取扫描顺序：同一页重扫、题目上下移动都不会换 key，
 * 而题干或选项一变 key 就变，claim 因此 fail closed。
 *
 * 只取身份摘要的前 128 bit：key 出现在 JWS、claim、回执与审计面板里，这里要的是
 * 「同一题 ⇔ 同一 key」的稳定标识，不是抗第二原像的承诺；真正的 authority 是
 * 服务端自己按完整摘要查到的那条记忆。
 */
export const EXECUTION_INTENT_QUESTION_CLAIM_KEY_PATTERN = /^question:q[0-9a-f]{32}$/u;
export const EXECUTION_INTENT_MAX_QUESTION_CLAIM_KEYS = 20;

export type QuestionClaimKey = `question:q${string}`;
export type ExecutionIntentClaimKey = ApplicationProfileFieldKey | QuestionClaimKey;

export function isQuestionClaimKey(value: unknown): value is QuestionClaimKey {
  return typeof value === 'string' && EXECUTION_INTENT_QUESTION_CLAIM_KEY_PATTERN.test(value);
}

/** `sha256:<64 hex>` 题目身份摘要 → claim key；任何其他形状 → null（绝不静默规范化）。 */
export function questionClaimKeyForIdentityDigest(digest: unknown): QuestionClaimKey | null {
  if (typeof digest !== 'string' || !/^sha256:[0-9a-f]{64}$/u.test(digest)) return null;
  return `question:q${digest.slice('sha256:'.length, 'sha256:'.length + 32)}` as QuestionClaimKey;
}

const PROFILE_FIELD_KEY_SET: ReadonlySet<string> = new Set(APPLICATION_PROFILE_FIELD_KEYS);

/**
 * 把一份 claim key 集合拆成档案键与记忆键。
 *
 * 整份必须 ASCII 升序、去重、两类各自在界内；任一处不合 → null（fail closed）。
 * 二十二个档案键全部小于 `'question:'`，所以「先档案后记忆」就是唯一的 ASCII 序——
 * 两侧各自排序不会得到两种答案。
 */
export function partitionExecutionIntentClaimKeys(
  keys: readonly string[],
): Readonly<{
  profileKeys: readonly ApplicationProfileFieldKey[];
  questionKeys: readonly QuestionClaimKey[];
}> | null {
  if (!Array.isArray(keys) || keys.length === 0) return null;
  const profileKeys: ApplicationProfileFieldKey[] = [];
  const questionKeys: QuestionClaimKey[] = [];
  for (const [index, key] of keys.entries()) {
    if (typeof key !== 'string') return null;
    if (index > 0 && key <= (keys[index - 1] as string)) return null;
    if (PROFILE_FIELD_KEY_SET.has(key)) {
      if (questionKeys.length > 0) return null;
      profileKeys.push(key as ApplicationProfileFieldKey);
      continue;
    }
    if (!isQuestionClaimKey(key)) return null;
    questionKeys.push(key);
  }
  if (
    profileKeys.length > APPLICATION_PROFILE_FIELD_KEYS.length ||
    questionKeys.length > EXECUTION_INTENT_MAX_QUESTION_CLAIM_KEYS
  ) {
    return null;
  }
  return Object.freeze({
    profileKeys: Object.freeze(profileKeys),
    questionKeys: Object.freeze(questionKeys),
  });
}

/**
 * 成功响应是 exact shape：profile 恒带齐 11 键（值 string|null）。
 * 客户端在把值交给填表链前必须逐项校验：fieldSchemaVersion/fieldKeys 与
 * 已验签 JWS 完全相等，revision/deletionEpoch/snapshotDigest 与 JWS
 * profile 三元完全相等；任一不符丢弃整份并停止填表（restart execution）。
 */
export interface GetApplicationProfileResponse extends AgentSchemaEnvelope {
  readonly fieldSchemaVersion: number;
  readonly fieldKeys: readonly string[];
  readonly revision: DecimalString;
  readonly deletionEpoch: DecimalString;
  readonly snapshotDigest: Sha256Digest;
  readonly profile: Readonly<Record<ApplicationProfileFieldKey, string | null>>;
}

export const CLIENT_RECEIPT_OUTCOMES = [
  'FILL_SUCCEEDED', 'FILL_PARTIAL', 'USER_ACTION_REQUIRED', 'SUBMISSION_TRIGGERED',
  'CHALLENGE_REQUIRED', 'CANCELLED', 'FAILED',
] as const;
export type ClientReceiptOutcomeCode = (typeof CLIENT_RECEIPT_OUTCOMES)[number];
export const APPLICATION_RECEIPT_OUTCOMES = [...CLIENT_RECEIPT_OUTCOMES, 'SUBMISSION_CONFIRMED'] as const;
export type ApplicationReceiptOutcomeCode = (typeof APPLICATION_RECEIPT_OUTCOMES)[number];
export const APPLICATION_FIELD_OUTCOMES = [
  'FILLED', 'SKIPPED_NOT_PRESENT', 'SKIPPED_DENYLIST', 'NEEDS_USER_INPUT',
  'VALIDATION_REJECTED', 'FAILED',
] as const;
export type ApplicationFieldOutcomeCode = (typeof APPLICATION_FIELD_OUTCOMES)[number];
export const APPLICATION_FIELD_REASON_CODES = [
  'FIELD_NOT_PRESENT', 'FIELD_NOT_APPROVED', 'FIELD_DENYLISTED', 'PAGE_CHANGED',
  'VALIDATION_FAILED', 'CHALLENGE_DETECTED', 'USER_CANCELLED', 'POLICY_CHANGED',
  'UNKNOWN_SAFE_FAILURE',
] as const;
export type ApplicationFieldReasonCode = (typeof APPLICATION_FIELD_REASON_CODES)[number];

export interface ApplicationReceiptFieldResult {
  readonly fieldKey: string;
  readonly outcomeCode: ApplicationFieldOutcomeCode;
  readonly reasonCode?: ApplicationFieldReasonCode;

  readonly value?: never;
  readonly valueDigest?: never;
  readonly label?: never;
  readonly rawError?: never;
}

/** §5.7 POST /api/v1/agent/missions/:missionId/receipts */
export interface SubmitApplicationReceiptParams {
  readonly missionId: Uuid;
}

export interface SubmitApplicationReceiptRequest {
  readonly clientReceiptId: Uuid;
  readonly executionLease: string;
  readonly missionStepId: Uuid;
  readonly intentVersion: number;
  readonly jobIdentityHash: Sha256Digest;
  readonly planDigest: Sha256Digest;
  readonly outcome: ClientReceiptOutcomeCode;
  readonly fieldResults: readonly ApplicationReceiptFieldResult[];
  readonly executionStartedAt: IsoDateTime;
  readonly executionFinishedAt: IsoDateTime;

  readonly executionProtocolVersion?: never;
  readonly receiptMode?: never;
  readonly sensitiveReleaseSnapshot?: never;
  readonly discovery?: never;
  readonly statementText?: never;
  readonly statementDigest?: never;
  readonly answer?: never;

  readonly values?: never;
  readonly valueDigest?: never;
  readonly dom?: never;
  readonly screenshot?: never;
  readonly rawError?: never;
  readonly pageUrl?: never;
  readonly cookie?: never;
  readonly otp?: never;
}

export const RECEIPT_VERIFICATION_LEVELS = ['CLIENT_REPORTED', 'PROVIDER_CONFIRMED'] as const;
export type ReceiptVerificationLevel = (typeof RECEIPT_VERIFICATION_LEVELS)[number];

export interface SubmitApplicationReceiptResponse extends AgentSchemaEnvelope {
  readonly receipt: {
    readonly id: Uuid;
    readonly clientReceiptId: Uuid;
    readonly missionId: Uuid;
    readonly missionStepId: Uuid;
    readonly intentVersion: number;
    readonly outcome: ApplicationReceiptOutcomeCode;
    readonly verificationLevel: ReceiptVerificationLevel;
    readonly createdAt: IsoDateTime;
  };
  readonly mission: {
    readonly id: Uuid;
    readonly revision: DecimalString;
    readonly status: MissionStatus;
  };
}

export type SubmitApplicationReceiptRequestV1 = SubmitApplicationReceiptRequest;
export type SubmitApplicationReceiptResponseV1 = SubmitApplicationReceiptResponse;

/** §5.9.8 ordinary protocol-v2 run; all §5.7 evidence fields remain authoritative. */
export type SubmitApplicationReceiptRequestV2Standard = Omit<
  SubmitApplicationReceiptRequestV1,
  | 'executionProtocolVersion'
  | 'receiptMode'
  | 'sensitiveReleaseSnapshot'
  | 'discovery'
  | 'statementText'
  | 'statementDigest'
  | 'answer'
> & {
  readonly executionProtocolVersion: 2;
  readonly receiptMode: 'STANDARD';
  readonly sensitiveReleaseSnapshot?: never;
  readonly releaseItemId?: never;
  readonly discovery?: never;
  readonly statementText?: never;
  readonly statementDigest?: never;
  readonly answer?: never;
};

export const SENSITIVE_RECEIPT_OUTCOMES = [
  'FILL_SUCCEEDED',
  'FILL_PARTIAL',
  'USER_ACTION_REQUIRED',
  'CHALLENGE_REQUIRED',
  'CANCELLED',
  'FAILED',
] as const;
export type SensitiveReceiptOutcomeCode = (typeof SENSITIVE_RECEIPT_OUTCOMES)[number];

export interface SensitiveApplicationReceiptFieldResultV2 {
  readonly sensitivity: 'USER_RELEASE_REQUIRED';
  readonly releaseItemId: Uuid;
  readonly outcomeCode: ApplicationFieldOutcomeCode;
  readonly reasonCode: ApplicationFieldReasonCode | null;

  readonly fieldKey?: never;
  readonly statementText?: never;
  readonly statementDigest?: never;
  readonly answer?: never;
  readonly value?: never;
  readonly valueDigest?: never;
  readonly label?: never;
  readonly rawError?: never;
}

export interface SubmitApplicationReceiptRequestV2SensitiveRelease {
  readonly executionProtocolVersion: 2;
  readonly receiptMode: 'SENSITIVE_RELEASE';
  readonly clientReceiptId: Uuid;
  readonly executionLease: string;
  readonly missionStepId: Uuid;
  readonly intentVersion: number;
  readonly jobIdentityHash: Sha256Digest;
  readonly planDigest: Sha256Digest;
  readonly sensitiveReleaseSnapshot: SensitiveWriteReleaseRefV1;
  readonly outcome: SensitiveReceiptOutcomeCode;
  readonly fieldResults: OneToTwenty<SensitiveApplicationReceiptFieldResultV2>;
  readonly executionStartedAt: IsoDateTime;
  readonly executionFinishedAt: IsoDateTime;

  readonly discovery?: never;
  readonly values?: never;
  readonly valueDigest?: never;
  readonly statementText?: never;
  readonly statementDigest?: never;
  readonly answer?: never;
  readonly dom?: never;
  readonly screenshot?: never;
  readonly rawError?: never;
  readonly pageUrl?: never;
  readonly cookie?: never;
  readonly otp?: never;
}

export type SubmitApplicationReceiptRequestV2 =
  | SubmitApplicationReceiptRequestV2Standard
  | SubmitApplicationReceiptRequestV2SensitiveRelease;

interface ApplicationReceiptViewCommonV2<
  O extends ApplicationReceiptOutcomeCode = ApplicationReceiptOutcomeCode,
> {
  readonly id: Uuid;
  readonly clientReceiptId: Uuid;
  readonly missionId: Uuid;
  readonly missionStepId: Uuid;
  readonly intentVersion: number;
  readonly outcome: O;
  readonly verificationLevel: ReceiptVerificationLevel;
  readonly createdAt: IsoDateTime;
}

interface SubmitApplicationReceiptResponseCommonV2 {
  readonly schemaVersion: 2;
  readonly mission: {
    readonly id: Uuid;
    readonly revision: DecimalString;
    readonly status: MissionStatus;
  };
}

export type SubmitApplicationReceiptResponseV2 =
  | (SubmitApplicationReceiptResponseCommonV2 & {
      readonly receipt: ApplicationReceiptViewCommonV2 & {
        readonly sensitiveReleaseSnapshot?: never;
        readonly fieldResults?: never;
      };
    })
  | (SubmitApplicationReceiptResponseCommonV2 & {
      readonly receipt: ApplicationReceiptViewCommonV2<SensitiveReceiptOutcomeCode> & {
        readonly sensitiveReleaseSnapshot: SensitiveWriteReleaseRefV1;
        readonly fieldResults: OneToTwenty<SensitiveApplicationReceiptFieldResultV2>;
      };
    });

export type SubmitApplicationReceiptRequestContract =
  | SubmitApplicationReceiptRequestV1
  | SubmitApplicationReceiptRequestV2;
export type SubmitApplicationReceiptResponseContract =
  | SubmitApplicationReceiptResponseV1
  | SubmitApplicationReceiptResponseV2;

/**
 * The identity a posting fingerprint is computed over.
 *
 * `postingFingerprint` exists so the extension can prove, from the page it is
 * actually on, that the page is the listing the student approved. That only
 * works if both sides derive the same value independently, so the inputs must
 * be observable to both: the server projects them from the stored listing row,
 * the extension extracts them from `location.pathname`.
 *
 * It deliberately excludes `canonicalOrigin` and `pathRuleId`. Both are already
 * separate members of {@link ActualExecutionTarget} and are compared before the
 * fingerprint is, so including them would buy nothing — and it would mean a
 * provider's own host migration, or a fix to a URL rule, silently invalidates
 * every stored fingerprint and every hash derived from one.
 */
export interface PostingListingIdentity {
  readonly atsProvider: AtsProviderCode;
  /** Provider-scoped board, e.g. `greenhouse:acme`. Matches the stored key. */
  readonly boardNamespace: string;
  readonly externalListingId: string;
}

/** Segment charset for a listing identity. Deliberately narrow and exact. */
const LISTING_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;

/**
 * Greenhouse board postings are `/<org>/jobs/<id>`.
 *
 * The pathname is read as given: no case folding and no percent-decoding, so a
 * value that merely looks like a match is rejected rather than folded into one.
 * Anything else — a legacy embed carrying identity in the query string, an
 * unexpected depth, a segment outside the charset — yields null, and a null
 * identity must fail closed rather than fall back to hashing the whole path.
 */
export function parseGreenhouseListingIdentity(
  pathname: string,
): PostingListingIdentity | null {
  if (typeof pathname !== 'string' || !pathname.startsWith('/')) return null;
  const segments = pathname.split('/');
  // ['', org, 'jobs', id] — an exact shape, not a prefix match.
  if (segments.length !== 4) return null;
  const [, org, jobs, listingId] = segments as [string, string, string, string];
  if (jobs !== 'jobs') return null;
  if (!LISTING_SEGMENT.test(org) || !LISTING_SEGMENT.test(listingId)) return null;
  return Object.freeze({
    atsProvider: 'GREENHOUSE',
    boardNamespace: `greenhouse:${org}`,
    externalListingId: listingId,
  });
}
