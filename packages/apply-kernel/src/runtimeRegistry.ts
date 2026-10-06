import { EXECUTION_RUNTIME_REQUIRED_MAPPED_ATS_PROVIDERS } from '@edaix/contracts';
import type {
  ApplyRulesAtsProvider,
  ApplyRulesJson,
  ApplyRulesJsonObject,
  ApplyRulesMappingV1,
  ApplyRulesReleaseManifestV1,
  ApplyRulesRuntimeReleaseV1,
  ApplyRulesSha256Digest,
  ApplyRulesSourceVendor,
} from '@edaix/apply-rules/runtime-release';

import type {
  AccountOutcomeReading,
  AccountWallStep,
  ApplyFieldDescriptor,
  ConsentGateReading,
  EmailCodePrompt,
  EmailVerificationMail,
  ApplyFormDescriptor,
  ApplyPathOptions,
  ScanRootOptions,
  VendorAdapter,
} from './contracts.ts';
import { resolveEmailCodePrompt } from './rules/emailVerification.ts';
import { compileRuleAdapter } from './rules/interpreter.ts';
import { parseVendorRuleset, type ApplyRulesErrorCode, type VendorRuleset } from './rules/schema.ts';
import { sealScanRootMutationPolicyResult, type ScanRootSealStop } from './scanRoot.ts';
import { parseWizardReadOnlyDeclaration, type WizardReadOnlyDeclaration } from './rules/wizardIdentity.ts';

export type ApplyRulesReleaseV1 = ApplyRulesRuntimeReleaseV1;
export type RuntimeApplyRulesMappingV1 = ApplyRulesMappingV1;

export const RUNTIME_RULES_ERROR_CODES = [
  'RUNTIME_RULES_MALFORMED',
  'RUNTIME_RULES_SCHEMA_TOO_NEW',
  'RUNTIME_RULES_CRYPTO_UNAVAILABLE',
  'RUNTIME_RULES_SOURCE_MISSING',
  'RUNTIME_RULES_ANNOTATION_PRESENT',
  'RUNTIME_RULESET_REJECTED',
  'RUNTIME_RULESET_DIGEST_MISMATCH',
  'RUNTIME_RULES_RELEASE_DIGEST_MISMATCH',
  'RUNTIME_RULES_MAPPING_MISMATCH',
  'RUNTIME_RULES_MAPPING_NOT_FOUND',
  'RUNTIME_RULES_PROVIDER_UNAVAILABLE',
] as const;
export type RuntimeApplyRulesErrorCode = (typeof RUNTIME_RULES_ERROR_CODES)[number];

export type RuntimeApplyRulesResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly code: RuntimeApplyRulesErrorCode };

/**
 * 这一版读不了、但**没有拖垮整份 release** 的东西（2026-09-28）。每一种一个稳定码：
 * 不带厂商名、不带键名、不带规则内容——调用方原样记进诊断（RULE-GLOBAL-DATA-L1）。
 *
 *  · `RUNTIME_RULES_UNKNOWN_VENDOR_SKIPPED` —— 映射里有这一版不认识的厂商，它的映射与规则
 *    一行都不解释（2026-09-22 起就这么容错，此前不留码）；
 *  · `RUNTIME_RULESET_UNKNOWN_KEY_IGNORED` —— 某份规则多了这一版不认识的**顶层**键：
 *    不解释，这份规则按没有它照常装上；
 *  · `RUNTIME_RULESET_UNKNOWN_FIELD_KEY_SKIPPED` —— 某份规则里有映射指向这一版不认识的
 *    档案键：只那一条不生效（2026-09-16 起的容错，此前不留码）；
 *  · `RUNTIME_RULESET_SKIPPED_<内核拒收码>` —— 某份规则这一版读不了（比内核新的
 *    schemaVersion、已知结构里的陌生键、认不得的 step……）：**只停这一份规则的映射**，
 *    别家照常。
 */
export type RuntimeApplyRulesNotice =
  | 'RUNTIME_RULES_UNKNOWN_VENDOR_SKIPPED'
  | 'RUNTIME_RULESET_UNKNOWN_KEY_IGNORED'
  | 'RUNTIME_RULESET_UNKNOWN_FIELD_KEY_SKIPPED'
  | `RUNTIME_RULESET_SKIPPED_${ApplyRulesErrorCode}`;

export interface RuntimeApplyMappingTarget {
  readonly atsProvider: string;
  readonly pathRuleId: string;
}

export interface RuntimeApplyMappingMetadata {
  readonly atsProvider: ApplyRulesMappingV1['atsProvider'];
  readonly pathRuleId: string;
  readonly vendor: ApplyRulesSourceVendor;
  readonly rulesetVersion: string;
  readonly rulesetDigest: ApplyRulesSha256Digest;
}

export interface ResolvedRuntimeApplyAdapter extends RuntimeApplyMappingMetadata {
  readonly adapter: VendorAdapter;
}

const mappedWizards = new WeakMap<RuntimeApplyMappingMetadata, WizardReadOnlyDeclaration>();

/** Content interpreter only: never serialize a declaration into a business/UI message. */
export function readRuntimeApplyWizardDeclaration(mapping: RuntimeApplyMappingMetadata): WizardReadOnlyDeclaration | null {
  return mappedWizards.get(mapping) ?? null;
}

export interface RuntimeApplyRegistry {
  readonly releaseVersion: string;
  readonly releaseDigest: ApplyRulesSha256Digest;
  readonly mappings: readonly ResolvedRuntimeApplyAdapter[];
  /** 这一版读不了但没拖垮整份的那些，去重、排序；空数组 = 整份一字不落地读懂了。 */
  readonly notices: readonly RuntimeApplyRulesNotice[];
}

export interface RuntimeApplyMetadataRegistry {
  readonly releaseVersion: string;
  readonly releaseDigest: ApplyRulesSha256Digest;
  readonly mappings: readonly RuntimeApplyMappingMetadata[];
  readonly notices: readonly RuntimeApplyRulesNotice[];
}

