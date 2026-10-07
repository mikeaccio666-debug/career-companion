import { installApplyAdapters } from '@edaix/apply-kernel/registry';
/**
 * Execution runtime authority shared by the MV3 worker and isolated content
 * script.  The worker binds an already verified ExecutionIntent to one exact
 * backend mapping; the content script independently re-parses the atomic cache
 * before it may inspect or mutate the host DOM.
 *
 * This module is deliberately value-free.  It carries only versions, stable
 * identifiers, field keys, and rule digests.  No URL, page HTML, profile value,
 * JWS, or lease crosses this boundary.
 */

import {
  AUTOMATION_LEVELS,
  EXECUTION_RUNTIME_AUTHORIZATION_KEYS,
  parseExecutionRuntimeAuthorizationV1,
  type ExecutionRuntimeAuthorizationV1,
  canonicalizeExecutionRuntimeJsonV1,
  compareExecutionRuntimeSemverV1,
  EXECUTION_RUNTIME_MAPPED_ATS_PROVIDERS,
  EXECUTION_RUNTIME_POLICY_ACTIONS,
  EXECUTION_RUNTIME_POLICY_VENDORS,
  EXECUTION_RUNTIME_WRITE_CAPABILITIES,
  parseExecutionRuntimeBundleEtagV1,
  parseExecutionRuntimeBundleJsonV1,
  type AutomationLevel,
  type ExecutionAllowedAction,
  type ExecutionRuntimeActiveVendor,
  type ExecutionRuntimeBundleV1,
  type ExecutionRuntimeMappedAtsProvider,
} from '@edaix/contracts';
import {
  applyAdaptersFromRuntimeRegistry,
  createRuntimeApplyRegistry,
  createRuntimeApplyMetadataRegistry,
  resolveRuntimeApplyMapping,
  readRuntimeApplyWizardDeclaration,
  resolveRuntimeApplyAdapter,
  type ResolvedRuntimeApplyAdapter,
} from '@edaix/apply-kernel/runtimeRegistry';
import type { WizardReadOnlyDeclaration } from '@edaix/apply-kernel/wizardIdentity';
import { LOCAL_AUTOMATION_DENIED_HOST_SUFFIXES, type ApplyPolicy } from '@edaix/apply-kernel/policy';
import type { WriteCapability } from '@edaix/apply-kernel/grant';
import type {
  ExecutionRuntimeBundleClient,
  ExecutionRuntimeBundleResolution,
} from './executionRuntimeBundleClient';

export const EXECUTION_RUNTIME_AUTHORITY_CODES = [
  'RUNTIME_AUTHORITY_UNAVAILABLE',
  'RUNTIME_AUTHORITY_INTENT_MISMATCH',
  'RUNTIME_AUTHORITY_MAPPING_UNAVAILABLE',
  'RUNTIME_AUTHORITY_POLICY_DISABLED',
  'RUNTIME_AUTHORITY_DRIFTED',
] as const;
export type ExecutionRuntimeAuthorityCode =
  (typeof EXECUTION_RUNTIME_AUTHORITY_CODES)[number];

export type ExecutionRuntimeAuthorityResult<T> =
  | Readonly<{ ok: true; value: T }>
  | Readonly<{ ok: false; code: ExecutionRuntimeAuthorityCode }>;

/** Value-free facts copied only from a locally verified ExecutionIntent. */
export interface VerifiedIntentRuntimeTarget {
  readonly canonicalOrigin: string;
  readonly atsProvider: string;
  readonly pathRuleId: string;
  readonly policyVersion: string;
  readonly killSwitchVersion: string;
  readonly automationLevel: AutomationLevel;
  readonly allowedActions: readonly ExecutionAllowedAction[];
  readonly fieldKeys: readonly string[];
}

/**
 * Small selector-free bridge binding.  The complete ruleset remains in the
 * one-key storage record; this object only proves which exact slice was chosen.
 */
export const RUNTIME_AUTHORIZATION_PURPOSES = ['DISCOVERY', 'EXECUTION'] as const;
export type RuntimeAuthorizationPurpose =
  (typeof RUNTIME_AUTHORIZATION_PURPOSES)[number];

export type RuntimeExecutionAuthorization = ExecutionRuntimeAuthorizationV1;

export type DiscoveryRuntimeAuthorization = RuntimeExecutionAuthorization &
  Readonly<{ purpose: 'DISCOVERY' }>;

export interface ResolvedContentRuntimeAuthority {
  readonly authorization: RuntimeExecutionAuthorization;
  readonly mapping: ResolvedRuntimeApplyAdapter;
  readonly policy: ApplyPolicy;
  /** Content-local expiry fences from the exact verified bundle; never serialized. */
  readonly freshUntilMs: number;
  readonly notAfterMs: number;
  readonly allowedActions: readonly string[];
  readonly allowedFieldKeys: readonly string[];
}

