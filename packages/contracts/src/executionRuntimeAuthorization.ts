import { EXECUTION_RUNTIME_MAPPED_ATS_PROVIDERS,
  type ExecutionRuntimeMappedAtsProvider, type ExecutionRuntimeActiveVendor } from './executionRuntime.ts';

/** Existing selector-free runtime identity; parsing alone grants no authority. */
export interface ExecutionRuntimeAuthorizationV1 {
  readonly schemaVersion: 1;
  readonly purpose: 'DISCOVERY' | 'EXECUTION';
  readonly runtimeBundleVersion: string;
  readonly releaseRevision: string;
  readonly policyVersion: string;
  readonly rulesReleaseVersion: string;
  readonly rulesReleaseDigest: string;
  readonly atsProvider: ExecutionRuntimeMappedAtsProvider;
  readonly pathRuleId: string;
  readonly vendor: ExecutionRuntimeActiveVendor;
  readonly rulesetVersion: string;
  readonly rulesetDigest: string;
}

export const EXECUTION_RUNTIME_AUTHORIZATION_KEYS = [
  'schemaVersion', 'purpose', 'runtimeBundleVersion', 'releaseRevision', 'policyVersion',
  'rulesReleaseVersion', 'rulesReleaseDigest', 'atsProvider', 'pathRuleId', 'vendor', 'rulesetVersion', 'rulesetDigest',
] as const;
const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/u;
const DIGEST = /^sha256:[a-f0-9]{64}$/u;
const VENDOR = { ASHBY: 'ashby', BAMBOOHR: 'bamboohr', DOVER: 'dover', GENERIC: 'generic', GREENHOUSE: 'greenhouse',
  ICIMS: 'icims', JOBVITE: 'jobvite', LEVER: 'lever', RIPPLING: 'rippling',
  SMARTRECRUITERS: 'smartrecruiters', WORKABLE: 'workable', WORKDAY: 'workday' } as const;

export function parseExecutionRuntimeAuthorizationV1(input: unknown): ExecutionRuntimeAuthorizationV1 | null {
  try {
    if (typeof input !== 'object' || input === null || Array.isArray(input)) return null;
    const proto = Object.getPrototypeOf(input);
    if (proto !== Object.prototype && proto !== null) return null;
    const properties = Object.getOwnPropertyDescriptors(input), keys = Reflect.ownKeys(properties);
    if (keys.length !== EXECUTION_RUNTIME_AUTHORIZATION_KEYS.length ||
        keys.some((key) => typeof key !== 'string' || !EXECUTION_RUNTIME_AUTHORIZATION_KEYS.includes(key as never))) return null;
    const value: Record<string, unknown> = {};
    for (const key of EXECUTION_RUNTIME_AUTHORIZATION_KEYS) {
      const property = properties[key];
      if (!property || !('value' in property) || !property.enumerable) return null;
      value[key] = property.value;
    }
    if (value.schemaVersion !== 1 || (value.purpose !== 'DISCOVERY' && value.purpose !== 'EXECUTION') ||
        typeof value.runtimeBundleVersion !== 'string' || !/^rb1_[a-f0-9]{64}$/u.test(value.runtimeBundleVersion) ||
        typeof value.releaseRevision !== 'string' || !/^(?:0|[1-9][0-9]{0,18})$/u.test(value.releaseRevision) ||
        !['policyVersion', 'rulesReleaseVersion', 'pathRuleId', 'rulesetVersion'].every((key) => typeof value[key] === 'string' && TOKEN.test(value[key])) ||
        !['rulesReleaseDigest', 'rulesetDigest'].every((key) => typeof value[key] === 'string' && DIGEST.test(value[key])) ||
        !EXECUTION_RUNTIME_MAPPED_ATS_PROVIDERS.includes(value.atsProvider as ExecutionRuntimeMappedAtsProvider) ||
        value.vendor !== VENDOR[value.atsProvider as ExecutionRuntimeMappedAtsProvider]) return null;
    return Object.freeze(value as unknown as ExecutionRuntimeAuthorizationV1);
  } catch { return null; }
}