const RELEASE_MANIFEST_SCHEMA_VERSION = 1;
const SOURCE_VENDORS = [
  'ashby',
  'bamboohr',
  'dover',
  // 2026-09-22 追加：不绑厂商的那条路（argoland #584）。它随发布下发规则，
  // 但随包适配器是 null、内置 policy 关着——发布里有这一份 ≠ 这条路已放行。
  'generic',
  'greenhouse',
  'icims',
  'jobvite',
  'lever',
  'rippling',
  'smartrecruiters',
  'workable',
  'workday',
] as const;
const ACTIVE_ATS_PROVIDERS = [
  'ASHBY',
  'BAMBOOHR',
  // 2026-09-22 追加：见 @edaix/contracts 的 EXECUTION_RUNTIME_MAPPED_ATS_PROVIDERS。
  'DOVER',
  'GENERIC',
  'GREENHOUSE',
  'ICIMS',
  'JOBVITE',
  'LEVER',
  'RIPPLING',
  'SMARTRECRUITERS',
  'WORKABLE',
  'WORKDAY',
] as const;
const UNAVAILABLE_ATS_PROVIDER: ApplyRulesAtsProvider = 'INDEED_APPLY';
const TOKEN_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;
const MAX_MAPPINGS = 128;
const MAX_RULESETS = 64;
const FORBIDDEN_JSON_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const EXPECTED_VENDOR_BY_PROVIDER = {
  ASHBY: 'ashby',
  BAMBOOHR: 'bamboohr',
  DOVER: 'dover',
  GENERIC: 'generic',
  GREENHOUSE: 'greenhouse',
  ICIMS: 'icims',
  JOBVITE: 'jobvite',
  LEVER: 'lever',
  RIPPLING: 'rippling',
  SMARTRECRUITERS: 'smartrecruiters',
  WORKABLE: 'workable',
  WORKDAY: 'workday',
} as const satisfies Record<ApplyRulesMappingV1['atsProvider'], ApplyRulesSourceVendor>;

interface ValidatedRelease {
  readonly release: ApplyRulesRuntimeReleaseV1;
  readonly parsedRulesets: ReadonlyMap<string, VendorRuleset>;
  readonly notices: readonly RuntimeApplyRulesNotice[];
}

/**
 * 读 release 的两种口径（2026-09-28）。
 *
 *  · `'runtime'`：后端下发的远端 payload。完整性一层不放松（每份规则与整包的 JCS/SHA-256、
 *    映射引用完整、排序、必须覆盖的厂商），但**一份规则这一版读不了只停那一家**，陌生顶层键
 *    不解释——后端与已装的商店包永远有一段版本不一致的窗口。
 *  · `'publish'`：本仓自己签进去的规则（`buildApplyRulesRelease`）。读不了就是构建错误，
 *    整份 `RUNTIME_RULESET_REJECTED`，陌生顶层键拒收——与 2026-09-28 之前逐字相同。
 */
type ReleaseReadMode = 'runtime' | 'publish';

class RuntimeRulesError extends Error {
  readonly code: RuntimeApplyRulesErrorCode;

  constructor(code: RuntimeApplyRulesErrorCode) {
    super(code);
    this.code = code;
  }
}

/**
 * Build the exact public release payload from checked-in source JSON.
 * `$comment*` annotations are recursively removed before both hashing and
 * publication. This is a publisher/local-rehearsal helper, not an execution
 * authority and never a fallback for a missing remote runtime bundle.
 */
export async function buildApplyRulesRelease(
  manifestInput: unknown,
  sourcesInput: Readonly<Record<string, unknown>>,
): Promise<RuntimeApplyRulesResult<ApplyRulesRuntimeReleaseV1>> {
  try {
    const manifest = parseReleaseManifest(manifestInput);
    assertExactSourceKeys(sourcesInput);

    const rulesets = [];
    for (const entry of manifest.rulesets) {
      const source = sourcesInput[entry.vendor];
      if (source === undefined) fail('RUNTIME_RULES_SOURCE_MISSING');
      const ruleset = stripApplyRulesAnnotations(source);
      // 发布侧：本仓是规则的作者，陌生顶层键（多半是拼错）当场拒，不走运行时的「不解释」。
      const parsed = parseVendorRuleset(ruleset, { unknownTopLevelKeys: 'reject' });
      if (!parsed.ok) fail('RUNTIME_RULESET_REJECTED');
      if (parsed.value.vendor !== entry.vendor) fail('RUNTIME_RULES_MAPPING_MISMATCH');

      const digest = await digestApplyRulesJson(ruleset);
      if (digest !== entry.digest) fail('RUNTIME_RULESET_DIGEST_MISMATCH');
      rulesets.push({ version: entry.version, digest, ruleset });
    }

    const release: ApplyRulesRuntimeReleaseV1 = {
      releaseVersion: manifest.releaseVersion,
      releaseDigest: manifest.releaseDigest,
      mappings: manifest.mappings,
      rulesets,
    };
    const validated = await validateRuntimeRelease(release, 'publish');
    return { ok: true, value: freezeJsonRelease(validated.release) };
  } catch (error) {
    return failureResult(error);
  }
}

/**
 * Parser for an untrusted, complete runtime release payload. Integrity is strict;
 * a ruleset this build cannot read is left out of the result (see `ReleaseReadMode`).
 */
export async function parseApplyRulesReleaseV1(
  input: unknown,
): Promise<RuntimeApplyRulesResult<ApplyRulesRuntimeReleaseV1>> {
  try {
    const validated = await validateRuntimeRelease(input);
    return { ok: true, value: freezeJsonRelease(validated.release) };
  } catch (error) {
    return failureResult(error);
  }
}

/**
 * Compile a registry exclusively from a fully verified remote release.
 * There is intentionally no `ADAPTERS` import and no bundled fallback branch.
 */
