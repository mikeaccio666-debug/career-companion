import {
  parseUuid,
  type EnterSubmissionBoundaryParams,
  type EnterSubmissionBoundaryRequest,
} from '@edaix/contracts';

type AuthorityKey =
  | 'expectedMissionRevision'
  | 'missionStepId'
  | 'stepAttempt'
  | 'applicationId'
  | 'expectedApplicationRevision'
  | 'applicationBundleVersion';
type ConsumerValue<T> = T extends string ? string : T;
type BoundaryAuthorityFields = {
  readonly [Key in AuthorityKey]: ConsumerValue<EnterSubmissionBoundaryRequest[Key]>;
};

/** Value-free authority projected from the sole Mission contract. */
export type SubmissionAuthority = Readonly<
  { readonly missionId: ConsumerValue<EnterSubmissionBoundaryParams['missionId']> } & BoundaryAuthorityFields
>;

export type SubmissionBoundaryRuntimeState =
  | 'ARMED'
  | 'BOUNDARY_PENDING'
  | 'WAIT_FOR_USER_RETRY'
  | 'WAIT_FOR_FINAL_RETRY'
  | 'OUTCOME_UNKNOWN'
  | 'TRIGGERED_LOCKED'
  | 'BLOCKED';

export type ActiveSubmissionArmDescriptor =
  | Readonly<{
      mode: 'ACTIVE';
      bindingId: string;
      authority: SubmissionAuthority;
      expiresAtMs: number;
      state: Exclude<
        SubmissionBoundaryRuntimeState,
        'WAIT_FOR_USER_RETRY' | 'WAIT_FOR_FINAL_RETRY'
      >;
    }>
  | Readonly<{
      mode: 'ACTIVE';
      bindingId: string;
      authority: SubmissionAuthority;
      expiresAtMs: number;
      state: 'WAIT_FOR_USER_RETRY';
      triggerClientRequestId: string;
    }>
  | Readonly<{
      mode: 'ACTIVE';
      bindingId: string;
      authority: SubmissionAuthority;
      expiresAtMs: number;
      state: 'WAIT_FOR_FINAL_RETRY';
      triggerClientRequestId: string;
    }>;
export type SubmissionArmDescriptor =
  | Readonly<{ mode: 'BLOCKED' }>
  | ActiveSubmissionArmDescriptor;

export type SubmissionBoundaryEnterMessage = Readonly<{
  kind: 'submission-boundary/enter';
  bindingId: string;
  authority: SubmissionAuthority;
}>;

type SubmissionBoundaryTriggerMessageBase = Readonly<{
  bindingId: string;
  authority: SubmissionAuthority;
  triggerClientRequestId: string;
}>;

export type SubmissionBoundaryTriggerObservedMessage =
  SubmissionBoundaryTriggerMessageBase & Readonly<{
    kind: 'submission-boundary/trigger-observed';
  }>;

export type SubmissionBoundaryTriggerConfirmedMessage =
  SubmissionBoundaryTriggerMessageBase & Readonly<{
    kind: 'submission-boundary/trigger-confirmed';
  }>;

export type SubmissionBoundaryTriggerCancelledMessage =
  SubmissionBoundaryTriggerMessageBase & Readonly<{
    kind: 'submission-boundary/trigger-cancelled';
  }>;

export type SubmissionBoundaryTriggerMessage =
  | SubmissionBoundaryTriggerObservedMessage
  | SubmissionBoundaryTriggerConfirmedMessage
  | SubmissionBoundaryTriggerCancelledMessage;

export type SubmissionBoundaryRuntimeMessage =
  | SubmissionBoundaryEnterMessage
  | SubmissionBoundaryTriggerMessage;

const AUTHORITY_KEYS = [
  'missionId',
  'expectedMissionRevision',
  'missionStepId',
  'stepAttempt',
  'applicationId',
  'expectedApplicationRevision',
  'applicationBundleVersion',
] as const;

export function parseSubmissionAuthority(value: unknown): SubmissionAuthority | null {
  if (!exactRecord(value, AUTHORITY_KEYS)) return null;
  if (
    !parseUuid(value['missionId']) ||
    !positiveDecimal(value['expectedMissionRevision']) ||
    !parseUuid(value['missionStepId']) ||
    !Number.isInteger(value['stepAttempt']) ||
    Number(value['stepAttempt']) < 1 ||
    !parseUuid(value['applicationId']) ||
    !positiveDecimal(value['expectedApplicationRevision']) ||
    !positiveDecimal(value['applicationBundleVersion'])
  ) return null;
  return value as unknown as SubmissionAuthority;
}

export function parseSubmissionArmDescriptor(value: unknown): SubmissionArmDescriptor | null {
  if (!isRecord(value)) return null;
  if (value['mode'] === 'BLOCKED') {
    return exactRecord(value, ['mode']) ? { mode: 'BLOCKED' } : null;
  }
  if (
    value['mode'] !== 'ACTIVE' ||
    !parseUuid(value['bindingId']) ||
    !Number.isSafeInteger(value['expiresAtMs']) ||
    Number(value['expiresAtMs']) <= 0
  ) return null;
  const authority = parseSubmissionAuthority(value['authority']);
  if (!authority || typeof value['state'] !== 'string') return null;
  if (
    value['state'] === 'WAIT_FOR_USER_RETRY' ||
    value['state'] === 'WAIT_FOR_FINAL_RETRY'
  ) {
    if (
      !exactRecord(value, [
        'mode', 'bindingId', 'authority', 'expiresAtMs', 'state', 'triggerClientRequestId',
      ]) ||
      !parseUuid(value['triggerClientRequestId'])
    ) return null;
    return value as unknown as SubmissionArmDescriptor;
  }
  if (
    !['ARMED', 'BOUNDARY_PENDING', 'OUTCOME_UNKNOWN', 'TRIGGERED_LOCKED', 'BLOCKED'].includes(
      value['state'],
    ) ||
    !exactRecord(value, ['mode', 'bindingId', 'authority', 'expiresAtMs', 'state'])
  ) return null;
  return value as unknown as SubmissionArmDescriptor;
}

export function parseSubmissionRuntimeMessage(
  value: unknown,
): SubmissionBoundaryRuntimeMessage | null {
  if (!isRecord(value) || !parseUuid(value['bindingId'])) return null;
  const authority = parseSubmissionAuthority(value['authority']);
  if (!authority) return null;
  if (value['kind'] === 'submission-boundary/enter') {
    return exactRecord(value, ['kind', 'bindingId', 'authority'])
      ? (value as unknown as SubmissionBoundaryEnterMessage)
      : null;
  }
  if ([
    'submission-boundary/trigger-observed',
    'submission-boundary/trigger-confirmed',
    'submission-boundary/trigger-cancelled',
  ].includes(String(value['kind']))) {
    if (
      !exactRecord(value, ['kind', 'bindingId', 'authority', 'triggerClientRequestId']) ||
      !parseUuid(value['triggerClientRequestId'])
    ) return null;
    return value as unknown as SubmissionBoundaryTriggerMessage;
  }
  return null;
}

export function sameSubmissionAuthority(
  left: SubmissionAuthority,
  right: SubmissionAuthority,
): boolean {
  return AUTHORITY_KEYS.every((key) => left[key] === right[key]);
}

function positiveDecimal(value: unknown): value is string {
  return typeof value === 'string' && /^[1-9][0-9]*$/.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function exactRecord(
  value: unknown,
  keys: readonly string[],
): value is Record<string, unknown> {
  return isRecord(value) &&
    Object.keys(value).sort().join(',') === [...keys].sort().join(',');
}