/** Read-only content authority. Its host policy is physically write-disabled. */
export interface ResolvedContentDiscoveryRuntimeAuthority {
  readonly authorization: DiscoveryRuntimeAuthorization;
  readonly mapping: ResolvedRuntimeApplyAdapter;
  readonly hostPolicy: ApplyPolicy;
  /**
   * 无 mission 那条手势填写用的**写**策略。
   *
   * 为什么与 `hostPolicy` 分成两份：`hostPolicy` 是识别用的，它的厂商位与能力位
   * 被物理清零，拿它去写等于一个字都写不了。而手势路要真的落字，就必须有一份
   * 带能力位的策略——那份策略**只能来自后端下发的同一个 bundle**，并且要过
   * 与 mission 那条路逐字相同的两道闸（`policy.enabled` ∧ `FILL` ∈ allowedActions
   * ∧ 该厂商开着）。闸不过就退回物理写禁用的那一份，于是 fail closed。
   *
   * 分工是清楚的：**手势证明「用户要填」，bundle 决定「准许写什么」**。两者缺一
   * 不可，谁都不能替对方作数。这也是为什么这里不允许退回包内 policy——
   * RULE-GLOBAL-HIGH-RISK-FAIL-CLOSED：不得以本地默认值推断 production 已放行。
   */
  readonly fillPolicy: ApplyPolicy;
  readonly freshUntilMs: number;
  readonly notAfterMs: number;
  readonly allowedFieldKeys: readonly string[];
}

export interface ResolvedContentWizardRuntimeAuthority {
  readonly authorization: DiscoveryRuntimeAuthorization;
  readonly freshUntilMs: number;
  readonly notAfterMs: number;
}
const verifiedWizardDeclarations = new WeakMap<ResolvedContentWizardRuntimeAuthority, WizardReadOnlyDeclaration>();

/** Content-local interpreter seam; copied or caller-shaped authorities fail closed. */
export function readResolvedDiscoveryWizardDeclaration(
  authority: ResolvedContentWizardRuntimeAuthority,
): WizardReadOnlyDeclaration | null {
  return verifiedWizardDeclarations.get(authority) ?? null;
}

export interface BackgroundExecutionRuntimeAuthority {
  authorize(
    target: VerifiedIntentRuntimeTarget,
  ): Promise<ExecutionRuntimeAuthorityResult<RuntimeExecutionAuthorization>>;
  /** Read-only lane: provider/path still come from the verified backend target. */
  authorizeDiscovery(
    target: Pick<VerifiedIntentRuntimeTarget, 'atsProvider' | 'pathRuleId'>,
  ): Promise<ExecutionRuntimeAuthorityResult<DiscoveryRuntimeAuthorization>>;
  /**
   * 同一条只读道，但目标由**这一页的厂商**解出，而不是由已验签 intent 给出。
   *
   * 无 mission 那条填写路要用它：用户站在一家我们认得的申请页上按 Autofill，
   * 没有 intent，也就没有 `(atsProvider, pathRuleId)` 可抄。而 worker 本来就靠
   * 下发的装入表判断这一页认不认得出（dock 的脸就是这么算的），所以它能从同一份
   * bundle 里解出同一条映射。
   *
   * 关键是**它什么都没放松**：映射仍然只从后端下发的 bundle 里取，厂商的
   * discovery 开关仍然要开，签出来的仍然是 purpose=DISCOVERY 的只读授权
   * （宿主策略物理禁用，写入 runner 消费不了它）。换掉的只有「目标从哪来」。
   *
   * 一个厂商对应多条映射时（greenhouse 就有 v1 与 v3 两条）要求它们**指向同一份
   * ruleset**，否则拒——两份不同的规则意味着这一页该用哪一份是不确定的，
   * 而拿错规则去解析比解析不出更坏。
   */
  authorizeDiscoveryForVendor(
    vendor: string,
  ): Promise<ExecutionRuntimeAuthorityResult<DiscoveryRuntimeAuthorization>>;
  /**
   * 这一家此刻的写策略（2026-09-28：招聘网站账号的第一把钥匙，worker 在交出密码之前判 `account-access`）。与
   * `authorizeDiscoveryForVendor` 同一份包、同一条映射，只读策略本身：不编译规则、不签授权。这一家的填写没放行、取不到
   * 包、映射说不清，都是 null——当关（RULE-GLOBAL-HIGH-RISK-FAIL-CLOSED）。
   */
  fillPolicyForVendor(vendor: string): Promise<ApplyPolicy | null>;
  revalidate(authorization: RuntimeExecutionAuthorization): Promise<boolean>;
}

const AUTHORIZATION_KEYS = EXECUTION_RUNTIME_AUTHORIZATION_KEYS;
const STORE_KEYS = [
  'schemaVersion',
  'etag',
  'runtimeBundleVersion',
  'releaseRevision',
  'rawBody',
] as const;
/**
 * Code-owned interpreter ceiling.  Unlike `createBundledApplyPolicy`, this has
 * no clock, entitlement, or fallback semantics: the remote bundle is the sole
 * availability authority, while this record can only remove capabilities the
 * installed code is not allowed to execute.
 */