export async function createRuntimeApplyRegistry(
  input: unknown,
): Promise<RuntimeApplyRulesResult<RuntimeApplyRegistry>> {
  try {
    const { release, parsedRulesets, notices } = await validateRuntimeRelease(input);
    const adapters = new Map<string, VendorAdapter>();
    for (const [version, ruleset] of parsedRulesets) {
      adapters.set(version, compileRuleAdapter(ruleset));
    }

    const mappings: ResolvedRuntimeApplyAdapter[] = [];
    for (const mapping of release.mappings) {
      const adapter = adapters.get(mapping.rulesetVersion);
      if (!adapter) fail('RUNTIME_RULES_MAPPING_MISMATCH');
      const resolved = Object.freeze({
        ...mapping,
        adapter,
      });
      const ruleset = parsedRulesets.get(mapping.rulesetVersion);
      if (ruleset?.schemaVersion === 3 && ruleset.wizard !== null) {
        const declaration = parseWizardReadOnlyDeclaration(ruleset.wizard);
        if (!declaration.ok) fail('RUNTIME_RULESET_REJECTED');
        mappedWizards.set(resolved, declaration.value);
      }
      mappings.push(resolved);
    }

    return {
      ok: true,
      value: Object.freeze({
        releaseVersion: release.releaseVersion,
        releaseDigest: release.releaseDigest,
        mappings: Object.freeze(mappings),
        notices,
      }),
    };
  } catch (error) {
    return failureResult(error);
  }
}

/** Full release verification for identity-only consumers; compiles no form adapter. */
export async function createRuntimeApplyMetadataRegistry(input: unknown): Promise<RuntimeApplyRulesResult<RuntimeApplyMetadataRegistry>> {
  try {
    const { release, parsedRulesets, notices } = await validateRuntimeRelease(input);
    const mappings = release.mappings.map((mapping) => {
      const resolved = Object.freeze({ ...mapping });
      const ruleset = parsedRulesets.get(mapping.rulesetVersion);
      if (!ruleset) fail('RUNTIME_RULES_MAPPING_MISMATCH');
      if (ruleset.schemaVersion === 3 && ruleset.wizard !== null) {
        const declaration = parseWizardReadOnlyDeclaration(ruleset.wizard);
        if (!declaration.ok) fail('RUNTIME_RULESET_REJECTED');
        mappedWizards.set(resolved, declaration.value);
      }
      return resolved;
    });
    return { ok: true, value: Object.freeze({ releaseVersion: release.releaseVersion,
      releaseDigest: release.releaseDigest, mappings: Object.freeze(mappings), notices }) };
  } catch (error) { return failureResult(error); }
}

/** Exact tuple lookup. No provider lowercasing, vendor guess, or host/DOM fallback. */
export function resolveRuntimeApplyAdapter(
  registry: RuntimeApplyRegistry,
  target: RuntimeApplyMappingTarget,
): RuntimeApplyRulesResult<ResolvedRuntimeApplyAdapter> {
  return resolveRuntimeApplyMapping(registry, target);
}

export function resolveRuntimeApplyMapping<T extends RuntimeApplyMappingMetadata>(
  registry: Readonly<{ mappings: readonly T[] }>, target: RuntimeApplyMappingTarget,
): RuntimeApplyRulesResult<T> {
  if (target.atsProvider === UNAVAILABLE_ATS_PROVIDER) {
    return { ok: false, code: 'RUNTIME_RULES_PROVIDER_UNAVAILABLE' };
  }
  const matches = registry.mappings.filter(
    (mapping) =>
      mapping.atsProvider === target.atsProvider && mapping.pathRuleId === target.pathRuleId,
  );
  const value = matches.length === 1 ? matches[0] : undefined;
  return value === undefined
    ? { ok: false, code: 'RUNTIME_RULES_MAPPING_NOT_FOUND' }
    : { ok: true, value };
}

/**
 * Interpret one already-resolved remote adapter.  This is intentionally
 * separate from `registry.ts`/`ADAPTERS`: a missing or invalid runtime mapping
 * has no bundled execution fallback.
 */
/**
 * 解不出表单的四种，各自有名字。
 *
 * 原先四个 `return null` 长得一模一样，调用方只能一律说「这一页没有表单」——
 * 而其中三种不是那个意思。2026-09-18 查一次真实的零写入，卡在这一层花了好几轮：
 * 规则、锚点、封存三件事都可能是它，从外面一个都分不出来
 * （RULE-GLOBAL-ERROR-CONTRACT：失败要有稳定的名字）。
 */
export type RuntimeApplyFormStop =
  /** 这条路径不归这份规则管。 */
  | 'PATH_NOT_APPLY'
  /** 规则的锚点在这一页上没命中。 */
  | 'ROOT_NOT_FOUND'
  /**
   * 锚点没命中，**而且**厂商声明的「打开申请表」按钮此刻就在这一页上——
   * 也就是表单还没被打开，不是规则失效。分成两个码，是因为用户的下一步动作
   * 完全不同：一个是「你先点那个按钮」，另一个是「等我们更新规则」。
   * 2026-09-22 BambooHR 八页全卡在后一句话上，而那句话是错的。
   */
  | 'APPLY_FORM_NOT_OPENED'
  /**
   * 锚点没命中，这一页是申请表之前那一道「数据同意」页（规则的 `consentGate`，2026-10-04 Jobvite）：要先选居住地、同意条款，
   * 申请表才出来。不是「认不出申请表」，刷新也没用。
   */
  | 'CONSENT_GATE'
  /** 锚点命中了，但一个带键的字段都没扫出来。 */
  | 'NO_KEYED_FIELD'
  /** 扫出来了，但封不住；具体是哪一种由 `ScanRootSealStop` 说。 */
  | `NOT_SEALABLE:${ScanRootSealStop}`;

export type RuntimeApplyFormResult =
  | Readonly<{ ok: true; descriptor: ApplyFormDescriptor }>
  | Readonly<{ ok: false; stop: RuntimeApplyFormStop }>;

