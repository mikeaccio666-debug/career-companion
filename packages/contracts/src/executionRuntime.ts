/**
 * L1/default-off pre-release execution runtime bundle mirror from source contract §5.14.
 *
 * This is a value-free hostile-boundary decoder. It does not interpret DOM rules;
 * `@edaix/apply-kernel` remains the only ruleset interpreter and must run its own
 * strict schema parser after this envelope and all three digest fences pass.
 */

import {
  parseSha256Digest,
  type DecimalString,
  type IsoDateTime,
  type Sha256Digest,
} from './common.ts';
import {
  ATS_PROVIDER_CODES,
  AUTOMATION_LEVELS,
  type AtsProviderCode,
  type AutomationLevel,
} from './missions.ts';

export const EXECUTION_RUNTIME_BUNDLE_SCHEMA_VERSION = 1 as const;
export const EXECUTION_RUNTIME_BUNDLE_CONTRACT_VERSION = 1 as const;
export const EXECUTION_RUNTIME_RULES_SCHEMA_VERSION = 2 as const;
/** Reader support does not change the currently published v2 release. */
export const EXECUTION_RUNTIME_MAX_RULES_SCHEMA_VERSION = 3 as const;
export type ExecutionRuntimeRulesSchemaVersion = 2 | 3;

export const EXECUTION_RUNTIME_BUNDLE_ERROR_CODES = [
  'RUNTIME_BUNDLE_MALFORMED',
  'RUNTIME_BUNDLE_SCHEMA_UNSUPPORTED',
  'RUNTIME_BUNDLE_TIME_INVALID',
  'RUNTIME_BUNDLE_DIGEST_MISMATCH',
  'RUNTIME_BUNDLE_MAPPING_INVALID',
  'RUNTIME_BUNDLE_ROLLBACK_REJECTED',
  'RUNTIME_BUNDLE_ETAG_INVALID',
  'RUNTIME_BUNDLE_CACHE_UNAVAILABLE',
  'RUNTIME_BUNDLE_STALE',
  'RUNTIME_BUNDLE_HARD_EXPIRED',
] as const;
export type ExecutionRuntimeBundleErrorCode =
  (typeof EXECUTION_RUNTIME_BUNDLE_ERROR_CODES)[number];

export type ExecutionRuntimeBundleResult<
  T,
  E extends ExecutionRuntimeBundleErrorCode = ExecutionRuntimeBundleErrorCode,
> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly code: E };

export const EXECUTION_RUNTIME_POLICY_ACTIONS = [
  'DISCOVER_SENSITIVE',
  'FILL',
  'FILL_SENSITIVE',
  'SUBMIT',
] as const;
export type ExecutionRuntimePolicyAction =
  (typeof EXECUTION_RUNTIME_POLICY_ACTIONS)[number];

export const EXECUTION_RUNTIME_POLICY_VENDORS = [
  'greenhouse',
  'lever',
  'ashby',
  'workable',
  'workday',
  'icims',
  'smartrecruiters',
  'bamboohr',
  // 2026-09-22 追加：规则与适配器早就在仓里，只是从没进过运行时发布。
  'dover',
  'jobvite',
  'rippling',
  'avature',
  // 2026-09-22 追加（argoland 权威 #584，本仓镜像）：不绑厂商的那条路
  // （见 missions.ts 的 GENERIC）。它照常受这一位管，默认关；
  // 契约里有这个词 ≠ 生产已放行。
  'generic',
] as const;
export type ExecutionRuntimePolicyVendor =
  (typeof EXECUTION_RUNTIME_POLICY_VENDORS)[number];

export const EXECUTION_RUNTIME_ACTIVE_VENDORS = [
  'ashby',
  'bamboohr',
  // 2026-09-22 追加：见下面 EXECUTION_RUNTIME_MAPPED_ATS_PROVIDERS 的注释。
  'dover',
  'greenhouse',
  'icims',
  'jobvite',
  'lever',
  'rippling',
  'smartrecruiters',
  'workable',
  'workday',
  // 2026-09-22 追加（argoland 权威 #584，本仓镜像）：不绑厂商的那条路。规则集
  // `generic.json` 随发布下发，但整个发布出去的源码里没有任何调用方打开那个开关
  //（`apply-generic-ruleset.test.ts` 有一道笨闸按源码文本钉着它——那条闸连注释里的
  // 字面量都会命中，所以这段话不写出那个键值对）。发布里有这一份 ≠ 这条路已放行。
  'generic',
] as const;
export type ExecutionRuntimeActiveVendor =
  (typeof EXECUTION_RUNTIME_ACTIVE_VENDORS)[number];

export const EXECUTION_RUNTIME_MAPPED_ATS_PROVIDERS = [
  'ASHBY',
  'BAMBOOHR',
  // 2026-09-22 追加（argoland 权威，本仓镜像）：这三家的规则与适配器早就在仓里、ats-lab 在
  // 真实在招岗位上实测能填，只是从来没进过运行时发布，于是生产上一律「这一页没有认出申请表」。
  'DOVER',
  'GREENHOUSE',
  'ICIMS',
  'JOBVITE',
  'LEVER',
  'RIPPLING',
  'SMARTRECRUITERS',
  'WORKABLE',
  'WORKDAY',
  // 2026-09-22 追加（argoland 权威 #584，本仓镜像）：GENERIC 照常走
  // (atsProvider, pathRuleId) 的精确映射、照常受 policy 的厂商位与能力位管，
  // 不是绕过授权的后门。
  'GENERIC',
] as const satisfies readonly AtsProviderCode[];
export type ExecutionRuntimeMappedAtsProvider =
  (typeof EXECUTION_RUNTIME_MAPPED_ATS_PROVIDERS)[number];

/**
 * The independently releasable runtime baseline. Candidate mappings may be
 * added to a release, but their absence must never make this proven lane
 * unavailable (most importantly, Workday rollout cannot block Greenhouse).
 */
export const EXECUTION_RUNTIME_REQUIRED_ACTIVE_VENDORS = [
  'ashby',
  'greenhouse',
  'lever',
  'workable',
] as const satisfies readonly ExecutionRuntimeActiveVendor[];

export const EXECUTION_RUNTIME_REQUIRED_MAPPED_ATS_PROVIDERS = [
  'ASHBY',
  'GREENHOUSE',
  'LEVER',
  'WORKABLE',
] as const satisfies readonly ExecutionRuntimeMappedAtsProvider[];

/**
 * 写能力位。2026-09-15 补三个：内核 `apply-kernel/src/grant.ts` 早就实现了
 * set-richtext（cover letter 那类富文本编辑器）、manage-rows（增删经历行）与
 * set-other-person（推荐人／紧急联系人等他人信息栏），但这张表只有五个，于是
 * 后端根本说不出"我授权你写富文本"——那个词在契约里不存在。这是跟上权威
 * （argoland 同批 additive 变更），不是本仓单方面改 wire。
 *
 * 新增的三位在铸包处一律默认 false：契约里有这个词 ≠ 生产已放行。
 */
