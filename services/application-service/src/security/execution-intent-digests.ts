/**
 * Adapted from argoland 013d5128bd474f98b78df8c9878e1321712b134b.
 * Pure migration seam; importing this file grants no execution authority.
 */
import {
  ATS_PROVIDER_CODES,
  EXECUTION_ALLOWED_ACTIONS,
  SOURCE_PLATFORM_CODES,
  type AtsProviderCode,
  type ExecutionAllowedAction,
  type SourcePlatformCode,
} from '@edaix/contracts';
import {
  APPLICATION_PROFILE_FIELD_SCHEMA_VERSION,
  SORTED_APPLICATION_PROFILE_CANONICAL_FIELD_KEYS,
  type ApplicationProfileCanonicalFieldKey,
} from './application-profile-fields.contract.ts';
import { sha256Jcs } from './jcs.ts';

function frozenContractTuple<const T extends readonly string[]>(values: T): T {
  return Object.freeze([...values]) as unknown as T;
}

export const EXECUTION_INTENT_SOURCE_PLATFORMS = frozenContractTuple(SOURCE_PLATFORM_CODES);
export const EXECUTION_INTENT_ATS_PROVIDERS = frozenContractTuple(ATS_PROVIDER_CODES);
export const EXECUTION_INTENT_ALLOWED_ACTIONS = frozenContractTuple(EXECUTION_ALLOWED_ACTIONS);

export type ExecutionIntentSourcePlatform = SourcePlatformCode;
export type ExecutionIntentAtsProvider = AtsProviderCode;
export type ExecutionIntentAllowedAction = ExecutionAllowedAction;

export type ExecutionIntentTarget = Readonly<{
  jobId: string;
  sourcePlatform: ExecutionIntentSourcePlatform;
  atsProvider: ExecutionIntentAtsProvider;
  canonicalOrigin: string;
  pathRuleId: string;
  postingFingerprint: string;
}>;

export function buildJobIdentityHashV1(target: ExecutionIntentTarget): `sha256:${string}` {
  return sha256Jcs({
    schemaVersion: 1,
    jobId: target.jobId,
    sourcePlatform: target.sourcePlatform,
    atsProvider: target.atsProvider,
    canonicalOrigin: target.canonicalOrigin,
    pathRuleId: target.pathRuleId,
    postingFingerprint: target.postingFingerprint,
  });
}

export function buildScanDigestV1(input: Readonly<{
  canonicalOrigin: string;
  pathname: string;
  vendor: string;
  fieldKeys: readonly string[];
}>): `sha256:${string}` {
  return sha256Jcs({
    schemaVersion: 1,
    canonicalOrigin: input.canonicalOrigin,
    pathname: input.pathname,
    vendor: input.vendor,
    fieldKeys: normalizeFieldKeysV1(input.fieldKeys),
  });
}

/** Stable idempotency preimage for arming a submit-capable claim attempt. */
export function buildApplicationSubmitAttemptOriginDigestV1(input: Readonly<{
  missionId: string;
  executionStepId: string;
  intentVersion: number;
  intentJtiHash: string;
}>): `sha256:${string}` {
  return sha256Jcs({
    schemaVersion: 1,
    kind: 'EXECUTION_INTENT_CLAIM_ARM',
    missionId: input.missionId,
    executionStepId: input.executionStepId,
    intentVersion: input.intentVersion,
    intentJtiHash: input.intentJtiHash,
  });
}

export function buildProfileSnapshotDigestV1(input: Readonly<{
  revision: string;
  deletionEpoch: string;
  fieldKeys: readonly ApplicationProfileCanonicalFieldKey[];
}>): `sha256:${string}` {
  return sha256Jcs({
    schemaVersion: 1,
    revision: input.revision,
    deletionEpoch: input.deletionEpoch,
    fieldSchemaVersion: APPLICATION_PROFILE_FIELD_SCHEMA_VERSION,
    fieldKeys: assertCanonicalFieldKeysV1(input.fieldKeys),
  });
}

export function buildExecutionPlanDigestV1(input: Readonly<{
  missionId: string;
  missionRevision: string;
  missionStepId: string;
  stepAttempt: number;
  actionId: string;
  jobIdentityHash: string;
  fieldKeys: readonly ApplicationProfileCanonicalFieldKey[];
  automationLevel:
    | 'L0_PREVIEW_ONLY'
    | 'L1_FILL_STOP_BEFORE_SUBMIT'
    | 'L2_CONFIRM_EACH_SUBMISSION'
    | 'L3_MANAGED_BATCH';
  allowedActions: readonly ExecutionIntentAllowedAction[];
  profile: Readonly<{ revision: string; deletionEpoch: string; snapshotDigest: string }>;
  resume: Readonly<{
    versionId: string;
    contentHash: string;
    contentRevision: string;
    libraryRevision: string;
  }>;
  policyVersion: string;
  killSwitchVersion: string;
  consentVersion: string;
}>): `sha256:${string}` {
  return sha256Jcs({
    schemaVersion: 1,
    missionId: input.missionId,
    missionRevision: input.missionRevision,
    missionStepId: input.missionStepId,
    stepAttempt: input.stepAttempt,
    actionId: input.actionId,
    jobIdentityHash: input.jobIdentityHash,
    fieldSchemaVersion: APPLICATION_PROFILE_FIELD_SCHEMA_VERSION,
    fieldKeys: assertCanonicalFieldKeysV1(input.fieldKeys),
    automationLevel: input.automationLevel,
    allowedActions: assertCanonicalAllowedActionsV1(input.allowedActions),
    profile: {
      revision: input.profile.revision,
      deletionEpoch: input.profile.deletionEpoch,
      snapshotDigest: input.profile.snapshotDigest,
    },
    resume: {
      versionId: input.resume.versionId,
      contentHash: input.resume.contentHash,
      contentRevision: input.resume.contentRevision,
      libraryRevision: input.resume.libraryRevision,
    },
    policyVersion: input.policyVersion,
    killSwitchVersion: input.killSwitchVersion,
    consentVersion: input.consentVersion,
  });
}