const CODE_COMPATIBILITY_CEILING = Object.freeze({
  vendors: Object.freeze({
    greenhouse: true,
    lever: true,
    ashby: true,
    workable: true,
    workday: true,
    icims: true,
    smartrecruiters: true,
    bamboohr: true,
    // 2026-09-22 放行：这三家的规则与适配器早就在仓里、ats-lab 在真实在招岗位上实测能填，
    // 只是从来没进过运行时发布（argoland 那一刀）。天花板漏一个键，那一家在投影里就不存在。
    dover: true,
    jobvite: true,
    rippling: true,
    avature: false,
    // 2026-09-22 放行：通用路已接上（`pageVendor` 的第三层）。这一位只说「这份代码
    // 执行得了」，不说「这一页可以用」——后者仍由后端包的 GENERIC 精确映射与 policy
    // 厂商位决定，两道缺一道就装不上适配器。
    generic: true,
  }),
  /**
   * 能力位天花板必须**穷尽** wire 上的十个位（2026-09-21 查到，与内核 policy.ts 2026-08-19
   * 踩的是同一个坑）：`remoteApplyPolicy` 按这张表的键重建能力表，这里漏一个键，那一位在
   * 投影里就**不存在**——读出来 undefined，任何 `=== true` 的判断都关着。argoland 09-18 放行的
   * 自我认同 / 工作授权 / 富文本因此从来没到过内核。`satisfies Record<WriteCapability, boolean>`
   * 让漏键变成编译错误，不再靠人记得。
   */
  capabilities: Object.freeze({
    'set-text': true,
    'set-select': true,
    'set-combobox': true,
    'set-richtext': true,
    // 加行（P1-8b）：内核有了专用铸造路径（只许 row-add）与「加一行 → 重扫 → 填这一行」的编排，
    // 代码这边能做；真开不开由远程策略的这一位说了算（RULE-GLOBAL-HIGH-RISK-FAIL-CLOSED）。
    'manage-rows': true,
    'set-file': true,
    'set-other-person': false,
    'set-attestation': false,
    'set-self-identification': true,
    'set-work-authorization': true,
    // 推荐人（P1-9）：数据源是用户亲手存的推荐人清单，只预填姓名、等用户点头；真开不开由远程策略说了算。
    'set-referral': true,
    // 翻页（2026-09-22）：代码这边能做（内核 wizardAdvance 找唯一那颗、内容脚本在用户那一次点击里按）；
    // 真开不开由远程策略的这一位说了算。
    'advance-step': true,
    // 连填（2026-09-28）：代码这边能做（内核的一轮连填：一次点击开、同页同申请同厂商、总时限与页数上限、每页一张
    // 「这一页」凭证；内容脚本只按内核认出的那一颗翻页按钮，最终提交所在的那一页不翻）；真开不开由远程策略的这一位说了算。
    'advance-steps': true,
    // 代填条款、声明与签名（2026-09-23）：代码这边能做（内核的整句判据、原生点击与写前复核）；
    // 真开不开由远程策略的这一位说了算，而且每个用户还得在资料页单独同意过。
    'sign-on-behalf': true,
    // 在插件里提交（2026-09-23）：代码这边能做（只按规则声明的最终提交控件、只在用户按下「提交」
    // 的那一刻）；真开不开由远程策略的这一位说了算。
    'submit-application': true,
    // 替用户注册、登录招聘网站（2026-09-28）：代码这边能做（只在规则声明的账号墙上、只写规则声明的那几格、只按规则声明的
    // 那几颗；密码只存在这台电脑上）；真开不开由远程策略的这一位说了算，而且每个用户还得同意过点名这一类的那一版文案。
    'account-access': true,
  } satisfies Readonly<Record<WriteCapability, boolean>>),
  minConfidence: 0.7,
  inferredRequiresConfirm: true,
});

const EXPECTED_VENDOR = {
  ASHBY: 'ashby',
  BAMBOOHR: 'bamboohr',
  DOVER: 'dover',
  GREENHOUSE: 'greenhouse',
  ICIMS: 'icims',
  JOBVITE: 'jobvite',
  LEVER: 'lever',
  RIPPLING: 'rippling',
  SMARTRECRUITERS: 'smartrecruiters',
  WORKABLE: 'workable',
  WORKDAY: 'workday',
  GENERIC: 'generic',
} as const satisfies Record<ExecutionRuntimeMappedAtsProvider, ExecutionRuntimeActiveVendor>;

export function parseRuntimeExecutionAuthorization(
  value: unknown,
): RuntimeExecutionAuthorization | null {
  return parseExecutionRuntimeAuthorizationV1(value);
}

export function sameRuntimeExecutionAuthorization(
  left: RuntimeExecutionAuthorization,
  right: RuntimeExecutionAuthorization,
): boolean {
  return AUTHORIZATION_KEYS.every((key) => left[key] === right[key]);
}