export const EXECUTION_RUNTIME_WRITE_CAPABILITIES = [
  'set-text',
  'set-select',
  'set-combobox',
  'set-file',
  'set-attestation',
  'set-richtext',
  'manage-rows',
  'set-other-person',
  // 乙档 EEO 自我认同。capabilities 走 isTolerantBooleanRecord，所以后端先加、
  // 插件后加都不会打断对方；缺席读作 false。
  'set-self-identification',
  // 乙档工作授权／担保。与上一位分开：EEO 是关于本人身份的陈述，这一条是向雇主
  // 陈述一项法律资格，而且答案随岗位所在国家变。
  'set-work-authorization',
  // 推荐人（P1-9）：他人信息里唯一有可信数据源的子类——用户亲手存的「谁把我推荐到哪家」。
  // 与 set-other-person 分开：那一位仍然关着（紧急联系人、配偶等没有数据源）。
  'set-referral',
  // 多页申请的翻页（2026-09-22）：用户在浮层里按「继续到下一页」，插件按宿主那颗 Save and Continue。
  // 那一下会把这一步保存进宿主，所以它有自己的位、远程关得掉；缺席读作 false。
  'advance-step',
  // 连填（2026-09-28 负责人决定，跟 argoland 同名 additive 变更）：按一下「自动填写」，填完一页不等用户再按，接着替他按
  // 翻页、填下一页，停在检查页（或规则声明的最终提交所在的那一页）等他按「提交」。与 advance-step 两位都开着才连填；
  // 缺席读作 false，回到每一页一颗「继续到下一页」。它从不授权最终提交。
  'advance-steps',
  // 代填条款、声明与签名（2026-09-23，跟 argoland #600）：以用户的名义勾条款／隐私政策同意、
  // 「保证所填属实」一类的声明，在签名栏填姓名与当天日期。这一位只是远程开关；每个用户还必须在
  // 资料页单独勾过同意（consents/application-signing），两者同时成立才代填。缺席读作 false。
  'sign-on-behalf',
  // 在插件里提交（2026-09-23 负责人决定）：用户在浮层里按「提交」＝他本人确认提交，插件随后按
  // 规则声明的那一颗最终提交控件。远程开关，缺席读作 false；关掉它，「提交」只提示去网站上点。
  'submit-application',
  // 替用户在招聘网站上注册账号、登录（2026-09-28 负责人决定，跟 argoland 同名 additive 变更）：规则声明的账号墙上
  // （Workday、iCIMS），插件用用户的邮箱与只存在这台电脑上的密码替他注册或登录，并接受注册所需的网站条款，然后接着填。
  // 这一位只是远程开关；每个用户还必须同意过点名这一类的那一版代填授权文案，两者同时成立才做。缺席读作 false：
  // 回到「先在网站上登录」。密码从不进后端、JWS、channel、回执、日志与遥测；验证码、两步验证、邮箱验证仍由本人完成。
  'account-access',
] as const;
export type ExecutionRuntimeWriteCapability =
  (typeof EXECUTION_RUNTIME_WRITE_CAPABILITIES)[number];

export type ExecutionRuntimeJsonValue =
  | null
  | boolean
  | number
  | string
  | readonly ExecutionRuntimeJsonValue[]
  | ExecutionRuntimeJsonObject;
export interface ExecutionRuntimeJsonObject {
  readonly [key: string]: ExecutionRuntimeJsonValue;
}

export type ExecutionRuntimeBundleVersionV1 = `rb1_${string}`;

export interface ExecutionRuntimeBundleCompatibilityV1 {
  readonly minExtensionVersion: string;
  /** Highest rule schema in this release; mixed v2/v3 requires reader v3. */
  readonly rulesSchemaVersion: ExecutionRuntimeRulesSchemaVersion;
  readonly contractVersion: typeof EXECUTION_RUNTIME_BUNDLE_CONTRACT_VERSION;
}

export interface ExecutionRuntimePolicyV1 {
  readonly version: string;
  /**
   * Legacy JWS carrier name. In the canonical runtime lane this is exactly the
   * bundle releaseRevision; it is not a second independently mutable counter.
   */
  readonly killSwitchVersion: DecimalString;
  readonly enabled: boolean;
  /**
   * 自动化级别上限。**可以是这一版还不认识的级别**（2026-09-28）：后端加一档，旧包不该因此
   * 整包拒收。已知的几档见 `AUTOMATION_LEVELS`；消费端只能拿它与已知档逐一比对
   * （mission 路按已知档排位，陌生档排不上位 → 任何意向都超出上限 → 拒；只读路只认
   * 字面量 `L0_PREVIEW_ONLY`），陌生值因此天然 fail closed。声明成 `string` 与下面两份清单
   * 同一个理由：让类型不说谎。
   */
  readonly automationLevelCeiling: string;
  /**
   * 动作面与字段面。**成员可以是我们还不认识的**：后端先上线一个新字段键，
   * 插件跟版要过几天，中间这段时间两边的清单不等。声明成 `string[]` 是为了
   * 让类型不说谎——消费端一律只能 `includes(<我们自己的键>)` 这样问，
   * 陌生成员因此天然是惰性的：它只可能匹配我们自己产得出的键。
   */
  readonly allowedActions: readonly string[];
  readonly allowedFieldKeys: readonly string[];
  readonly vendors: Readonly<Partial<Record<ExecutionRuntimePolicyVendor, boolean>>>;
  /**
   * 能力位。**键可以缺席**：后端与插件各自演进，两边的能力位集合不会永远相等。
   * 缺席读作 `undefined`，而 `undefined` 不是 `true`，所以授权自然给不出去——
   * fail-closed 由类型系统保证，不靠每个调用点记得写 `=== true`。
   */
  readonly capabilities: Readonly<Partial<Record<ExecutionRuntimeWriteCapability, boolean>>>;
  readonly minConfidence: number;
  readonly inferredRequiresConfirm: boolean;
  readonly deniedHostSuffixes: readonly string[];
}

export interface ExecutionRuntimeRulesMappingV1 {
  readonly atsProvider: ExecutionRuntimeMappedAtsProvider;
  readonly pathRuleId: string;
  readonly vendor: ExecutionRuntimeActiveVendor;
  readonly rulesetVersion: string;
  readonly rulesetDigest: Sha256Digest;
}

export interface ExecutionRuntimeRulesetV1 {
  readonly version: string;
  readonly digest: Sha256Digest;
  /** Strictly JSON data; kernel applies its stricter vendor-rules schema next. */
  readonly ruleset: ExecutionRuntimeJsonObject;
}

export interface ExecutionRuntimeRulesReleaseV1 {
  readonly releaseVersion: string;
  readonly releaseDigest: Sha256Digest;
  readonly mappings: readonly ExecutionRuntimeRulesMappingV1[];
  readonly rulesets: readonly ExecutionRuntimeRulesetV1[];
}

export interface ExecutionRuntimeBundleWithoutVersionV1 {
  readonly schemaVersion: typeof EXECUTION_RUNTIME_BUNDLE_SCHEMA_VERSION;
  readonly releaseRevision: DecimalString;
  readonly issuedAt: IsoDateTime;
  readonly notBefore: IsoDateTime;
  readonly freshUntil: IsoDateTime;
  readonly notAfter: IsoDateTime;
  readonly compatibility: ExecutionRuntimeBundleCompatibilityV1;
  readonly policy: ExecutionRuntimePolicyV1;
  readonly rules: ExecutionRuntimeRulesReleaseV1;
}