export function readRuntimeApplyFormResult(
  resolved: ResolvedRuntimeApplyAdapter,
  pathname: string,
  page: ParentNode,
  options?: ScanRootOptions,
  path?: ApplyPathOptions,
): RuntimeApplyFormResult {
  if (!resolved.adapter.isApplyPath(pathname, path)) return { ok: false, stop: 'PATH_NOT_APPLY' };
  const root = resolved.adapter.resolveRoot(page, options);
  if (!root) {
    return {
      ok: false,
      stop: resolved.adapter.hasConsentGate?.(page) === true ? 'CONSENT_GATE'
        : resolved.adapter.hasUnopenedApplyForm(page) ? 'APPLY_FORM_NOT_OPENED' : 'ROOT_NOT_FOUND',
    };
  }
  const fields = [...resolved.adapter.scan(root, options)];
  // 厂商路（主机在这一家的表里、路径与页锚都命中）上，页锚本身就证明了这是申请流程里的一步：
  // 扫出了字段就交出去，哪怕一个键都没有。Workday 第 3 步 Application Questions 整页都是雇主
  // 自定义题（字段 id 是随机 GUID），从前在这里判 NO_KEYED_FIELD，而专门处理这类题的逻辑——
  // 工作授权按岗位国家预填、居住地、答案记忆、AI 起草——都在计划期，一次都跑不到（2026-09-22
  // nvidia.wd5 实测，浮层说「这一页没有我们认得的表单」）。写入仍由各自的键围栏把关，这里只决定
  // 这一页交不交给计划。白标与通用路照旧要求带键字段（它们找根时本来就要求带键的钩子）。
  const vendorLane = path?.whitelabel !== true && path?.generic !== true;
  if (fields.length === 0 || (!vendorLane && !fields.some((field: ApplyFieldDescriptor) => field.key !== null))) {
    return { ok: false, stop: 'NO_KEYED_FIELD' };
  }
  // Runtime scans have an async digest boundary immediately after this call.
  // Freeze this exact generation now; never adopt DOM that arrived meanwhile.
  const sealed = sealScanRootMutationPolicyResult(root, {
    fields,
    rescan: () => resolved.adapter.scan(root, options),
  });
  if (!sealed.ok) return { ok: false, stop: `NOT_SEALABLE:${sealed.stop}` };
  return {
    ok: true,
    descriptor: {
      vendor: resolved.vendor,
      root,
      fields,
      finalSubmitControl: resolved.adapter.resolveFinalSubmitControl(root, fields),
      resolveFinalSubmitControl: () => resolved.adapter.resolveFinalSubmitControl(root, fields),
      rowScopes: resolved.adapter.rowScopes ?? [],
      ...(resolved.adapter.questionTextFor === undefined
        ? {}
        : { questionText: (element: Element) => resolved.adapter.questionTextFor?.(root, element) ?? '' }),
    },
  };
}

/**
 * 账号墙（2026-09-28）：这一份运行时授权对应的规则，在这一页上此刻认出的是哪一步。认不出、没声明都是 null。
 * 与表单那一路不同，这里不封存、不求摘要：账号墙上写的只有我们自己的邮箱与密码，每一下写、每一下点之前
 * 扩展都会再问一次 `isCurrent()`。
 */
export function readRuntimeAccountWall(
  resolved: ResolvedRuntimeApplyAdapter,
  page: ParentNode,
  options?: ScanRootOptions,
): AccountWallStep | null {
  return resolved.adapter.resolveAccountWall?.(page, options) ?? null;
}

/** 数据同意页此刻的样子（D7）：规则声明的表与居住地下拉。不是同意页、没声明都是 null。 */
export function readRuntimeConsentGate(resolved: ResolvedRuntimeApplyAdapter, page: ParentNode): ConsentGateReading | null {
  return resolved.adapter.readConsentGate?.(page) ?? null;
}

/** 申请表还没打开时，规则声明的那一颗「打开申请表」（D8）。认不出、没声明、不该按都是 null。 */
export function readRuntimeApplyGate(resolved: ResolvedRuntimeApplyAdapter, page: ParentNode): HTMLElement | null {
  return resolved.adapter.applyGateControl?.(page) ?? null;
}

/** 账号墙上网站此刻说了什么（规则声明的横幅里看得见的字）。 */
export function readRuntimeAccountOutcome(
  resolved: ResolvedRuntimeApplyAdapter,
  page: ParentNode,
  isVisible: (element: Element) => boolean,
): AccountOutcomeReading {
  return resolved.adapter.readAccountOutcome?.(page, isVisible) ?? null;
}

/** 这一份运行时授权对应的规则认不认这条路径是账号页（iCIMS 的 …/login）。 */
/**
 * 邮箱验证（2026-10-04）：这一份运行时授权对应的规则，在这一页上此刻认出的「网站在要验证码」。写之前扩展再问一次，
 * 认不出、没声明都是 null。与账号墙一样不封存、不求摘要：要写的只有他自己在浮层里输的那一串，写前还要 `isCurrent()`。
 */
export function readRuntimeEmailCodePrompt(
  resolved: ResolvedRuntimeApplyAdapter,
  page: ParentNode,
  isVisible: (element: Element) => boolean,
): EmailCodePrompt | null {
  const rule = resolved.adapter.emailVerification ?? null;
  return rule === null ? null : resolveEmailCodePrompt(rule, page, isVisible);
}

/** 这一份运行时授权对应的规则说的验证邮件长什么样（只给人看）。 */
export function readRuntimeEmailVerificationMail(resolved: ResolvedRuntimeApplyAdapter): EmailVerificationMail | null {
  return resolved.adapter.emailVerificationMail ?? null;
}

export function isRuntimeAccountPath(resolved: ResolvedRuntimeApplyAdapter, pathname: string): boolean {
  return resolved.adapter.isAccountPath?.(pathname) === true;
}