/**
 * Worker-side authority. Every scan performs a conditional refresh. Cached
 * bytes can authorize only when this refresh receives the exact server 304;
 * network failure, timeout, or any rejected response remains unavailable.
 */
export function createBackgroundExecutionRuntimeAuthority(input: Readonly<{
  client: ExecutionRuntimeBundleClient;
}>): BackgroundExecutionRuntimeAuthority {
  async function authorize(
    target: VerifiedIntentRuntimeTarget,
  ): Promise<ExecutionRuntimeAuthorityResult<RuntimeExecutionAuthorization>> {
    const resolved = await safeRefresh(input.client);
    if (!resolved.ok) return failure('RUNTIME_AUTHORITY_UNAVAILABLE');
    return authorizeBundleForIntent(resolved.bundle, target);
  }

  async function revalidate(authorization: RuntimeExecutionAuthorization): Promise<boolean> {
    const expected = parseRuntimeExecutionAuthorization(authorization);
    if (expected === null) return false;
    const resolved = await safeRefresh(input.client);
    if (!resolved.ok) return false;
    const current = await authorizationForMapping(resolved.bundle, {
      atsProvider: expected.atsProvider,
      pathRuleId: expected.pathRuleId,
    }, expected.purpose);
    if (!current.ok || !sameRuntimeExecutionAuthorization(current.value, expected)) {
      return false;
    }
    return expected.purpose === 'DISCOVERY'
      ? isBundleDiscoveryEnabled(resolved.bundle, expected.vendor)
      : isBundleFillEnabled(resolved.bundle, expected.vendor);
  }

  async function authorizeDiscovery(
    target: Pick<VerifiedIntentRuntimeTarget, 'atsProvider' | 'pathRuleId'>,
  ): Promise<ExecutionRuntimeAuthorityResult<DiscoveryRuntimeAuthorization>> {
    const resolved = await safeRefresh(input.client);
    if (!resolved.ok) return failure('RUNTIME_AUTHORITY_UNAVAILABLE');
    const authorization = await authorizationForMapping(
      resolved.bundle,
      target,
      'DISCOVERY',
    );
    if (!authorization.ok) return failure(authorization.code);
    if (!isDiscoveryRuntimeAuthorization(authorization.value)) {
      return failure('RUNTIME_AUTHORITY_DRIFTED');
    }
    if (!isBundleDiscoveryEnabled(resolved.bundle, authorization.value.vendor)) {
      return failure('RUNTIME_AUTHORITY_POLICY_DISABLED');
    }
    return Object.freeze({ ok: true, value: authorization.value });
  }

  async function authorizeDiscoveryForVendor(
    vendor: string,
  ): Promise<ExecutionRuntimeAuthorityResult<DiscoveryRuntimeAuthorization>> {
    const resolved = await safeRefresh(input.client);
    if (!resolved.ok) return failure('RUNTIME_AUTHORITY_UNAVAILABLE');
    const registry = await createRuntimeApplyMetadataRegistry(resolved.bundle.rules);
    if (!registry.ok) return failure('RUNTIME_AUTHORITY_MAPPING_UNAVAILABLE');
    const matches = registry.value.mappings.filter((mapping) => mapping.vendor === vendor);
    if (matches.length === 0) return failure('RUNTIME_AUTHORITY_MAPPING_UNAVAILABLE');
    // 多条映射必须指向同一份 ruleset。不等就是「这一页该用哪一份规则」不确定，
    // 而拿错规则去解析比解析不出更坏（FINDING-AF-002 同一条道理）。
    const first = matches[0]!;
    if (matches.some((mapping) =>
      mapping.rulesetVersion !== first.rulesetVersion ||
      mapping.rulesetDigest !== first.rulesetDigest
    )) return failure('RUNTIME_AUTHORITY_MAPPING_UNAVAILABLE');
    return authorizeDiscovery({ atsProvider: first.atsProvider, pathRuleId: first.pathRuleId });
  }

  async function fillPolicyForVendor(vendor: string): Promise<ApplyPolicy | null> {
    const authorized = await authorizeDiscoveryForVendor(vendor);
    if (!authorized.ok) return null;
    const resolved = await safeRefresh(input.client);
    if (!resolved.ok || !isBundleFillEnabled(resolved.bundle, authorized.value.vendor)) return null;
    return remoteApplyPolicy(resolved.bundle);
  }

  return Object.freeze({ authorize, authorizeDiscovery, authorizeDiscoveryForVendor, fillPolicyForVendor, revalidate });
}