export interface ExecutionRuntimeBundleV1 extends ExecutionRuntimeBundleWithoutVersionV1 {
  readonly runtimeBundleVersion: ExecutionRuntimeBundleVersionV1;
}

export type ExecutionRuntimeBundleSha256V1 = (
  canonicalJson: string,
) =>
  | Sha256Digest
  | null
  | Promise<Sha256Digest | null>;

export interface ParseExecutionRuntimeBundleOptionsV1 {
  /** When supplied, parsing also requires the bundle to be currently fresh. */
  readonly nowMs?: number;
  /** A previously accepted monotonic fence. Lower revisions are rejected. */
  readonly minimumReleaseRevision?: DecimalString;
  readonly maxClockSkewMs?: number;
  /** Test/host injection; default uses standards-based WebCrypto SHA-256. */
  readonly sha256?: ExecutionRuntimeBundleSha256V1;
}

const MAX_BUNDLE_JSON_BYTES = 1_048_576;
const MAX_JSON_DEPTH = 64;
const MAX_JSON_NODES = 100_000;
const MAX_MAPPINGS = 128;
const MAX_RULESETS = 64;
const MAX_DENIED_HOST_SUFFIXES = 512;
const MAX_CLOCK_SKEW_MS = 5 * 60 * 1_000;
const MAX_RELEASE_REVISION = 9_223_372_036_854_775_807n;
const FORBIDDEN_JSON_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

const OUTER_KEYS = [
  'schemaVersion',
  'runtimeBundleVersion',
  'releaseRevision',
  'issuedAt',
  'notBefore',
  'freshUntil',
  'notAfter',
  'compatibility',
  'policy',
  'rules',
] as const;
const COMPATIBILITY_KEYS = [
  'minExtensionVersion',
  'rulesSchemaVersion',
  'contractVersion',
] as const;
const POLICY_KEYS = [
  'version',
  'killSwitchVersion',
  'enabled',
  'automationLevelCeiling',
  'allowedActions',
  'allowedFieldKeys',
  'vendors',
  'capabilities',
  'minConfidence',
  'inferredRequiresConfirm',
  'deniedHostSuffixes',
] as const;
const RULES_KEYS = ['releaseVersion', 'releaseDigest', 'mappings', 'rulesets'] as const;
const MAPPING_KEYS = [
  'atsProvider',
  'pathRuleId',
  'vendor',
  'rulesetVersion',
  'rulesetDigest',
] as const;
const RULESET_KEYS = ['version', 'digest', 'ruleset'] as const;

function failure<const C extends ExecutionRuntimeBundleErrorCode>(
  code: C,
): ExecutionRuntimeBundleResult<never, C> {
  return { ok: false, code };
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasExactKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (!isPlainRecord(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return (
    actual.length === expected.length &&
    actual.every((key, index) => key === expected[index] && !FORBIDDEN_JSON_KEYS.has(key))
  );
}

/**
 * 认得的键一个都不能少；多出来的（后端新加、这一版不认识的）不拒（2026-09-28）。
 *
 * 只用在**加法可以被安全忽略**的那几层：整包顶层、`compatibility`、`policy`。多出来的成员
 * 不被解释，但原样留在解析结果里，所以整包摘要与规范正文照旧覆盖它们——送达途中改一个字，
 * 整包拒。规则 release 的骨架（映射表、ruleset 信封）不走这里：那是授权的路由表，
 * 仍是 `hasExactKeys`。
 */
function hasRequiredKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (!isPlainRecord(value)) return false;
  return (
    keys.every((key) => Object.hasOwn(value, key)) &&
    Object.keys(value).every((key) => !FORBIDDEN_JSON_KEYS.has(key))
  );
}

function isMember<T extends string>(value: unknown, values: readonly T[]): value is T {
  return typeof value === 'string' && (values as readonly string[]).includes(value);
}

function isSafeToken(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9._:-]{1,64}$/.test(value);
}

type ParsedExecutionRuntimeSemver = Readonly<{
  core: readonly [bigint, bigint, bigint];
  prerelease: readonly string[] | null;
}>;

/**
 * Strict SemVer 2.0 boundary used by every runtime-bundle producer and
 * consumer. Build metadata is accepted but, per SemVer precedence, ignored by
 * the comparator. Numeric prerelease identifiers may only be `0` or a
 * non-zero-leading decimal.
 */
export function isCanonicalExecutionRuntimeSemverV1(value: unknown): value is string {
  return parseExecutionRuntimeSemver(value) !== null;
}

export function compareExecutionRuntimeSemverV1(
  left: unknown,
  right: unknown,
): -1 | 0 | 1 | null {
  const leftVersion = parseExecutionRuntimeSemver(left);
  const rightVersion = parseExecutionRuntimeSemver(right);
  if (leftVersion === null || rightVersion === null) return null;

  for (let index = 0; index < leftVersion.core.length; index += 1) {
    const actual = leftVersion.core[index] as bigint;
    const required = rightVersion.core[index] as bigint;
    if (actual < required) return -1;
    if (actual > required) return 1;
  }

  const leftPre = leftVersion.prerelease;
  const rightPre = rightVersion.prerelease;
  if (leftPre === null && rightPre === null) return 0;
  if (leftPre === null) return 1;
  if (rightPre === null) return -1;

  const length = Math.max(leftPre.length, rightPre.length);
  for (let index = 0; index < length; index += 1) {
    const actual = leftPre[index];
    const required = rightPre[index];
    if (actual === undefined) return -1;
    if (required === undefined) return 1;
    if (actual === required) continue;

    const actualNumeric = /^[0-9]+$/.test(actual);
    const requiredNumeric = /^[0-9]+$/.test(required);
    if (actualNumeric && requiredNumeric) {
      return BigInt(actual) < BigInt(required) ? -1 : 1;
    }
    if (actualNumeric !== requiredNumeric) return actualNumeric ? -1 : 1;
    return actual < required ? -1 : 1;
  }
  return 0;
}

function parseExecutionRuntimeSemver(
  value: unknown,
): ParsedExecutionRuntimeSemver | null {
  if (typeof value !== 'string' || value.length === 0 || value.length > 64) return null;
  const match = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/.exec(
    value,
  );
  if (match === null) return null;
  const prerelease = match[4]?.split('.') ?? null;
  if (
    prerelease?.some(
      (identifier) => /^[0-9]+$/.test(identifier) && !/^(?:0|[1-9][0-9]*)$/.test(identifier),
    )
  ) return null;
  try {
    const core = Object.freeze([
      BigInt(match[1] as string),
      BigInt(match[2] as string),
      BigInt(match[3] as string),
    ] as const);
    return Object.freeze({
      core,
      prerelease: prerelease === null ? null : Object.freeze(prerelease),
    });
  } catch {
    return null;
  }
}

function parseReleaseRevision(value: unknown): DecimalString | null {
  if (typeof value !== 'string' || !/^(?:0|[1-9][0-9]{0,18})$/.test(value)) return null;
  return BigInt(value) <= MAX_RELEASE_REVISION ? (value as DecimalString) : null;
}