export function readRuntimeApplyForm(
  resolved: ResolvedRuntimeApplyAdapter,
  pathname: string,
  page: ParentNode,
  options?: ScanRootOptions,
  path?: ApplyPathOptions,
): ApplyFormDescriptor | null {
  const result = readRuntimeApplyFormResult(resolved, pathname, page, options, path);
  return result.ok ? result.descriptor : null;
}

/** Minimal strict RFC 8785 serializer used for release digest preimages. */
export function canonicalizeApplyRulesJson(value: unknown): string {
  return serializeJson(value);
}

/** Browser/Node WebCrypto SHA-256 over UTF-8 JCS bytes. */
export async function digestApplyRulesJson(value: unknown): Promise<ApplyRulesSha256Digest> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) fail('RUNTIME_RULES_CRYPTO_UNAVAILABLE');
  let bytes: ArrayBuffer;
  try {
    bytes = await subtle.digest('SHA-256', new TextEncoder().encode(canonicalizeApplyRulesJson(value)));
  } catch {
    fail('RUNTIME_RULES_CRYPTO_UNAVAILABLE');
  }
  const hex = [...new Uint8Array(bytes)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
  return `sha256:${hex}` as ApplyRulesSha256Digest;
}

function parseReleaseManifest(input: unknown): ApplyRulesReleaseManifestV1 {
  if (!isRecord(input)) fail('RUNTIME_RULES_MALFORMED');
  assertOnlyKeys(input, [
    'schemaVersion',
    'releaseVersion',
    'releaseDigest',
    'mappings',
    'unavailableAtsProviders',
    'rulesets',
  ], true);
  if (typeof input['schemaVersion'] === 'number' && input['schemaVersion'] > RELEASE_MANIFEST_SCHEMA_VERSION) {
    fail('RUNTIME_RULES_SCHEMA_TOO_NEW');
  }
  if (input['schemaVersion'] !== RELEASE_MANIFEST_SCHEMA_VERSION) fail('RUNTIME_RULES_MALFORMED');
  const releaseVersion = parseToken(input['releaseVersion']);
  const releaseDigest = parseDigest(input['releaseDigest']);
  if (
    !Array.isArray(input['unavailableAtsProviders']) ||
    input['unavailableAtsProviders'].length !== 1 ||
    input['unavailableAtsProviders'][0] !== UNAVAILABLE_ATS_PROVIDER
  ) fail('RUNTIME_RULES_MALFORMED');
  // 发布器这条路读的是**本仓自己签进去的** manifest，不是后端下发的远端 payload：
  // 这里认不出一家厂商是构建错误，不是版本窗口，所以不容错——`parseManifestRulesets`
  // 的「厂商集完全相等」那条闸也照旧。
  const delivered = parseMappings(input['mappings']);
  if (delivered.some((mapping) => !mapping.known)) fail('RUNTIME_RULES_MALFORMED');
  const mappings = knownMappings(delivered);
  const rulesets = parseManifestRulesets(input['rulesets']);
  validateSortedMappings(delivered, mappings);
  validateManifestRulesetReferences(mappings, rulesets);
  return {
    schemaVersion: 1,
    releaseVersion,
    releaseDigest,
    mappings,
    unavailableAtsProviders: ['INDEED_APPLY'],
    rulesets,
  };
}

