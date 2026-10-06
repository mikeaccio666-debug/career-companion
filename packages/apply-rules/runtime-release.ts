import {
  EXECUTION_RUNTIME_ACTIVE_VENDORS,
  EXECUTION_RUNTIME_MAPPED_ATS_PROVIDERS,
  type ExecutionRuntimeActiveVendor,
  type ExecutionRuntimeJsonObject,
  type ExecutionRuntimeJsonValue,
  type ExecutionRuntimeMappedAtsProvider,
  type ExecutionRuntimeRulesMappingV1,
  type ExecutionRuntimeRulesReleaseV1,
  type ExecutionRuntimeRulesetV1,
  type Sha256Digest,
} from '@edaix/contracts';

import ashbySource from './rules/ashby.json';
import bamboohrSource from './rules/bamboohr.json';
import doverSource from './rules/dover.json';
import genericSource from './rules/generic.json';
import greenhouseSource from './rules/greenhouse.json';
import icimsSource from './rules/icims.json';
import jobviteSource from './rules/jobvite.json';
import leverSource from './rules/lever.json';
import ripplingSource from './rules/rippling.json';
import smartrecruitersSource from './rules/smartrecruiters.json';
import workableSource from './rules/workable.json';
import workdaySource from './rules/workday.json';
import manifestSource from './release-manifest.json';

export type ApplyRulesSha256Digest = Sha256Digest;
export type ApplyRulesSourceVendor = ExecutionRuntimeActiveVendor;
export type ApplyRulesAtsProvider = ExecutionRuntimeMappedAtsProvider | 'INDEED_APPLY';
export type ApplyRulesJson = ExecutionRuntimeJsonValue;
export type ApplyRulesJsonObject = ExecutionRuntimeJsonObject;
export type ApplyRulesMappingV1 = ExecutionRuntimeRulesMappingV1;
export type ApplyRulesReleaseRulesetV1 = ExecutionRuntimeRulesetV1;
export type ApplyRulesRuntimeReleaseV1 = ExecutionRuntimeRulesReleaseV1;

export interface ApplyRulesReleaseManifestRulesetV1 {
  readonly version: string;
  readonly digest: ApplyRulesSha256Digest;
  readonly vendor: ApplyRulesSourceVendor;
}

export interface ApplyRulesReleaseManifestV1 {
  readonly schemaVersion: 1;
  readonly releaseVersion: string;
  readonly releaseDigest: ApplyRulesSha256Digest;
  readonly mappings: readonly ApplyRulesMappingV1[];
  readonly unavailableAtsProviders: readonly ['INDEED_APPLY'];
  readonly rulesets: readonly ApplyRulesReleaseManifestRulesetV1[];
}

const SOURCE_BY_VENDOR: Readonly<Record<ApplyRulesSourceVendor, unknown>> = {
  ashby: ashbySource,
  bamboohr: bamboohrSource,
  dover: doverSource,
  generic: genericSource,
  greenhouse: greenhouseSource,
  icims: icimsSource,
  jobvite: jobviteSource,
  lever: leverSource,
  rippling: ripplingSource,
  smartrecruiters: smartrecruitersSource,
  workable: workableSource,
  workday: workdaySource,
};
const SOURCE_VENDORS = EXECUTION_RUNTIME_ACTIVE_VENDORS;
const ACTIVE_ATS_PROVIDERS = EXECUTION_RUNTIME_MAPPED_ATS_PROVIDERS;
const TOKEN_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
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

/**
 * The checked-in release manifest. `$comment*` keys are packaging annotations
 * and are deliberately absent from the exported runtime object.
 */
export const APPLY_RULES_RELEASE_MANIFEST_V1 = deepFreeze(
  validateManifest(manifestSource),
);

/**
 * Immutable, annotation-free release input shared by the backend publisher and
 * local rehearsal. Presence in the package is not production authorization:
 * consumers must still verify its JCS digests and obtain a fresh backend
 * runtime-bundle fence. No consumer may use this object as a remote-authority
 * fallback.
 */
export const APPLY_RULES_RUNTIME_RELEASE_V1: ApplyRulesRuntimeReleaseV1 = deepFreeze(
  buildRuntimeRelease(),
);

/** Exact tuple lookup only. `null` means zero or multiple hits; no inference. */
export function resolveApplyRulesReleaseMappingV1(
  atsProvider: string,
  pathRuleId: string,
): ApplyRulesMappingV1 | null {
  const matches = APPLY_RULES_RUNTIME_RELEASE_V1.mappings.filter(
    (mapping) =>
      mapping.atsProvider === atsProvider && mapping.pathRuleId === pathRuleId,
  );
  return matches.length === 1 ? matches[0]! : null;
}