export async function resolveStoredExecutionRuntimeAuthority(input: Readonly<{
  stored: unknown;
  authorization: unknown;
  nowMs: number;
  extensionVersion: string;
}>): Promise<ExecutionRuntimeAuthorityResult<ResolvedContentRuntimeAuthority>> {
  const binding = await resolveStoredRuntimeBinding(input);
  if (!binding.ok) return binding;
  if (binding.value.authorization.purpose !== 'EXECUTION') {
    return failure('RUNTIME_AUTHORITY_POLICY_DISABLED');
  }
  if (!isBundleFillEnabled(binding.value.bundle, binding.value.mapping.vendor)) {
    return failure('RUNTIME_AUTHORITY_POLICY_DISABLED');
  }

  const policy = remoteApplyPolicy(binding.value.bundle);
  return {
    ok: true,
    value: Object.freeze({
      authorization: binding.value.authorization,
      mapping: binding.value.mapping,
      policy,
      freshUntilMs: Date.parse(binding.value.bundle.freshUntil),
      notAfterMs: Date.parse(binding.value.bundle.notAfter),
      allowedActions: binding.value.bundle.policy.allowedActions,
      allowedFieldKeys: binding.value.bundle.policy.allowedFieldKeys,
    }),
  };
}

export async function resolveStoredDiscoveryRuntimeAuthority(input: Readonly<{
  stored: unknown;
  authorization: unknown;
  nowMs: number;
  extensionVersion: string;
}>): Promise<ExecutionRuntimeAuthorityResult<ResolvedContentDiscoveryRuntimeAuthority>> {
  const binding = await resolveStoredRuntimeBinding(input);
  if (!binding.ok) return binding;
  const authorization = binding.value.authorization;
  if (!isDiscoveryRuntimeAuthorization(authorization)) {
    return failure('RUNTIME_AUTHORITY_POLICY_DISABLED');
  }
  if (!isBundleDiscoveryEnabled(binding.value.bundle, binding.value.mapping.vendor)) {
    return failure('RUNTIME_AUTHORITY_POLICY_DISABLED');
  }

  const value = Object.freeze({
      authorization,
      mapping: binding.value.mapping,
      hostPolicy: remoteReadOnlyDiscoveryPolicy(binding.value.bundle),
      fillPolicy: isBundleFillEnabled(binding.value.bundle, binding.value.mapping.vendor)
        ? remoteApplyPolicy(binding.value.bundle)
        : remoteReadOnlyDiscoveryPolicy(binding.value.bundle),
      freshUntilMs: Date.parse(binding.value.bundle.freshUntil),
      notAfterMs: Date.parse(binding.value.bundle.notAfter),
      allowedFieldKeys: binding.value.bundle.policy.allowedFieldKeys,
  });
  const declaration = readRuntimeApplyWizardDeclaration(binding.value.mapping);
  if (declaration) verifiedWizardDeclarations.set(value, declaration);
  return { ok: true, value };
}

/** Same stored-bundle proof, without creating an unused form execution adapter. */
export async function resolveStoredWizardRuntimeAuthority(input: Readonly<{
  stored: unknown; authorization: unknown; nowMs: number; extensionVersion: string;
}>): Promise<ExecutionRuntimeAuthorityResult<ResolvedContentWizardRuntimeAuthority>> {
  const proof = await resolveStoredRuntimeProof(input);
  if (!proof.ok) return proof;
  const { authorization, bundle } = proof.value;
  if (!isDiscoveryRuntimeAuthorization(authorization) || !isBundleDiscoveryEnabled(bundle, authorization.vendor)) {
    return failure('RUNTIME_AUTHORITY_POLICY_DISABLED');
  }
  const registry = await createRuntimeApplyMetadataRegistry(bundle.rules);
  if (!registry.ok) return failure('RUNTIME_AUTHORITY_MAPPING_UNAVAILABLE');
  const mapping = resolveRuntimeApplyMapping(registry.value, authorization);
  if (!mapping.ok) return failure('RUNTIME_AUTHORITY_MAPPING_UNAVAILABLE');
  const declaration = readRuntimeApplyWizardDeclaration(mapping.value);
  if (!declaration) return failure('RUNTIME_AUTHORITY_MAPPING_UNAVAILABLE');
  const value = Object.freeze({ authorization, freshUntilMs: Date.parse(bundle.freshUntil), notAfterMs: Date.parse(bundle.notAfter) });
  verifiedWizardDeclarations.set(value, declaration);
  return { ok: true, value };
}

type StoredRuntimeBinding = Readonly<{
  authorization: RuntimeExecutionAuthorization;
  bundle: ExecutionRuntimeBundleV1;
  mapping: ResolvedRuntimeApplyAdapter;
}>;

async function resolveStoredRuntimeBinding(input: Readonly<{
  stored: unknown;
  authorization: unknown;
  nowMs: number;
  extensionVersion: string;
}>): Promise<ExecutionRuntimeAuthorityResult<StoredRuntimeBinding>> {
  const proof = await resolveStoredRuntimeProof(input);
  if (!proof.ok) return proof;
  const registry = await createRuntimeApplyRegistry(proof.value.bundle.rules);
  if (!registry.ok) return failure('RUNTIME_AUTHORITY_MAPPING_UNAVAILABLE');
  const mapping = resolveRuntimeApplyAdapter(registry.value, proof.value.authorization);
  if (!mapping.ok) return failure('RUNTIME_AUTHORITY_MAPPING_UNAVAILABLE');
  return { ok: true, value: Object.freeze({ ...proof.value, mapping: mapping.value }) };
}