function parseCanonicalInstant(value: unknown): IsoDateTime | null {
  if (
    typeof value !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
  ) {
    return null;
  }
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value
    ? (value as IsoDateTime)
    : null;
}

/**
 * 清单的**规范形式**校验：有界、每项是安全 token、严格升序（升序即蕴含去重）。
 *
 * 这里刻意**不查成员资格**。2026-09-16 实测：argoland #469 给
 * `allowedFieldKeys` 加了 addressLine1 / addressRegion / currentCompany 三个键，
 * 我们这边还是十一个，于是 `isMember` 判假、整包 policy 被拒、自动填写全线
 * fail closed——后端一次纯加法的改动，把插件打死了。
 *
 * 放松成员资格是安全的，因为这两份清单在消费端只被用来**反查我们自己的键**
 * （`allowed.includes(ourKey)`、`grant.allowedActions.includes('FILL')`）。
 * 陌生成员永远匹配不上我们产得出的键，所以它既不放权也不越权；等我们的内核
 * 哪天真的会产 addressLine1 了，这条围栏自然就认了——那正是 #469 的用意。
 *
 * 不放松的是形状：越界、乱序、重复、非 token 仍然判整包坏。
 *
 * 上限 64 → 512（2026-09-28）：`allowedFieldKeys` 是后端的全部档案字段键，2026-09 一个月里
 * 从 11 个涨到 35 个。照这个速度 64 这道线几个月内就会被一次纯加法越过，而越过的那一刻，
 * 所有已装的包整包拒收——与 #469 同一种死法。上限只为防失控的输入：512 个 token 的清单
 * 不到 40 KB，整包另有 1 MiB 的总闸。
 */
const POLICY_LIST_MAXIMUM = 512;

function isCanonicalSortedTokenList(value: unknown): value is readonly string[] {
  if (!Array.isArray(value) || value.length > POLICY_LIST_MAXIMUM) return false;
  for (let index = 0; index < value.length; index += 1) {
    const current = value[index];
    if (!isSafeToken(current)) return false;
    if (index > 0 && (value[index - 1] as string) >= current) return false;
  }
  return true;
}

function isExactBooleanRecord<T extends string>(
  value: unknown,
  keys: readonly T[],
): value is Readonly<Record<T, boolean>> {
  return (
    hasExactKeys(value, keys) &&
    keys.every((key) => typeof value[key] === 'boolean')
  );
}

/**
 * 能力位的容错读法。
 *
 * 换掉 `isExactBooleanRecord` 的原因：它要求键集完全相等，于是后端每加一个
 * 能力位，没跟上的插件就把**整个运行时包**判为 malformed——不是少一个能力，
 * 是自动填写整个不可用，连已经放行的厂商一起停。反过来插件先加也一样。两边
 * 就被焊死成必须同时发布，而它们一个走商店审核、一个走部署，根本不可能同步。
 *
 * 新语义：
 *  - 未知键**忽略**——后端加了我们还不认识的能力位，不影响我们认识的那些；
 *  - 已知键缺席**读作 false**（类型是 Partial，`undefined` 不是 `true`）；
 *  - 出现的值必须是布尔，不是布尔仍然拒整包——容错的是"有没有"，不是"是什么"。
 *
 * fail-closed 没有放松：认不出的能力位给不出授权，缺席的能力位等于关闭。
 */
function isTolerantBooleanRecord(value: unknown): value is Readonly<Record<string, boolean>> {
  if (!isPlainRecord(value)) return false;
  return Object.entries(value).every(
    ([key, entry]) => !FORBIDDEN_JSON_KEYS.has(key) && typeof entry === 'boolean',
  );
}

/**
 * 厂商开关。原来这里钉着五行 `value.vendors.workday === false` 之类的硬断言，
 * 把未放行的厂商写死在契约里；开一家要改三份拷贝的解码器。
 *
 * 换成：键集容错（同上），而**任何为 `true` 的厂商必须在我们认识的集合里**。
 * 这一条不放松——它是后端配置写错时的最后一道：开了一个我们从没量过的厂商，
 * 整包拒收，而不是让插件跑到没人量过的页面上动手。
 *
 * 具体哪几家放行由后端的准入清单决定（每条带日期与站点证据）；插件侧还有
 * 第二道独立的底线：`lib/executionRuntimeAuthority.ts` 会把后端的每一位与本地
 * 代码能力上限做与运算，没有编译进适配器的厂商永远开不起来。
 */
function isVendorRecord(
  value: unknown,
): value is Readonly<Partial<Record<ExecutionRuntimePolicyVendor, boolean>>> {
  // 2026-09-22：未知厂商**开着**也不再判坏整包。原来这里要求「为 true 的厂商必须
  // 在本地已知集合里」，于是后端放行一家新厂商的那一刻，所有还没升级的包连同
  // 认得的那十家一起停掉。开关开着也没用——下游按本地已知集合重建策略
  //（`CODE_COMPATIBILITY_CEILING.vendors`），未知厂商泄不进来，拿不到任何授权。
  return isTolerantBooleanRecord(value);
}

function isCanonicalHostSuffix(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 253 || value !== value.toLowerCase()) return false;
  if (value.startsWith('.') || value.endsWith('.') || !value.includes('.')) return false;
  const labels = value.split('.');
  return labels.every(
    (label) =>
      label.length >= 1 &&
      label.length <= 63 &&
      /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label),
  );
}

function parseDeniedHostSuffixes(value: unknown): value is readonly string[] {
  return (
    Array.isArray(value) &&
    value.length <= MAX_DENIED_HOST_SUFFIXES &&
    value.every(isCanonicalHostSuffix) &&
    value.every((entry, index) => index === 0 || (value[index - 1] as string) < entry)
  );
}

function hasWellFormedUnicode(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return false;
    }
  }
  return true;
}

function validateJsonValue(value: unknown): value is ExecutionRuntimeJsonValue {
  const seen = new Set<object>();
  let nodes = 0;
  let approximateStringBytes = 0;
  const visit = (current: unknown, depth: number): boolean => {
    nodes += 1;
    if (nodes > MAX_JSON_NODES || depth > MAX_JSON_DEPTH) return false;
    if (current === null || typeof current === 'boolean') return true;
    if (typeof current === 'string') {
      approximateStringBytes += current.length;
      return approximateStringBytes <= MAX_BUNDLE_JSON_BYTES && hasWellFormedUnicode(current);
    }
    if (typeof current === 'number') {
      return Number.isFinite(current) && !Object.is(current, -0);
    }
    if (typeof current !== 'object' || current === null || seen.has(current)) return false;
    seen.add(current);
    if (Array.isArray(current)) {
      const valid = current.every((entry) => visit(entry, depth + 1));
      seen.delete(current);
      return valid;
    }
    if (!isPlainRecord(current)) {
      seen.delete(current);
      return false;
    }
    const entries = Object.entries(current);
    const valid = entries.every(
      ([key, entry]) => {
        approximateStringBytes += key.length;
        return (
          approximateStringBytes <= MAX_BUNDLE_JSON_BYTES &&
          !FORBIDDEN_JSON_KEYS.has(key) &&
          hasWellFormedUnicode(key) &&
          visit(entry, depth + 1)
        );
      },
    );
    seen.delete(current);
    return valid;
  };
  return visit(value, 0);
}