async function validateRuntimeRelease(
  input: unknown,
  mode: ReleaseReadMode = 'runtime',
): Promise<ValidatedRelease> {
  if (!isRecord(input)) fail('RUNTIME_RULES_MALFORMED');
  assertOnlyKeys(input, ['releaseVersion', 'releaseDigest', 'mappings', 'rulesets']);

  const releaseVersion = parseToken(input['releaseVersion']);
  const releaseDigest = parseDigest(input['releaseDigest']);
  // 送达的全部（含这一版不认识的厂商）与我们认得的那些，分开拿：排序、引用完整性
  // 与 release digest 都按**送达的全部**算，装配只按认得的那些。
  const deliveredMappings = parseMappings(input['mappings']);
  const mappings = knownMappings(deliveredMappings);
  validateSortedMappings(deliveredMappings, mappings);
  const notices = new Set<RuntimeApplyRulesNotice>();
  if (mappings.length !== deliveredMappings.length) notices.add('RUNTIME_RULES_UNKNOWN_VENDOR_SKIPPED');

  if (!Array.isArray(input['rulesets']) || input['rulesets'].length === 0 || input['rulesets'].length > MAX_RULESETS) {
    fail('RUNTIME_RULES_MALFORMED');
  }

  const knownVersions = new Set(mappings.map((mapping) => mapping.rulesetVersion));
  const deliveredRulesets = [];
  const rulesets = [];
  const parsedRulesets = new Map<string, VendorRuleset>();
  /** 这一版读不了、只停它自己的那几份规则（按 version）。 */
  const skippedVersions = new Set<string>();
  let previousVersion: string | null = null;
  for (const raw of input['rulesets']) {
    if (!isRecord(raw)) fail('RUNTIME_RULES_MALFORMED');
    assertOnlyKeys(raw, ['version', 'digest', 'ruleset']);
    const version = parseToken(raw['version']);
    const digest = parseDigest(raw['digest']);
    if (previousVersion !== null && previousVersion >= version) fail('RUNTIME_RULES_MALFORMED');
    previousVersion = version;
    if (!isRecord(raw['ruleset'])) fail('RUNTIME_RULES_MALFORMED');
    if (containsRuleAnnotation(raw['ruleset'])) fail('RUNTIME_RULES_ANNOTATION_PRESENT');

    const exactRuleset = raw['ruleset'] as ApplyRulesJsonObject;
    if (containsForbiddenJsonKey(exactRuleset)) fail('RUNTIME_RULES_MALFORMED');
    // 摘要按送达的原样算——这一版不认识的键也在摘要里。先验摘要、后读内容：
    // 「不解释」只对验过的字节成立，送达途中被改过的照旧整份拒。
    const actualDigest = await digestApplyRulesJson(exactRuleset);
    if (actualDigest !== digest) fail('RUNTIME_RULESET_DIGEST_MISMATCH');
    deliveredRulesets.push({ version, digest, ruleset: exactRuleset });
    // 只有认得的映射引用到的那些才编译。不认识的那家的规则**一行都不解释**：
    // 它的 schema 可能是这一版还不存在的，拿它去编译只会得到一个假的失败。
    if (!knownVersions.has(version)) continue;
    // 这一份自己的容错回报先记在一边：它最后要是整份读不了，报的只有「停了这一份」。
    const tolerated = new Set<RuntimeApplyRulesNotice>();
    const parsed = parseVendorRuleset(exactRuleset, {
      unknownTopLevelKeys: mode === 'publish' ? 'reject' : 'ignore',
      onUnknownTopLevelKey: () => tolerated.add('RUNTIME_RULESET_UNKNOWN_KEY_IGNORED'),
      onUnknownFieldKey: () => tolerated.add('RUNTIME_RULESET_UNKNOWN_FIELD_KEY_SKIPPED'),
    });
    if (!parsed.ok) {
      // 发布侧：本仓签进去的规则读不了是构建错误，整份拒（与从前逐字相同）。
      if (mode === 'publish') fail('RUNTIME_RULESET_REJECTED');
      // 运行时（2026-09-28）：只停这一份规则的映射，别家照常。在此之前这里整份拒——
      // 一家的规则多了一个旧包不认识的键，所有厂商就一起停（2026-09-24）。这一家照样
      // fail closed：它的映射从装配里拿掉，永远编译不出适配器、解析不出授权。
      //
      // 读不了内容，但「这份规则是哪一家的」仍要与引用它的映射对得上：那是路由表的完整性，
      // 不是版本窗口——对不上照旧整份拒。
      if (mappings.some((mapping) => mapping.rulesetVersion === version && mapping.vendor !== exactRuleset['vendor'])) {
        fail('RUNTIME_RULES_MAPPING_MISMATCH');
      }
      skippedVersions.add(version);
      notices.add(`RUNTIME_RULESET_SKIPPED_${parsed.code}`);
      continue;
    }
    for (const notice of tolerated) notices.add(notice);
    rulesets.push({ version, digest, ruleset: exactRuleset });
    parsedRulesets.set(version, parsed.value);
  }

  const usableMappings = mappings.filter((mapping) => !skippedVersions.has(mapping.rulesetVersion));
  validateRuntimeMappings(usableMappings, rulesets, parsedRulesets, deliveredMappings, deliveredRulesets);
  const actualReleaseDigest = await digestApplyRulesJson({
    releaseVersion,
    mappings: deliveredMappings.map(({ known: _known, ...mapping }) => mapping),
    rulesets: deliveredRulesets,
  });
  if (actualReleaseDigest !== releaseDigest) fail('RUNTIME_RULES_RELEASE_DIGEST_MISMATCH');

  return {
    release: { releaseVersion, releaseDigest, mappings: usableMappings, rulesets },
    parsedRulesets,
    notices: Object.freeze([...notices].sort()),
  };
}

/**
 * 送达的一条映射：形状一律校验，认不认识另说。
 *
 * `known` 为假时 `atsProvider` / `vendor` 是这一版不认识的值——它照样带着完整
 * 的 token 与 digest，因为 release digest 覆盖**整份 payload**，不能在验签前
 * 把它过滤掉；但它不进 `ApplyRulesMappingV1`，于是永远编译不出适配器、永远
 * 解析不出授权。
 */
type DeliveredMapping = Readonly<{
  known: boolean;
  atsProvider: string;
  pathRuleId: string;
  vendor: string;
  rulesetVersion: string;
  rulesetDigest: string;
}>;

/**
 * 2026-09-22 起对**不认识的厂商**容错。
 *
 * 在此之前，release 里出现一家这个包不认识的厂商 → 整份拒
 * （`RUNTIME_RULES_MALFORMED`）→ 装入表空 → 认得的那十家也一起停掉。后端一发
 * 新厂商就会打断所有还没升级的包，而商店包的更新天然是异步的（审核 + 用户升级），
 * 两边**永远**有一段版本不一致的窗口。
 *
 * 容错的是「有没有」，不是「是什么」：键多了、token 非法、digest 不符，一律
 * 照旧拒整份。`INDEED_APPLY` 那个显式「不可用」的信号也照旧拒——那不是「不认识」，
 * 是后端明说了不该发。
 *
 * 这不放松 RULE-GLOBAL-HIGH-RISK-FAIL-CLOSED 的「清单外一律拒」，方向正相反：
 * 不认识的那家永远装不上、永远解析不出授权；被修掉的只是「因为它在场，认得的
 * 那些也一起停掉」。
 */
function parseMappings(value: unknown): readonly DeliveredMapping[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_MAPPINGS) {
    fail('RUNTIME_RULES_MALFORMED');
  }
  return value.map((raw): DeliveredMapping => {
    if (!isRecord(raw)) fail('RUNTIME_RULES_MALFORMED');
    assertOnlyKeys(raw, [
      'atsProvider',
      'pathRuleId',
      'vendor',
      'rulesetVersion',
      'rulesetDigest',
    ]);
    const atsProvider = raw['atsProvider'];
    const vendor = raw['vendor'];
    if (atsProvider === UNAVAILABLE_ATS_PROVIDER) fail('RUNTIME_RULES_PROVIDER_UNAVAILABLE');
    if (typeof atsProvider !== 'string' || typeof vendor !== 'string') {
      fail('RUNTIME_RULES_MALFORMED');
    }
    const shape = {
      atsProvider: parseToken(atsProvider),
      pathRuleId: parseToken(raw['pathRuleId']),
      vendor: parseToken(vendor),
      rulesetVersion: parseToken(raw['rulesetVersion']),
      rulesetDigest: parseDigest(raw['rulesetDigest']),
    };
    const known = (ACTIVE_ATS_PROVIDERS as readonly unknown[]).includes(atsProvider) &&
      (SOURCE_VENDORS as readonly unknown[]).includes(vendor);
    // 认得的那些，provider 与 vendor 必须对得上：这一条是我们**能**检查的一致性，
    // 不认识的那家没有可比的期望值，只能留给认识它的那一版去检查。
    if (known && vendor !== EXPECTED_VENDOR_BY_PROVIDER[atsProvider as ApplyRulesMappingV1['atsProvider']]) {
      fail('RUNTIME_RULES_MAPPING_MISMATCH');
    }
    return { known, ...shape };
  });
}