async function resolveStoredRuntimeProof(input: Readonly<{
  stored: unknown; authorization: unknown; nowMs: number; extensionVersion: string;
}>): Promise<ExecutionRuntimeAuthorityResult<Omit<StoredRuntimeBinding, 'mapping'>>> {
  const expected = parseRuntimeExecutionAuthorization(input.authorization);
  if (expected === null || !isExactRecord(input.stored, STORE_KEYS)) {
    return failure('RUNTIME_AUTHORITY_UNAVAILABLE');
  }
  if (
    input.stored.schemaVersion !== 1 ||
    typeof input.stored.etag !== 'string' ||
    typeof input.stored.runtimeBundleVersion !== 'string' ||
    typeof input.stored.releaseRevision !== 'string' ||
    typeof input.stored.rawBody !== 'string'
  ) return failure('RUNTIME_AUTHORITY_UNAVAILABLE');

  const parsed = await parseExecutionRuntimeBundleJsonV1(input.stored.rawBody, {
    nowMs: input.nowMs,
  });
  if (!parsed.ok) return failure('RUNTIME_AUTHORITY_UNAVAILABLE');
  const canonical = canonicalizeExecutionRuntimeJsonV1(parsed.value);
  if (
    !canonical.ok ||
    canonical.value !== input.stored.rawBody ||
    parsed.value.runtimeBundleVersion !== input.stored.runtimeBundleVersion ||
    parsed.value.releaseRevision !== input.stored.releaseRevision ||
    !parseExecutionRuntimeBundleEtagV1(input.stored.etag, parsed.value).ok
  ) {
    return failure('RUNTIME_AUTHORITY_UNAVAILABLE');
  }
  if (!isVersionAtLeast(input.extensionVersion, parsed.value.compatibility.minExtensionVersion)) {
    return failure('RUNTIME_AUTHORITY_UNAVAILABLE');
  }

  const current = await authorizationForMapping(parsed.value, {
    atsProvider: expected.atsProvider,
    pathRuleId: expected.pathRuleId,
  }, expected.purpose);
  if (!current.ok || !sameRuntimeExecutionAuthorization(current.value, expected)) {
    return failure('RUNTIME_AUTHORITY_DRIFTED');
  }
  return {
    ok: true,
    value: Object.freeze({
      authorization: expected,
      bundle: parsed.value,
    }),
  };
}

async function authorizeBundleForIntent(
  bundle: ExecutionRuntimeBundleV1,
  target: VerifiedIntentRuntimeTarget,
): Promise<ExecutionRuntimeAuthorityResult<RuntimeExecutionAuthorization>> {
  if (
    bundle.policy.version !== target.policyVersion ||
    bundle.releaseRevision !== target.killSwitchVersion ||
    !target.allowedActions.includes('FILL') ||
    !target.allowedActions.every((action) => bundle.policy.allowedActions.includes(action)) ||
    !target.fieldKeys.every((key) =>
      (bundle.policy.allowedFieldKeys as readonly string[]).includes(key)) ||
    // 上限是这一版不认识的一档：排不上位，按超出上限拒（不猜它比哪一档高）。
    automationRank(bundle.policy.automationLevelCeiling) < 0 ||
    automationRank(target.automationLevel) > automationRank(bundle.policy.automationLevelCeiling)
  ) return failure('RUNTIME_AUTHORITY_INTENT_MISMATCH');

  const authorization = await authorizationForMapping(bundle, target, 'EXECUTION');
  if (!authorization.ok) return authorization;
  if (!isBundleFillEnabled(bundle, authorization.value.vendor)) {
    return failure('RUNTIME_AUTHORITY_POLICY_DISABLED');
  }
  return authorization;
}

async function authorizationForMapping(
  bundle: ExecutionRuntimeBundleV1,
  target: Pick<VerifiedIntentRuntimeTarget, 'atsProvider' | 'pathRuleId'>,
  purpose: RuntimeAuthorizationPurpose,
): Promise<ExecutionRuntimeAuthorityResult<RuntimeExecutionAuthorization>> {
  const registry = await createRuntimeApplyMetadataRegistry(bundle.rules);
  if (!registry.ok) return failure('RUNTIME_AUTHORITY_MAPPING_UNAVAILABLE');
  const mapping = resolveRuntimeApplyMapping(registry.value, target);
  if (!mapping.ok) return failure('RUNTIME_AUTHORITY_MAPPING_UNAVAILABLE');

  return {
    ok: true,
    value: Object.freeze({
      schemaVersion: 1,
      purpose,
      runtimeBundleVersion: bundle.runtimeBundleVersion,
      releaseRevision: bundle.releaseRevision,
      policyVersion: bundle.policy.version,
      rulesReleaseVersion: bundle.rules.releaseVersion,
      rulesReleaseDigest: bundle.rules.releaseDigest,
      atsProvider: mapping.value.atsProvider,
      pathRuleId: mapping.value.pathRuleId,
      vendor: mapping.value.vendor,
      rulesetVersion: mapping.value.rulesetVersion,
      rulesetDigest: mapping.value.rulesetDigest,
    }),
  };
}