function validateManifest(value: unknown): ApplyRulesReleaseManifestV1 {
  if (!isRecord(value)) throw invalidRelease();
  const realKeys = Object.keys(value).filter((key) => !key.startsWith('$comment'));
  if (
    realKeys.length !== 6 ||
    ![
      'schemaVersion',
      'releaseVersion',
      'releaseDigest',
      'mappings',
      'unavailableAtsProviders',
      'rulesets',
    ].every(
      (key) => realKeys.includes(key),
    ) ||
    value['schemaVersion'] !== 1 ||
    typeof value['releaseVersion'] !== 'string' ||
    !isDigest(value['releaseDigest']) ||
    !Array.isArray(value['mappings']) ||
    !Array.isArray(value['unavailableAtsProviders']) ||
    !Array.isArray(value['rulesets'])
  ) {
    throw invalidRelease();
  }

  const rawMappings = value['mappings'] as unknown[];
  const rawRulesets = value['rulesets'] as unknown[];
  if (
    value['unavailableAtsProviders'].length !== 1 ||
    value['unavailableAtsProviders'][0] !== 'INDEED_APPLY'
  ) throw invalidRelease();
  const mappings = rawMappings.map((entry): ApplyRulesMappingV1 => {
    if (!isRecord(entry) || !hasExactKeys(entry, [
      'atsProvider',
      'pathRuleId',
      'vendor',
      'rulesetVersion',
      'rulesetDigest',
    ])) throw invalidRelease();
    if (!(ACTIVE_ATS_PROVIDERS as readonly unknown[]).includes(entry['atsProvider'])) {
      throw invalidRelease();
    }
    if (!(SOURCE_VENDORS as readonly unknown[]).includes(entry['vendor'])) throw invalidRelease();
    if (
      entry['vendor'] !==
      EXPECTED_VENDOR_BY_PROVIDER[entry['atsProvider'] as ApplyRulesMappingV1['atsProvider']]
    ) throw invalidRelease();
    if (!isToken(entry['pathRuleId']) || !isToken(entry['rulesetVersion'])) throw invalidRelease();
    if (!isDigest(entry['rulesetDigest'])) throw invalidRelease();
    return {
      atsProvider: entry['atsProvider'] as ApplyRulesMappingV1['atsProvider'],
      pathRuleId: entry['pathRuleId'],
      vendor: entry['vendor'] as ApplyRulesSourceVendor,
      rulesetVersion: entry['rulesetVersion'],
      rulesetDigest: entry['rulesetDigest'],
    };
  });
  const mappingKeys = mappings.map(
    ({ atsProvider, pathRuleId }) => `${atsProvider}\u0000${pathRuleId}`,
  );
  if (!isStrictlySortedUnique(mappingKeys)) throw invalidRelease();
  if (ACTIVE_ATS_PROVIDERS.some((provider) => !mappings.some((entry) => entry.atsProvider === provider))) {
    throw invalidRelease();
  }

  const rulesets = rawRulesets.map((entry): ApplyRulesReleaseManifestRulesetV1 => {
    if (!isRecord(entry) || !hasExactKeys(entry, ['version', 'digest', 'vendor'])) {
      throw invalidRelease();
    }
    if (!isToken(entry['version']) || !isDigest(entry['digest'])) throw invalidRelease();
    if (!(SOURCE_VENDORS as readonly unknown[]).includes(entry['vendor'])) throw invalidRelease();
    return {
      version: entry['version'],
      digest: entry['digest'],
      vendor: entry['vendor'] as ApplyRulesSourceVendor,
    };
  });
  if (!isStrictlySortedUnique(rulesets.map(({ version }) => version))) throw invalidRelease();
  if (
    rulesets.map(({ vendor }) => vendor).sort().join('\u0000') !==
    [...SOURCE_VENDORS].sort().join('\u0000')
  ) throw invalidRelease();

  const rulesetsByVersion = new Map(rulesets.map((entry) => [entry.version, entry]));
  for (const mapping of mappings) {
    const ruleset = rulesetsByVersion.get(mapping.rulesetVersion);
    if (!ruleset || ruleset.vendor !== mapping.vendor || ruleset.digest !== mapping.rulesetDigest) {
      throw invalidRelease();
    }
  }
  if (rulesets.some((ruleset) => !mappings.some((mapping) => mapping.rulesetVersion === ruleset.version))) {
    throw invalidRelease();
  }

  return {
    schemaVersion: 1,
    releaseVersion: value['releaseVersion'],
    releaseDigest: value['releaseDigest'],
    mappings,
    unavailableAtsProviders: ['INDEED_APPLY'],
    rulesets,
  };
}

function buildRuntimeRelease(): ApplyRulesRuntimeReleaseV1 {
  const rulesets = APPLY_RULES_RELEASE_MANIFEST_V1.rulesets.map(({ version, digest, vendor }) => {
    const ruleset = stripAnnotations(SOURCE_BY_VENDOR[vendor]);
    if (ruleset['vendor'] !== vendor) throw invalidRelease();
    return { version, digest, ruleset };
  });
  return {
    releaseVersion: APPLY_RULES_RELEASE_MANIFEST_V1.releaseVersion,
    releaseDigest: APPLY_RULES_RELEASE_MANIFEST_V1.releaseDigest,
    mappings: APPLY_RULES_RELEASE_MANIFEST_V1.mappings,
    rulesets,
  };
}

function stripAnnotations(value: unknown): ApplyRulesJsonObject {
  const stripped = stripJson(value);
  if (!isRecord(stripped)) throw invalidRelease();
  return stripped as ApplyRulesJsonObject;
}

function stripJson(value: unknown): ApplyRulesJson {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map(stripJson);
  if (!isRecord(value)) throw invalidRelease();

  const result: Record<string, ApplyRulesJson> = {};
  for (const [key, child] of Object.entries(value)) {
    if (FORBIDDEN_JSON_KEYS.has(key)) throw invalidRelease();
    if (!key.startsWith('$comment')) result[key] = stripJson(child);
  }
  return result;
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => actual.includes(key));
}

function isDigest(value: unknown): value is ApplyRulesSha256Digest {
  return typeof value === 'string' && /^sha256:[0-9a-f]{64}$/.test(value);
}

function isToken(value: unknown): value is string {
  return typeof value === 'string' && TOKEN_PATTERN.test(value);
}

function isStrictlySortedUnique(values: readonly string[]): boolean {
  return values.every((value, index) => index === 0 || values[index - 1]! < value);
}

function invalidRelease(): Error {
  return new Error('APPLY_RULES_RELEASE_INVALID');
}