/**
 * T11 plan authority. The public Intent/receipt wire continues to carry only
 * the opaque planDigest; these server-owned fields are deliberately confined
 * to the preimage rebuilt from the locked Mission/Application rows.
 */
export function buildExecutionPlanDigestV2(input: Readonly<{
  missionId: string;
  missionRevision: string;
  missionStepId: string;
  stepAttempt: number;
  actionId: string;
  jobIdentityHash: string;
  canonicalJobId: string;
  applicationId: string;
  applicationBundleVersion: string;
  applicationRevision: string;
  fieldKeys: readonly ApplicationProfileCanonicalFieldKey[];
  automationLevel:
    | 'L0_PREVIEW_ONLY'
    | 'L1_FILL_STOP_BEFORE_SUBMIT'
    | 'L2_CONFIRM_EACH_SUBMISSION'
    | 'L3_MANAGED_BATCH';
  allowedActions: readonly ExecutionIntentAllowedAction[];
  profile: Readonly<{ revision: string; deletionEpoch: string; snapshotDigest: string }>;
  resume: Readonly<{
    versionId: string;
    contentHash: string;
    contentRevision: string;
    libraryRevision: string;
  }>;
  policyVersion: string;
  killSwitchVersion: string;
  consentVersion: string;
}>): `sha256:${string}` {
  return sha256Jcs({
    schemaVersion: 2,
    missionId: input.missionId,
    missionRevision: input.missionRevision,
    missionStepId: input.missionStepId,
    stepAttempt: input.stepAttempt,
    actionId: input.actionId,
    jobIdentityHash: input.jobIdentityHash,
    canonicalJobId: input.canonicalJobId,
    applicationId: input.applicationId,
    applicationBundleVersion: input.applicationBundleVersion,
    applicationRevision: input.applicationRevision,
    fieldSchemaVersion: APPLICATION_PROFILE_FIELD_SCHEMA_VERSION,
    fieldKeys: assertCanonicalFieldKeysV1(input.fieldKeys),
    automationLevel: input.automationLevel,
    allowedActions: assertCanonicalAllowedActionsV1(input.allowedActions),
    profile: {
      revision: input.profile.revision,
      deletionEpoch: input.profile.deletionEpoch,
      snapshotDigest: input.profile.snapshotDigest,
    },
    resume: {
      versionId: input.resume.versionId,
      contentHash: input.resume.contentHash,
      contentRevision: input.resume.contentRevision,
      libraryRevision: input.resume.libraryRevision,
    },
    policyVersion: input.policyVersion,
    killSwitchVersion: input.killSwitchVersion,
    consentVersion: input.consentVersion,
  });
}

export function assertCanonicalFieldKeysV1(
  fieldKeys: readonly string[],
): readonly ApplicationProfileCanonicalFieldKey[] {
  const normalized = normalizeFieldKeysV1(fieldKeys);
  if (
    normalized.length === 0 ||
    normalized.length !== fieldKeys.length ||
    normalized.some((key, index) => key !== fieldKeys[index])
  ) {
    throw new Error('EXECUTION_FIELD_SET_INVALID');
  }
  return normalized;
}

export function assertCanonicalAllowedActionsV1(
  actions: readonly string[],
): readonly ExecutionIntentAllowedAction[] {
  const allowed = new Set<string>(EXECUTION_INTENT_ALLOWED_ACTIONS);
  if (
    actions.length === 0 ||
    actions.some((action) => !allowed.has(action)) ||
    new Set(actions).size !== actions.length ||
    actions.some((action, index) => action !== [...actions].sort()[index])
  ) {
    throw new Error('EXECUTION_ACTION_SET_INVALID');
  }
  return Object.freeze([...actions]) as readonly ExecutionIntentAllowedAction[];
}

function normalizeFieldKeysV1(
  fieldKeys: readonly string[],
): readonly ApplicationProfileCanonicalFieldKey[] {
  const allowed = new Set<string>(SORTED_APPLICATION_PROFILE_CANONICAL_FIELD_KEYS);
  if (fieldKeys.some((key) => !allowed.has(key))) {
    throw new Error('EXECUTION_FIELD_SET_INVALID');
  }
  return Object.freeze(
    [...new Set(fieldKeys)].sort(),
  ) as readonly ApplicationProfileCanonicalFieldKey[];
}