/**
 * 这一份包此刻放行了哪几家（只读识别也算：`isBundleDiscoveryEnabled`）。浮层的脸据此判「这类网站还没开放自动填写」
 * （2026-10-04，bench-1003：生产包还没放行公司自建表单时，浮层照样亮着「自动填写」，按下去才说「暂时连不上 ArgoLand」）。
 * 只用来**少**亮一颗按钮：它说开着，填写那一刻照旧重新取包、重新判（`authorizeDiscoveryForVendor`）。
 */
export function bundleOpenVendors(bundle: ExecutionRuntimeBundleV1): ReadonlySet<string> {
  return new Set(EXECUTION_RUNTIME_POLICY_VENDORS.filter((vendor) =>
    isBundleDiscoveryEnabled(bundle, vendor as ExecutionRuntimeActiveVendor)));
}

function isBundleDiscoveryEnabled(
  bundle: ExecutionRuntimeBundleV1,
  vendor: ExecutionRuntimeActiveVendor,
): boolean {
  if (!bundle.policy.enabled || bundle.policy.vendors[vendor] !== true) return false;
  // A normal execution release already needs a read-only prerequisite scan.
  if (bundle.policy.allowedActions.includes('FILL')) return true;
  // VM1b discovery-only profile: the versioned backend policy must explicitly
  // select L0, grant zero executable actions, and disable every write
  // capability. An empty action list alone is never treated as authority.
  //
  // 2026-09-28：「零动作、零能力」按**这一版认得的**动作与能力位数。后端在只读档里多发一个
  // 这一版不认识的动作或能力位，旧包本来就执行不了它（策略按本地已知集合重建），不该因此
  // 连只读识别也一起关掉。认得的那些照旧一个都不许开。
  return bundle.policy.automationLevelCeiling === 'L0_PREVIEW_ONLY' &&
    !bundle.policy.allowedActions.some((action) =>
      (EXECUTION_RUNTIME_POLICY_ACTIONS as readonly string[]).includes(action)) &&
    EXECUTION_RUNTIME_WRITE_CAPABILITIES.every((capability) =>
      bundle.policy.capabilities[capability] !== true);
}

function isDiscoveryRuntimeAuthorization(
  value: RuntimeExecutionAuthorization,
): value is DiscoveryRuntimeAuthorization {
  return value.purpose === 'DISCOVERY';
}

function isBundleFillEnabled(
  bundle: ExecutionRuntimeBundleV1,
  vendor: ExecutionRuntimeActiveVendor,
): boolean {
  return bundle.policy.enabled &&
    bundle.policy.allowedActions.includes('FILL') &&
    bundle.policy.vendors[vendor] === true;
}

function remoteApplyPolicy(bundle: ExecutionRuntimeBundleV1): ApplyPolicy {
  // 两个记录都从**本地已知的键集**构建，不从下发包的键集构建。下发包的能力位
  // 与厂商位现在都是可缺席的（见契约里的容错读法），所以：
  //  - 包里没有的键 → 这里读到 undefined → `=== true` 判 false，等于关闭；
  //  - 包里多出来的键 → 根本不在循环里，不会被带进本地策略。
  // 逐项与本地能力上限做与运算，得到的是真正的 boolean，不再需要 as 断言去
  // 掩盖 `undefined`——之前那两个断言让类型说了谎。
  const vendors = Object.fromEntries(
    EXECUTION_RUNTIME_POLICY_VENDORS.map((vendor) => [
      vendor,
      bundle.policy.vendors[vendor] === true && CODE_COMPATIBILITY_CEILING.vendors[vendor] === true,
    ]),
  ) as ApplyPolicy['vendors'];
  const capabilities = Object.fromEntries(
    (Object.keys(CODE_COMPATIBILITY_CEILING.capabilities) as readonly (
      keyof typeof CODE_COMPATIBILITY_CEILING.capabilities
    )[]).map((capability) => [
      capability,
      bundle.policy.capabilities[capability] === true &&
        CODE_COMPATIBILITY_CEILING.capabilities[capability] === true,
    ]),
  ) as ApplyPolicy['capabilities'];
  return Object.freeze({
    version: bundle.policy.version,
    minExtensionVersion: bundle.compatibility.minExtensionVersion,
    enabled: bundle.policy.enabled && bundle.policy.allowedActions.includes('FILL'),
    vendors: Object.freeze(vendors),
    capabilities: Object.freeze(capabilities),
    minConfidence: Math.max(
      CODE_COMPATIBILITY_CEILING.minConfidence,
      bundle.policy.minConfidence,
    ),
    inferredRequiresConfirm:
      CODE_COMPATIBILITY_CEILING.inferredRequiresConfirm ||
      bundle.policy.inferredRequiresConfirm,
    deniedHostSuffixes: Object.freeze([...new Set([
      ...LOCAL_AUTOMATION_DENIED_HOST_SUFFIXES,
      ...bundle.policy.deniedHostSuffixes,
    ])]),
    notAfter: Date.parse(bundle.notAfter),
    source: 'remote',
  });
}