/** 这一版认得的那些，按 `ApplyRulesMappingV1` 的窄类型交出去。 */
function knownMappings(delivered: readonly DeliveredMapping[]): readonly ApplyRulesMappingV1[] {
  return delivered
    .filter((mapping) => mapping.known)
    .map(({ known: _known, ...mapping }) => mapping as ApplyRulesMappingV1);
}

function parseManifestRulesets(value: unknown): ApplyRulesReleaseManifestV1['rulesets'] {
  if (!Array.isArray(value) || value.length !== SOURCE_VENDORS.length) fail('RUNTIME_RULES_MALFORMED');
  const result = value.map((raw) => {
    if (!isRecord(raw)) fail('RUNTIME_RULES_MALFORMED');
    assertOnlyKeys(raw, ['version', 'digest', 'vendor'], true);
    const vendor = raw['vendor'];
    if (!(SOURCE_VENDORS as readonly unknown[]).includes(vendor)) fail('RUNTIME_RULES_MALFORMED');
    return {
      version: parseToken(raw['version']),
      digest: parseDigest(raw['digest']),
      vendor: vendor as ApplyRulesSourceVendor,
    };
  });
  const versions = result.map(({ version }) => version);
  if (!isStrictlySortedUnique(versions)) fail('RUNTIME_RULES_MALFORMED');
  const vendors = result.map(({ vendor }) => vendor).sort();
  if (vendors.join('\u0000') !== [...SOURCE_VENDORS].sort().join('\u0000')) {
    fail('RUNTIME_RULES_MALFORMED');
  }
  return result;
}

/**
 * 排序按**送达的全部**算（那是线上的不变量，不认识的那家也得排在它该在的位置），
 * 而「必须覆盖到的厂商」按**我们认得的那些**算——那条闸守的是覆盖面不许静默退化。
 */
function validateSortedMappings(
  delivered: readonly DeliveredMapping[],
  known: readonly ApplyRulesMappingV1[],
): void {
  const keys = delivered.map((mapping) => mappingKey(mapping.atsProvider, mapping.pathRuleId));
  if (!isStrictlySortedUnique(keys)) fail('RUNTIME_RULES_MAPPING_MISMATCH');
  for (const provider of EXECUTION_RUNTIME_REQUIRED_MAPPED_ATS_PROVIDERS) {
    if (!known.some((mapping) => mapping.atsProvider === provider)) {
      fail('RUNTIME_RULES_MAPPING_MISMATCH');
    }
  }
}

function validateManifestRulesetReferences(
  mappings: readonly ApplyRulesMappingV1[],
  rulesets: ApplyRulesReleaseManifestV1['rulesets'],
): void {
  const byVersion = new Map(rulesets.map((entry) => [entry.version, entry]));
  for (const mapping of mappings) {
    const ruleset = byVersion.get(mapping.rulesetVersion);
    if (
      !ruleset ||
      ruleset.vendor !== mapping.vendor ||
      ruleset.digest !== mapping.rulesetDigest
    ) {
      fail('RUNTIME_RULES_MAPPING_MISMATCH');
    }
  }
  for (const ruleset of rulesets) {
    if (!mappings.some((mapping) => mapping.rulesetVersion === ruleset.version)) {
      fail('RUNTIME_RULES_MAPPING_MISMATCH');
    }
  }
}

function validateRuntimeMappings(
  mappings: readonly ApplyRulesMappingV1[],
  rulesets: readonly ApplyRulesRuntimeReleaseV1['rulesets'][number][],
  parsedRulesets: ReadonlyMap<string, VendorRuleset>,
  delivered: readonly DeliveredMapping[],
  deliveredRulesets: readonly ApplyRulesRuntimeReleaseV1['rulesets'][number][],
): void {
  const byVersion = new Map(rulesets.map((entry) => [entry.version, entry]));
  for (const mapping of mappings) {
    const ruleset = byVersion.get(mapping.rulesetVersion);
    const parsed = parsedRulesets.get(mapping.rulesetVersion);
    if (
      !ruleset ||
      !parsed ||
      ruleset.digest !== mapping.rulesetDigest ||
      parsed.vendor !== mapping.vendor
    ) {
      fail('RUNTIME_RULES_MAPPING_MISMATCH');
    }
  }
  // 不认识的那家的 digest 照样对：不认识不等于不校验（容错的是「有没有」，
  // 不是「是什么」）。这一条在这里就把改坏的 payload 拦住，无论认不认识它。
  const deliveredByVersion = new Map(deliveredRulesets.map((entry) => [entry.version, entry]));
  for (const mapping of delivered) {
    if (deliveredByVersion.get(mapping.rulesetVersion)?.digest !== mapping.rulesetDigest) {
      fail('RUNTIME_RULES_MAPPING_MISMATCH');
    }
  }
  // 没有任何映射引用到的 ruleset 一律拒——夹带的死 payload 照旧不许上车。
  // 按送达的全部算：不认识的那家的 ruleset 由它自己那条映射引用着，不算孤儿。
  for (const ruleset of deliveredRulesets) {
    if (!delivered.some((mapping) => mapping.rulesetVersion === ruleset.version)) {
      fail('RUNTIME_RULES_MAPPING_MISMATCH');
    }
  }
}