/** RFC 8785-compatible serialization for this I-JSON subset. */
export function canonicalizeExecutionRuntimeJsonV1(
  value: unknown,
): ExecutionRuntimeBundleResult<string, 'RUNTIME_BUNDLE_MALFORMED'> {
  if (!validateJsonValue(value)) return failure('RUNTIME_BUNDLE_MALFORMED');
  const canonicalize = (current: ExecutionRuntimeJsonValue): string => {
    if (current === null || typeof current !== 'object') return JSON.stringify(current);
    if (Array.isArray(current)) return `[${current.map(canonicalize).join(',')}]`;
    const object = current as ExecutionRuntimeJsonObject;
    return `{${Object.keys(object)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalize(object[key]!)}`)
      .join(',')}}`;
  };
  return { ok: true, value: canonicalize(value) };
}

export async function sha256ExecutionRuntimeCanonicalJsonV1(
  canonicalJson: string,
): Promise<Sha256Digest | null> {
  try {
    const cryptoApi = globalThis.crypto;
    if (!cryptoApi?.subtle) return null;
    const bytes = new TextEncoder().encode(canonicalJson);
    const hash = new Uint8Array(await cryptoApi.subtle.digest('SHA-256', bytes));
    const hex = [...hash].map((byte) => byte.toString(16).padStart(2, '0')).join('');
    return parseSha256Digest(`sha256:${hex}`);
  } catch {
    return null;
  }
}

async function calculateDigest(
  value: unknown,
  sha256: ExecutionRuntimeBundleSha256V1,
): Promise<Sha256Digest | null> {
  const canonical = canonicalizeExecutionRuntimeJsonV1(value);
  if (!canonical.ok) return null;
  try {
    return parseSha256Digest(await sha256(canonical.value));
  } catch {
    return null;
  }
}

function parseCompatibility(
  value: unknown,
): ExecutionRuntimeBundleResult<
  ExecutionRuntimeBundleCompatibilityV1,
  'RUNTIME_BUNDLE_MALFORMED' | 'RUNTIME_BUNDLE_SCHEMA_UNSUPPORTED'
> {
  if (
    // 2026-09-28：多出来的成员（例如将来的「建议版本」）不拒；三根杠杆照旧逐项校验。
    !hasRequiredKeys(value, COMPATIBILITY_KEYS) ||
    !isCanonicalExecutionRuntimeSemverV1(value.minExtensionVersion) ||
    typeof value.rulesSchemaVersion !== 'number' ||
    !Number.isSafeInteger(value.rulesSchemaVersion) ||
    value.rulesSchemaVersion < 1 ||
    typeof value.contractVersion !== 'number' ||
    !Number.isSafeInteger(value.contractVersion) ||
    value.contractVersion < 1
  ) {
    return failure('RUNTIME_BUNDLE_MALFORMED');
  }
  if (
    value.rulesSchemaVersion > EXECUTION_RUNTIME_MAX_RULES_SCHEMA_VERSION ||
    value.contractVersion > EXECUTION_RUNTIME_BUNDLE_CONTRACT_VERSION
  ) {
    return failure('RUNTIME_BUNDLE_SCHEMA_UNSUPPORTED');
  }
  if (
    (value.rulesSchemaVersion !== EXECUTION_RUNTIME_RULES_SCHEMA_VERSION && value.rulesSchemaVersion !== 3) ||
    value.contractVersion !== EXECUTION_RUNTIME_BUNDLE_CONTRACT_VERSION
  ) {
    return failure('RUNTIME_BUNDLE_MALFORMED');
  }
  return {
    ok: true,
    value: {
      // 这一版不认识的成员原样带着：整包摘要与规范正文按送达的原样算（见 `hasRequiredKeys`）。
      ...value,
      minExtensionVersion: value.minExtensionVersion,
      rulesSchemaVersion: value.rulesSchemaVersion as ExecutionRuntimeRulesSchemaVersion,
      contractVersion: EXECUTION_RUNTIME_BUNDLE_CONTRACT_VERSION,
    },
  };
}

function parsePolicy(
  value: unknown,
  releaseRevision: DecimalString,
): value is ExecutionRuntimePolicyV1 {
  // 2026-09-28：多出来的成员不拒（policy 本来就按原样进整包摘要）；认得的十一项逐项照旧。
  if (!hasRequiredKeys(value, POLICY_KEYS)) return false;
  return (
    isSafeToken(value.version) &&
    parseReleaseRevision(value.killSwitchVersion) === releaseRevision &&
    typeof value.enabled === 'boolean' &&
    // 这一版不认识的级别不拒整包，但必须像一个级别（token）；消费端逐一比对已知档，见类型注释。
    isSafeToken(value.automationLevelCeiling) &&
    isCanonicalSortedTokenList(value.allowedActions) &&
    isCanonicalSortedTokenList(value.allowedFieldKeys) &&
    isVendorRecord(value.vendors) &&
    isTolerantBooleanRecord(value.capabilities) &&
    typeof value.minConfidence === 'number' &&
    Number.isFinite(value.minConfidence) &&
    value.minConfidence >= 0 &&
    value.minConfidence <= 1 &&
    typeof value.inferredRequiresConfirm === 'boolean' &&
    parseDeniedHostSuffixes(value.deniedHostSuffixes)
  );
}

function isKnownMappedProvider(value: unknown): boolean {
  return isMember(value, EXECUTION_RUNTIME_MAPPED_ATS_PROVIDERS);
}

/**
 * 2026-09-22 起对**这一版不认识的厂商**容错，与 `isTolerantBooleanRecord` 同一条口径。
 *
 * 在此之前，release 里出现一家本地列表里没有的厂商 → 整个 bundle
 * `RUNTIME_BUNDLE_MALFORMED` → 取不到规则 → 认得的那些也一起停掉。后端一放行新厂商
 * 就会打断所有还没升级的商店包，而商店包的更新天然是异步的（审核 + 用户升级），
 * 两边**永远**有一段版本不一致的窗口。
 *
 * 容错的只是「认不认识」：键集、token 形状、digest 一律照旧校验，不合格仍然拒整包。
 * 不认识的那家在下游一路被跳过（`apply-kernel/runtimeRegistry` 不给它编译适配器，
 * `authorizationForMapping` 解析不出授权），所以「厂商准入清单外一律拒」没有放松。
 */
function parseMapping(value: unknown): value is ExecutionRuntimeRulesMappingV1 {
  return (
    hasExactKeys(value, MAPPING_KEYS) &&
    isSafeToken(value.atsProvider) &&
    isSafeToken(value.pathRuleId) &&
    isSafeToken(value.vendor) &&
    isSafeToken(value.rulesetVersion) &&
    Boolean(parseSha256Digest(value.rulesetDigest))
  );
}

function parseRuleset(value: unknown): value is ExecutionRuntimeRulesetV1 {
  return (
    hasExactKeys(value, RULESET_KEYS) &&
    isSafeToken(value.version) &&
    Boolean(parseSha256Digest(value.digest)) &&
    isPlainRecord(value.ruleset) &&
    validateJsonValue(value.ruleset)
  );
}

function expectedVendorForProvider(
  provider: ExecutionRuntimeMappedAtsProvider,
): ExecutionRuntimeActiveVendor {
  switch (provider) {
    case 'ASHBY': return 'ashby';
    case 'BAMBOOHR': return 'bamboohr';
    case 'DOVER': return 'dover';
    case 'GENERIC': return 'generic';
    case 'GREENHOUSE': return 'greenhouse';
    case 'ICIMS': return 'icims';
    case 'JOBVITE': return 'jobvite';
    case 'LEVER': return 'lever';
    case 'RIPPLING': return 'rippling';
    case 'SMARTRECRUITERS': return 'smartrecruiters';
    case 'WORKABLE': return 'workable';
    case 'WORKDAY': return 'workday';
  }
}

function validateRulesRelease(
  value: unknown,
  requiredSchemaVersion: ExecutionRuntimeRulesSchemaVersion,
): ExecutionRuntimeBundleResult<ExecutionRuntimeRulesReleaseV1> {
  if (
    !hasExactKeys(value, RULES_KEYS) ||
    !isSafeToken(value.releaseVersion) ||
    !parseSha256Digest(value.releaseDigest) ||
    !Array.isArray(value.mappings) ||
    value.mappings.length > MAX_MAPPINGS ||
    !value.mappings.every(parseMapping) ||
    !Array.isArray(value.rulesets) ||
    value.rulesets.length > MAX_RULESETS ||
    !value.rulesets.every(parseRuleset)
  ) {
    return failure('RUNTIME_BUNDLE_MALFORMED');
  }

  const mappings = value.mappings;
  const rulesets = value.rulesets;
  if (
    mappings.length < EXECUTION_RUNTIME_REQUIRED_MAPPED_ATS_PROVIDERS.length ||
    rulesets.length < EXECUTION_RUNTIME_REQUIRED_ACTIVE_VENDORS.length
  ) {
    return failure('RUNTIME_BUNDLE_MAPPING_INVALID');
  }
  const mappingKeys = mappings.map((mapping) => `${mapping.atsProvider}\u0000${mapping.pathRuleId}`);
  const rulesetVersions = rulesets.map((ruleset) => ruleset.version);
  if (
    mappingKeys.some((key, index) => index > 0 && mappingKeys[index - 1]! >= key) ||
    rulesetVersions.some((version, index) => index > 0 && rulesetVersions[index - 1]! >= version)
  ) {
    return failure('RUNTIME_BUNDLE_MAPPING_INVALID');
  }

  const coveredProviders = new Set(mappings.map((mapping) => mapping.atsProvider));
  if (
    EXECUTION_RUNTIME_REQUIRED_MAPPED_ATS_PROVIDERS.some(
      (provider) => !coveredProviders.has(provider),
    ) ||
    mappings.some((mapping) => isKnownMappedProvider(mapping.atsProvider) &&
      mapping.vendor !== expectedVendorForProvider(mapping.atsProvider))
  ) {
    return failure('RUNTIME_BUNDLE_MAPPING_INVALID');
  }

  const rulesetByVersion = new Map(rulesets.map((ruleset) => [ruleset.version, ruleset]));
  const referencedVersions = new Set<string>();
  for (const mapping of mappings) {
    const ruleset = rulesetByVersion.get(mapping.rulesetVersion);
    if (!ruleset) return failure('RUNTIME_BUNDLE_MAPPING_INVALID');
    referencedVersions.add(ruleset.version);
    const payloadVendor = ruleset.ruleset.vendor;
    if (
      payloadVendor !== mapping.vendor ||
      (ruleset.ruleset.schemaVersion !== EXECUTION_RUNTIME_RULES_SCHEMA_VERSION && ruleset.ruleset.schemaVersion !== 3)
    ) {
      return failure('RUNTIME_BUNDLE_MAPPING_INVALID');
    }
  }
  if (rulesets.some((ruleset) => !referencedVersions.has(ruleset.version))) {
    return failure('RUNTIME_BUNDLE_MAPPING_INVALID');
  }
  const highestSchema = rulesets.some((entry) => entry.ruleset.schemaVersion === 3) ? 3 : 2;
  if (highestSchema !== requiredSchemaVersion) return failure('RUNTIME_BUNDLE_MAPPING_INVALID');
  return { ok: true, value: value as unknown as ExecutionRuntimeRulesReleaseV1 };
}

function parseChronology(value: Record<string, unknown>): {
  issuedAt: IsoDateTime;
  notBefore: IsoDateTime;
  freshUntil: IsoDateTime;
  notAfter: IsoDateTime;
} | null {
  const issuedAt = parseCanonicalInstant(value.issuedAt);
  const notBefore = parseCanonicalInstant(value.notBefore);
  const freshUntil = parseCanonicalInstant(value.freshUntil);
  const notAfter = parseCanonicalInstant(value.notAfter);
  if (!issuedAt || !notBefore || !freshUntil || !notAfter) return null;
  const issued = Date.parse(issuedAt);
  const start = Date.parse(notBefore);
  const fresh = Date.parse(freshUntil);
  const hard = Date.parse(notAfter);
  return issued <= start && start < fresh && fresh < hard
    ? { issuedAt, notBefore, freshUntil, notAfter }
    : null;
}

export function classifyExecutionRuntimeBundleTimeV1(
  bundle: Pick<ExecutionRuntimeBundleV1, 'issuedAt' | 'notBefore' | 'freshUntil' | 'notAfter'>,
  nowMs: number,
  maxClockSkewMs = MAX_CLOCK_SKEW_MS,
): ExecutionRuntimeBundleResult<
  'FRESH',
  | 'RUNTIME_BUNDLE_TIME_INVALID'
  | 'RUNTIME_BUNDLE_STALE'
  | 'RUNTIME_BUNDLE_HARD_EXPIRED'
> {
  if (
    !Number.isFinite(nowMs) ||
    nowMs < 0 ||
    !Number.isFinite(maxClockSkewMs) ||
    maxClockSkewMs < 0
  ) {
    return failure('RUNTIME_BUNDLE_TIME_INVALID');
  }
  const issuedAt = parseCanonicalInstant(bundle.issuedAt);
  const notBefore = parseCanonicalInstant(bundle.notBefore);
  const freshUntil = parseCanonicalInstant(bundle.freshUntil);
  const notAfter = parseCanonicalInstant(bundle.notAfter);
  if (!issuedAt || !notBefore || !freshUntil || !notAfter) {
    return failure('RUNTIME_BUNDLE_TIME_INVALID');
  }
  const issued = Date.parse(issuedAt);
  const start = Date.parse(notBefore);
  const fresh = Date.parse(freshUntil);
  const hard = Date.parse(notAfter);
  if (issued > nowMs + maxClockSkewMs || nowMs < start) {
    return failure('RUNTIME_BUNDLE_TIME_INVALID');
  }
  if (nowMs >= hard) return failure('RUNTIME_BUNDLE_HARD_EXPIRED');
  if (nowMs >= fresh) return failure('RUNTIME_BUNDLE_STALE');
  return { ok: true, value: 'FRESH' };
}

async function verifyBundleDigests(
  bundle: ExecutionRuntimeBundleV1,
  sha256: ExecutionRuntimeBundleSha256V1,
): Promise<ExecutionRuntimeBundleResult<ExecutionRuntimeBundleV1>> {
  for (const ruleset of bundle.rules.rulesets) {
    const calculated = await calculateDigest(ruleset.ruleset, sha256);
    if (!calculated || calculated !== ruleset.digest) {
      return failure('RUNTIME_BUNDLE_DIGEST_MISMATCH');
    }
  }
  const rulesetByVersion = new Map(
    bundle.rules.rulesets.map((ruleset) => [ruleset.version, ruleset]),
  );
  for (const mapping of bundle.rules.mappings) {
    if (rulesetByVersion.get(mapping.rulesetVersion)?.digest !== mapping.rulesetDigest) {
      return failure('RUNTIME_BUNDLE_DIGEST_MISMATCH');
    }
  }
  const releasePreimage = {
    releaseVersion: bundle.rules.releaseVersion,
    mappings: bundle.rules.mappings,
    rulesets: bundle.rules.rulesets,
  } as const;
  const releaseDigest = await calculateDigest(releasePreimage, sha256);
  if (!releaseDigest || releaseDigest !== bundle.rules.releaseDigest) {
    return failure('RUNTIME_BUNDLE_DIGEST_MISMATCH');
  }
  const { runtimeBundleVersion: _runtimeBundleVersion, ...bundlePreimage } = bundle;
  const versionDigest = await calculateDigest(bundlePreimage, sha256);
  if (
    !versionDigest ||
    bundle.runtimeBundleVersion !== `rb1_${versionDigest.slice('sha256:'.length)}`
  ) {
    return failure('RUNTIME_BUNDLE_DIGEST_MISMATCH');
  }
  return { ok: true, value: bundle };
}

export async function parseExecutionRuntimeBundleV1(
  value: unknown,
  options: ParseExecutionRuntimeBundleOptionsV1 = {},
): Promise<ExecutionRuntimeBundleResult<ExecutionRuntimeBundleV1>> {
  if (!isPlainRecord(value)) return failure('RUNTIME_BUNDLE_MALFORMED');
  // 2026-09-28：顶层多出来的成员不拒整包（见 `hasRequiredKeys`）；认得的十项一个都不能少。
  if (!hasRequiredKeys(value, OUTER_KEYS)) return failure('RUNTIME_BUNDLE_MALFORMED');
  if (
    typeof value.schemaVersion !== 'number' ||
    !Number.isSafeInteger(value.schemaVersion) ||
    value.schemaVersion < 1
  ) {
    return failure('RUNTIME_BUNDLE_MALFORMED');
  }
  if (value.schemaVersion !== EXECUTION_RUNTIME_BUNDLE_SCHEMA_VERSION) {
    return failure('RUNTIME_BUNDLE_SCHEMA_UNSUPPORTED');
  }
  if (
    typeof value.runtimeBundleVersion !== 'string' ||
    !/^rb1_[0-9a-f]{64}$/.test(value.runtimeBundleVersion)
  ) {
    return failure('RUNTIME_BUNDLE_MALFORMED');
  }
  const releaseRevision = parseReleaseRevision(value.releaseRevision);
  if (!releaseRevision) return failure('RUNTIME_BUNDLE_MALFORMED');
  const chronology = parseChronology(value);
  if (!chronology) return failure('RUNTIME_BUNDLE_TIME_INVALID');
  const compatibility = parseCompatibility(value.compatibility);
  if (!compatibility.ok) return compatibility;
  if (!parsePolicy(value.policy, releaseRevision)) {
    return failure('RUNTIME_BUNDLE_MALFORMED');
  }
  const rules = validateRulesRelease(value.rules, compatibility.value.rulesSchemaVersion);
  if (!rules.ok) return rules;
  const boundedCanonical = canonicalizeExecutionRuntimeJsonV1(value);
  if (
    !boundedCanonical.ok ||
    new TextEncoder().encode(boundedCanonical.value).byteLength > MAX_BUNDLE_JSON_BYTES
  ) {
    return failure('RUNTIME_BUNDLE_MALFORMED');
  }

  const minimum = options.minimumReleaseRevision === undefined
    ? null
    : parseReleaseRevision(options.minimumReleaseRevision);
  if (
    options.minimumReleaseRevision !== undefined &&
    (!minimum || BigInt(releaseRevision) < BigInt(minimum))
  ) {
    return failure('RUNTIME_BUNDLE_ROLLBACK_REJECTED');
  }

  const known = {
    schemaVersion: EXECUTION_RUNTIME_BUNDLE_SCHEMA_VERSION,
    runtimeBundleVersion: value.runtimeBundleVersion as ExecutionRuntimeBundleVersionV1,
    releaseRevision,
    ...chronology,
    compatibility: compatibility.value,
    policy: value.policy,
    rules: rules.value,
  } as const satisfies ExecutionRuntimeBundleV1;
  // 这一版不认识的顶层成员原样带着、不解释：整包摘要（下面）与调用方的规范正文校验都按
  // 送达的原样算，所以它们照样受摘要保护。认得的那些用校验过的值覆盖（JSON 上逐字相同）。
  const bundle: ExecutionRuntimeBundleV1 = { ...value, ...known };

  const digests = await verifyBundleDigests(
    bundle,
    options.sha256 ?? sha256ExecutionRuntimeCanonicalJsonV1,
  );
  if (!digests.ok) return digests;
  if (options.nowMs !== undefined) {
    const time = classifyExecutionRuntimeBundleTimeV1(
      bundle,
      options.nowMs,
      options.maxClockSkewMs,
    );
    if (!time.ok) return time;
  }
  return { ok: true, value: bundle };
}

/**
 * Raw transport decoder. Callers must use this instead of response.json() so
 * duplicate object keys cannot be collapsed before the exact parser sees them.
 */
export async function parseExecutionRuntimeBundleJsonV1(
  json: string,
  options: ParseExecutionRuntimeBundleOptionsV1 = {},
): Promise<ExecutionRuntimeBundleResult<ExecutionRuntimeBundleV1>> {
  if (typeof json !== 'string' || new TextEncoder().encode(json).byteLength > MAX_BUNDLE_JSON_BYTES) {
    return failure('RUNTIME_BUNDLE_MALFORMED');
  }
  try {
    if (!validateJsonSyntaxAndDuplicateKeys(json)) {
      return failure('RUNTIME_BUNDLE_MALFORMED');
    }
    return parseExecutionRuntimeBundleV1(JSON.parse(json), options);
  } catch {
    return failure('RUNTIME_BUNDLE_MALFORMED');
  }
}

export function parseExecutionRuntimeBundleEtagV1(
  etag: unknown,
  bundle: Pick<ExecutionRuntimeBundleV1, 'runtimeBundleVersion'>,
): ExecutionRuntimeBundleResult<
  ExecutionRuntimeBundleVersionV1,
  'RUNTIME_BUNDLE_ETAG_INVALID'
> {
  return typeof etag === 'string' && etag === `"${bundle.runtimeBundleVersion}"`
    ? { ok: true, value: bundle.runtimeBundleVersion }
    : failure('RUNTIME_BUNDLE_ETAG_INVALID');
}

/**
 * 一份**已经验过**的运行时包里，这一版读不了、因而忽略掉的东西，逐类一个稳定码（2026-09-28）。
 *
 * 只有码：不带键名、不带取值、不带厂商名——调用方原样记进诊断（RULE-GLOBAL-DATA-L1）。
 * 用途是让「后端先发、商店包还没跟上」的窗口在线上看得见：旧包正在忽略哪一类加法，
 * 而不是等有人报「某个功能没反应」。它不参与任何放行判断。
 */
export type ExecutionRuntimeBundleNoticeV1 =
  /** 整包顶层、`compatibility` 或 `policy` 里有这一版不认识的成员。 */
  | 'RUNTIME_BUNDLE_UNKNOWN_MEMBER_IGNORED'
  /** 能力位里有这一版不认识的键（读作关闭）。 */
  | 'RUNTIME_BUNDLE_UNKNOWN_CAPABILITY_IGNORED'
  /** 厂商位里有这一版不认识的厂商（下游按本地已知集合重建，进不来）。 */
  | 'RUNTIME_BUNDLE_UNKNOWN_VENDOR_IGNORED'
  /** 动作清单里有这一版不认识的动作（消费端只反查自己的动作）。 */
  | 'RUNTIME_BUNDLE_UNKNOWN_ACTION_IGNORED'
  /** 字段清单里有这一版不认识的档案字段键（后端加了字段，这个包还不会填它）。 */
  | 'RUNTIME_BUNDLE_UNKNOWN_FIELD_KEY_IGNORED'
  /** 自动化级别上限是这一版不认识的一档（mission 路按「超出上限」拒）。 */
  | 'RUNTIME_BUNDLE_UNKNOWN_AUTOMATION_LEVEL';

export function describeExecutionRuntimeBundleNoticesV1(
  bundle: ExecutionRuntimeBundleV1,
  /**
   * 这一版认得的档案字段键（调用方传 `APPLICATION_PROFILE_FIELD_KEYS`）。作为参数传进来，
   * 不在这里 import：这个模块的导入闭包是钉死的（field-lab 的运行时边界闸）。
   */
  knownFieldKeys: readonly string[],
): readonly ExecutionRuntimeBundleNoticeV1[] {
  const notices = new Set<ExecutionRuntimeBundleNoticeV1>();
  const extra = (value: object, known: readonly string[]): boolean =>
    Object.keys(value).some((key) => !known.includes(key));
  if (
    extra(bundle, OUTER_KEYS) ||
    extra(bundle.compatibility, COMPATIBILITY_KEYS) ||
    extra(bundle.policy, POLICY_KEYS)
  ) notices.add('RUNTIME_BUNDLE_UNKNOWN_MEMBER_IGNORED');
  if (extra(bundle.policy.capabilities, EXECUTION_RUNTIME_WRITE_CAPABILITIES)) {
    notices.add('RUNTIME_BUNDLE_UNKNOWN_CAPABILITY_IGNORED');
  }
  if (extra(bundle.policy.vendors, EXECUTION_RUNTIME_POLICY_VENDORS)) {
    notices.add('RUNTIME_BUNDLE_UNKNOWN_VENDOR_IGNORED');
  }
  if (bundle.policy.allowedActions.some((action) => !isMember(action, EXECUTION_RUNTIME_POLICY_ACTIONS))) {
    notices.add('RUNTIME_BUNDLE_UNKNOWN_ACTION_IGNORED');
  }
  if (bundle.policy.allowedFieldKeys.some((key) => !knownFieldKeys.includes(key))) {
    notices.add('RUNTIME_BUNDLE_UNKNOWN_FIELD_KEY_IGNORED');
  }
  if (!isMember(bundle.policy.automationLevelCeiling, AUTOMATION_LEVELS)) {
    notices.add('RUNTIME_BUNDLE_UNKNOWN_AUTOMATION_LEVEL');
  }
  return Object.freeze([...notices].sort());
}

/** Small strict JSON grammar pass used only to preserve duplicate-key evidence. */
function validateJsonSyntaxAndDuplicateKeys(source: string): boolean {
  let index = 0;
  const whitespace = () => {
    while (index < source.length && /[\u0009\u000a\u000d\u0020]/.test(source[index]!)) index += 1;
  };
  const stringToken = (): string | null => {
    if (source[index] !== '"') return null;
    const start = index;
    index += 1;
    while (index < source.length) {
      const character = source[index]!;
      if (character === '"') {
        index += 1;
        try {
          const decoded = JSON.parse(source.slice(start, index));
          return typeof decoded === 'string' && hasWellFormedUnicode(decoded) ? decoded : null;
        } catch {
          return null;
        }
      }
      if (character.charCodeAt(0) <= 0x1f) return null;
      if (character === '\\') {
        index += 1;
        const escaped = source[index];
        if (!escaped || !'"\\/bfnrtu'.includes(escaped)) return null;
        if (escaped === 'u') {
          const hex = source.slice(index + 1, index + 5);
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) return null;
          index += 4;
        }
      }
      index += 1;
    }
    return null;
  };
  const literal = (token: string): boolean => {
    if (source.slice(index, index + token.length) !== token) return false;
    index += token.length;
    return true;
  };
  const number = (): boolean => {
    const match = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/.exec(source.slice(index));
    if (!match) return false;
    index += match[0].length;
    return true;
  };
  const value = (depth: number): boolean => {
    if (depth > MAX_JSON_DEPTH) return false;
    whitespace();
    const character = source[index];
    if (character === '{') return object(depth);
    if (character === '[') return array(depth);
    if (character === '"') return stringToken() !== null;
    if (character === 't') return literal('true');
    if (character === 'f') return literal('false');
    if (character === 'n') return literal('null');
    return number();
  };
  const object = (depth: number): boolean => {
    index += 1;
    whitespace();
    const keys = new Set<string>();
    if (source[index] === '}') {
      index += 1;
      return true;
    }
    while (index < source.length) {
      whitespace();
      const key = stringToken();
      if (key === null || keys.has(key) || FORBIDDEN_JSON_KEYS.has(key)) return false;
      keys.add(key);
      whitespace();
      if (source[index] !== ':') return false;
      index += 1;
      if (!value(depth + 1)) return false;
      whitespace();
      if (source[index] === '}') {
        index += 1;
        return true;
      }
      if (source[index] !== ',') return false;
      index += 1;
    }
    return false;
  };
  const array = (depth: number): boolean => {
    index += 1;
    whitespace();
    if (source[index] === ']') {
      index += 1;
      return true;
    }
    while (index < source.length) {
      if (!value(depth + 1)) return false;
      whitespace();
      if (source[index] === ']') {
        index += 1;
        return true;
      }
      if (source[index] !== ',') return false;
      index += 1;
    }
    return false;
  };
  whitespace();
  const valid = value(0);
  whitespace();
  return valid && index === source.length;
}

// Keep the otherwise-imported complete ATS provider closed set in the type graph;
// INDEED_APPLY is deliberately absent from the mapped subset and therefore fails closed.
void ATS_PROVIDER_CODES;