function remoteReadOnlyDiscoveryPolicy(bundle: ExecutionRuntimeBundleV1): ApplyPolicy {
  const remote = remoteApplyPolicy(bundle);
  return Object.freeze({
    ...remote,
    enabled: false,
    vendors: Object.freeze(Object.fromEntries(
      EXECUTION_RUNTIME_POLICY_VENDORS.map((vendor) => [vendor, false]),
    )) as ApplyPolicy['vendors'],
    capabilities: Object.freeze(Object.fromEntries(
      Object.keys(remote.capabilities).map((capability) => [capability, false]),
    )) as ApplyPolicy['capabilities'],
  });
}

async function safeRefresh(
  client: ExecutionRuntimeBundleClient,
): Promise<ExecutionRuntimeBundleResolution> {
  try {
    const resolved = await client.refresh();
    if (
      resolved.ok &&
      resolved.source !== 'NETWORK' &&
      resolved.source !== 'NOT_MODIFIED'
    ) {
      return { ok: false, code: 'RUNTIME_BUNDLE_CLIENT_UNAVAILABLE' };
    }
    return resolved;
  } catch {
    return { ok: false, code: 'RUNTIME_BUNDLE_CLIENT_UNAVAILABLE' };
  }
}

/**
 * 已知档的排位；这一版不认识的档是 -1（2026-09-28 起契约不再因陌生档拒整包）。
 * 用在「意向的级别不得超过包的上限」：上限是陌生档时任何意向都超出，fail closed。
 */
function automationRank(level: string): number {
  return (AUTOMATION_LEVELS as readonly string[]).indexOf(level);
}

function failure(
  code: ExecutionRuntimeAuthorityCode,
): Readonly<{ ok: false; code: ExecutionRuntimeAuthorityCode }> {
  return Object.freeze({ ok: false, code });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}

function isExactRecord<K extends string>(
  value: unknown,
  keys: readonly K[],
): value is Record<K, unknown> {
  if (!isRecord(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length &&
    actual.every((key, index) => key === expected[index]);
}

function isVersionAtLeast(current: string, minimum: string): boolean {
  const comparison = compareExecutionRuntimeSemverV1(current, minimum);
  return comparison !== null && comparison >= 0;
}

/**
 * 把后端下发的规则装进识别路径。
 *
 * 2026-09-15 加。在此之前，识别（`hasApplyAdapter` / `isApplyFormPath` /
 * `readApplyForm`）读的是随包内置的 `ADAPTERS`，于是 11 家的规则 JSON 全被打进
 * 内容脚本——实测 43,409 字节，而一个页面只可能在一家厂商上；每加一家，所有
 * 页面都跟着变重。
 *
 * 改成和执行路径共用同一份 release：没有第二个数据源，没有内置回退。取不到
 * 或验证不过时装入空表，识别随之 fail closed——宁可不识别，也不退回一份可能
 * 已经过期的内置拷贝去对一个页面做出承诺。
 *
 * 返回装入的厂商数，调用方用来记录稳定诊断，不用来决定是否放行。
 *
 * `onDiagnostic` 记的是**为什么没装上**（2026-09-22 加）。在此之前
 * `createRuntimeApplyRegistry` 的失败码在这里被整个丢掉，于是「规则取到了、
 * 一家都没装上」这个状态在 worker 里一声不响——那次生产故障只能靠测试台反推。
 * 只传码，不传规则内容、不传页面、不传厂商名。
 *
 * 2026-09-28 起还记**装上了、但有一部分这一版读不了**的那些（内核的 `notices`）：
 * 一份规则多了不认识的顶层键（照常装上）、一份规则读不了（只停那一家）、不认识的厂商
 * 或档案键（跳过）。后端先发、商店包还没跟上的窗口里，线上就靠这几个码看出「旧包
 * 正在忽略什么」，而不是等到有人报「某一家填不了」。
 */
export async function installApplyAdaptersFromRules(
  rules: unknown,
  onDiagnostic: (code: string) => void = () => {},
): Promise<number> {
  const registry = await createRuntimeApplyRegistry(rules);
  if (!registry.ok) {
    installApplyAdapters({});
    // 内核自己的稳定码（`RUNTIME_RULES_MALFORMED` / `RUNTIME_RULES_MAPPING_MISMATCH`
    // …）直接带出来：整份 release 验不过是整份拒，这个码说的就是拒在哪一关。
    onDiagnostic(`APPLY_RULES_INSTALL_REJECTED_${registry.code}`);
    return 0;
  }
  for (const notice of registry.value.notices) onDiagnostic(`APPLY_RULES_INSTALL_${notice}`);
  const adapters = applyAdaptersFromRuntimeRegistry(registry.value);
  installApplyAdapters(adapters);
  return Object.keys(adapters).length;
}