function assertExactSourceKeys(sources: Readonly<Record<string, unknown>>): void {
  const actual = Object.keys(sources).sort();
  const expected = [...SOURCE_VENDORS].sort();
  if (actual.join('\u0000') !== expected.join('\u0000')) fail('RUNTIME_RULES_SOURCE_MISSING');
}

function stripApplyRulesAnnotations(value: unknown): ApplyRulesJsonObject {
  const stripped = stripJsonValue(value);
  if (!isRecord(stripped)) fail('RUNTIME_RULES_MALFORMED');
  return stripped as ApplyRulesJsonObject;
}

function stripJsonValue(value: unknown): ApplyRulesJson {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map(stripJsonValue);
  if (!isRecord(value)) fail('RUNTIME_RULES_MALFORMED');
  const result: Record<string, ApplyRulesJson> = {};
  for (const [key, child] of Object.entries(value)) {
    if (FORBIDDEN_JSON_KEYS.has(key)) fail('RUNTIME_RULES_MALFORMED');
    if (!key.startsWith('$comment')) result[key] = stripJsonValue(child);
  }
  return result;
}

function containsRuleAnnotation(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsRuleAnnotation);
  if (!isRecord(value)) return false;
  return Object.entries(value).some(
    ([key, child]) => key.startsWith('$comment') || containsRuleAnnotation(child),
  );
}

function containsForbiddenJsonKey(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsForbiddenJsonKey);
  if (!isRecord(value)) return false;
  return Object.entries(value).some(
    ([key, child]) => FORBIDDEN_JSON_KEYS.has(key) || containsForbiddenJsonKey(child),
  );
}

function serializeJson(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value))) {
      fail('RUNTIME_RULES_MALFORMED');
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    const items: string[] = [];
    for (let index = 0; index < value.length; index += 1) {
      if (!Object.prototype.hasOwnProperty.call(value, index)) fail('RUNTIME_RULES_MALFORMED');
      items.push(serializeJson(value[index]));
    }
    return `[${items.join(',')}]`;
  }
  if (isRecord(value)) {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) fail('RUNTIME_RULES_MALFORMED');
    const keys = Object.keys(value);
    if (keys.some((key) => FORBIDDEN_JSON_KEYS.has(key))) fail('RUNTIME_RULES_MALFORMED');
    const members = keys
      .sort()
      .map((key) => `${JSON.stringify(key)}:${serializeJson(value[key])}`);
    return `{${members.join(',')}}`;
  }
  fail('RUNTIME_RULES_MALFORMED');
}

function freezeJsonRelease(release: ApplyRulesRuntimeReleaseV1): ApplyRulesRuntimeReleaseV1 {
  return deepFreeze(release);
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

function parseToken(value: unknown): string {
  if (typeof value !== 'string' || !TOKEN_PATTERN.test(value)) fail('RUNTIME_RULES_MALFORMED');
  return value;
}

function parseDigest(value: unknown): ApplyRulesSha256Digest {
  if (typeof value !== 'string' || !DIGEST_PATTERN.test(value)) fail('RUNTIME_RULES_MALFORMED');
  return value as ApplyRulesSha256Digest;
}

function mappingKey(atsProvider: string, pathRuleId: string): string {
  return `${atsProvider}\u0000${pathRuleId}`;
}

function isStrictlySortedUnique(values: readonly string[]): boolean {
  return values.every((value, index) => index === 0 || values[index - 1]! < value);
}

function assertOnlyKeys(
  record: Record<string, unknown>,
  allowed: readonly string[],
  allowAnnotations = false,
): void {
  const keys = Object.keys(record).filter(
    (key) => !(allowAnnotations && key.startsWith('$comment')),
  );
  if (keys.length !== allowed.length || !allowed.every((key) => keys.includes(key))) {
    fail('RUNTIME_RULES_MALFORMED');
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function fail(code: RuntimeApplyRulesErrorCode): never {
  throw new RuntimeRulesError(code);
}

function failureResult(error: unknown): { readonly ok: false; readonly code: RuntimeApplyRulesErrorCode } {
  return {
    ok: false,
    code: error instanceof RuntimeRulesError ? error.code : 'RUNTIME_RULES_MALFORMED',
  };
}

/**
 * 把一份已验证的运行时 release 装配成 `registry.ts` 要的适配器表。
 *
 * 2026-09-15 加。在此之前，识别路径（`hasApplyAdapter` / `isApplyFormPath` /
 * `readApplyForm`）读的是随包内置的 `ADAPTERS`，于是 11 家的规则 JSON 全被打进
 * 内容脚本——实测 43,409 字节，而一个页面只可能在一家厂商上。改成从后端下发的
 * 同一份规则装配，站点知识就彻底离开了产物，加厂商对体积零影响。
 *
 * 与执行路径用的是**同一份 release**：这里没有第二个数据源，也没有内置回退。
 * release 取不到或验证不过时返回空表，识别随之 fail closed——这正是
 * RULE-GLOBAL-HIGH-RISK-FAIL-CLOSED 要的方向：取数失败保持关闭，而不是
 * 悄悄退回一份可能已经过期的内置拷贝。
 */
export function applyAdaptersFromRuntimeRegistry(
  registry: RuntimeApplyRegistry,
): Readonly<Partial<Record<ApplyRulesSourceVendor, VendorAdapter>>> {
  const adapters: Partial<Record<ApplyRulesSourceVendor, VendorAdapter>> = {};
  for (const mapping of registry.mappings) {
    // 同一厂商可以有多条 pathRule mapping，它们编译自同一个 ruleset；取第一条
    // 就够，识别只问"这一页是不是这家的申请页"，不问走哪条 mapping。
    if (adapters[mapping.vendor] === undefined) adapters[mapping.vendor] = mapping.adapter;
  }
  return Object.freeze(adapters);
}
