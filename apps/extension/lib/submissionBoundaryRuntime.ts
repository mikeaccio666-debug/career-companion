import type {
  EnterSubmissionBoundaryRequest,
  RecordSubmissionEventRequest,
} from '@edaix/contracts';
import { parseUuid } from '@edaix/contracts';
import type { SubmissionBoundaryClient } from './submissionBoundaryClient';
import {
  parseSubmissionAuthority,
  sameSubmissionAuthority,
  type ActiveSubmissionArmDescriptor,
  type SubmissionArmDescriptor,
  type SubmissionAuthority,
  type SubmissionBoundaryEnterMessage,
  type SubmissionBoundaryRuntimeMessage,
  type SubmissionBoundaryRuntimeState,
  type SubmissionBoundaryTriggerCancelledMessage,
  type SubmissionBoundaryTriggerConfirmedMessage,
  type SubmissionBoundaryTriggerMessage,
  type SubmissionBoundaryTriggerObservedMessage,
} from './submissionBoundaryProtocol';

const SNAPSHOT_VERSION = 2;

type ActiveState = Exclude<
  SubmissionBoundaryRuntimeState,
  'WAIT_FOR_USER_RETRY' | 'WAIT_FOR_FINAL_RETRY'
>;

interface StoredBinding {
  readonly bindingId: string;
  readonly tabId: number;
  readonly authority: SubmissionAuthority;
  readonly expiresAtMs: number;
  state: SubmissionBoundaryRuntimeState;
  boundaryClientRequestId: string | null;
  boundaryId: string | null;
  attemptRevision: string | null;
  acceptedApplicationRevision: string | null;
  triggerClientRequestId: string | null;
  triggerOutboxState:
    | 'READY_FOR_USER_GESTURE'
    | 'FINAL_RETRY_PREPARED'
    | 'TRIGGER_CONFIRMED'
    | null;
}

interface LegacyAuthorityBlock {
  readonly tabId: number;
  readonly authority: SubmissionAuthority;
}

interface Snapshot {
  readonly schemaVersion: typeof SNAPSHOT_VERSION;
  readonly bindings: Record<string, StoredBinding>;
  readonly legacyAuthorityBlocks: readonly LegacyAuthorityBlock[];
}

export interface SubmissionBoundaryPersistence {
  load(): Promise<unknown>;
  save(value: Readonly<Snapshot>): Promise<void>;
}

export interface SubmissionBoundaryRuntime {
  arm(
    tabId: number,
    authority: SubmissionAuthority,
    expiresAtMs: number,
  ): Promise<ActiveSubmissionArmDescriptor>;
  enter(
    tabId: number,
    message: SubmissionBoundaryEnterMessage,
  ): Promise<SubmissionArmDescriptor>;
  observeTrigger(
    tabId: number,
    message: SubmissionBoundaryTriggerObservedMessage,
  ): Promise<SubmissionArmDescriptor>;
  confirmTrigger(
    tabId: number,
    message: SubmissionBoundaryTriggerConfirmedMessage,
  ): Promise<SubmissionArmDescriptor>;
  cancelTrigger(
    tabId: number,
    message: SubmissionBoundaryTriggerCancelledMessage,
  ): Promise<SubmissionArmDescriptor>;
  handleMessage(tabId: number, message: SubmissionBoundaryRuntimeMessage): Promise<SubmissionArmDescriptor>;
  recover(): Promise<void>;
}

export function createSubmissionBoundaryRuntime(input: Readonly<{
  client: SubmissionBoundaryClient;
  persistence: SubmissionBoundaryPersistence;
  newUuid?: () => string;
  now?: () => number;
}>): SubmissionBoundaryRuntime {
  const newUuid = input.newUuid ?? (() => crypto.randomUUID());
  const now = input.now ?? Date.now;
  let serial: Promise<unknown> = Promise.resolve();

  function exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = serial.then(operation, operation);
    serial = result.then(() => undefined, () => undefined);
    return result;
  }

  function allocateUuid(): string {
    const value = newUuid();
    if (!parseUuid(value)) throw new Error('SUBMISSION_BOUNDARY_UUID_UNAVAILABLE');
    return value;
  }

  async function load(): Promise<Snapshot> {
    const raw = await input.persistence.load();
    if (raw === undefined) {
      return { schemaVersion: SNAPSHOT_VERSION, bindings: {}, legacyAuthorityBlocks: [] };
    }
    const parsed = parseSnapshot(raw);
    if (parsed) return parsed;
    const migrated = migrateLegacySnapshot(raw);
    if (!migrated) throw new Error('SUBMISSION_BOUNDARY_STORAGE_INVALID');
    await input.persistence.save(migrated);
    return migrated;
  }

  function descriptor(record: StoredBinding): SubmissionArmDescriptor {
    if (
      (record.state === 'WAIT_FOR_USER_RETRY' || record.state === 'WAIT_FOR_FINAL_RETRY') &&
      record.triggerClientRequestId
    ) {
      return Object.freeze({
        mode: 'ACTIVE' as const,
        bindingId: record.bindingId,
        authority: record.authority,
        expiresAtMs: record.expiresAtMs,
        state: record.state,
        triggerClientRequestId: record.triggerClientRequestId,
      }) as unknown as SubmissionArmDescriptor;
    }
    return Object.freeze({
      mode: 'ACTIVE' as const,
      bindingId: record.bindingId,
      authority: record.authority,
      expiresAtMs: record.expiresAtMs,
      state: record.state as ActiveState,
    }) as unknown as SubmissionArmDescriptor;
  }

  async function armInner(
    tabId: number,
    authority: SubmissionAuthority,
    expiresAtMs: number,
  ): Promise<ActiveSubmissionArmDescriptor> {
    const nowMs = now();
    if (
      !Number.isFinite(nowMs) ||
      !Number.isSafeInteger(expiresAtMs) ||
      expiresAtMs <= nowMs
    ) throw new Error('SUBMISSION_AUTHORITY_EXPIRED');
    const snapshot = await load();
    if (snapshot.legacyAuthorityBlocks.some(
      (candidate) =>
        candidate.tabId === tabId && sameSubmissionAuthority(candidate.authority, authority),
    )) throw new Error('SUBMISSION_BOUNDARY_LEGACY_STATE_UNRESOLVED');

    // A new arm call proves the previous content-local prepared token is gone.
    // Because the last trusted click might have started just before that loss,
    // preserve the exact authority as outcome-unknown instead of reusing it.
    const risky = Object.values(snapshot.bindings).find(
      (candidate) =>
        candidate.tabId === tabId &&
        sameSubmissionAuthority(candidate.authority, authority) &&
        ['WAIT_FOR_FINAL_RETRY', 'OUTCOME_UNKNOWN', 'TRIGGERED_LOCKED'].includes(candidate.state),
    );
    if (risky) {
      if (risky.state === 'WAIT_FOR_FINAL_RETRY') {
        risky.state = 'OUTCOME_UNKNOWN';
        risky.triggerClientRequestId = null;
        risky.triggerOutboxState = null;
        await input.persistence.save(snapshot);
      }
      return descriptor(risky) as ActiveSubmissionArmDescriptor;
    }
    const existing = Object.values(snapshot.bindings).find(
      (candidate) =>
        candidate.tabId === tabId &&
        candidate.expiresAtMs === expiresAtMs &&
        candidate.expiresAtMs > nowMs &&
        sameSubmissionAuthority(candidate.authority, authority),
    );
    if (existing) return descriptor(existing) as ActiveSubmissionArmDescriptor;
    const bindingId = allocateUuid();
    const record: StoredBinding = {
      bindingId,
      tabId,
      authority,
      expiresAtMs,
      state: 'ARMED',
      boundaryClientRequestId: null,
      boundaryId: null,
      attemptRevision: null,
      acceptedApplicationRevision: null,
      triggerClientRequestId: null,
      triggerOutboxState: null,
    };
    snapshot.bindings[bindingId] = record;
    await input.persistence.save(snapshot);
    return descriptor(record) as ActiveSubmissionArmDescriptor;
  }

  async function enterInner(
    tabId: number,
    message: SubmissionBoundaryEnterMessage,
  ): Promise<SubmissionArmDescriptor> {
    const snapshot = await load();
    const record = boundRecord(snapshot, tabId, message.bindingId, message.authority, now());
    if (!record) return { mode: 'BLOCKED' };
    if (record.state === 'WAIT_FOR_USER_RETRY' || record.state === 'TRIGGERED_LOCKED') {
      return descriptor(record);
    }
    if (record.state !== 'ARMED' && record.state !== 'BOUNDARY_PENDING') {
      return descriptor(record);
    }
    if (record.state === 'ARMED') {
      record.state = 'BOUNDARY_PENDING';
      record.boundaryClientRequestId = allocateUuid();
      await input.persistence.save(snapshot);
    }

    const request: Omit<EnterSubmissionBoundaryRequest, 'extensionInstallId'> = {
      clientRequestId: record.boundaryClientRequestId as EnterSubmissionBoundaryRequest['clientRequestId'],
      expectedMissionRevision: record.authority.expectedMissionRevision as EnterSubmissionBoundaryRequest['expectedMissionRevision'],
      missionStepId: record.authority.missionStepId as EnterSubmissionBoundaryRequest['missionStepId'],
      stepAttempt: record.authority.stepAttempt,
      applicationId: record.authority.applicationId as EnterSubmissionBoundaryRequest['applicationId'],
      expectedApplicationRevision: record.authority.expectedApplicationRevision as EnterSubmissionBoundaryRequest['expectedApplicationRevision'],
      applicationBundleVersion: record.authority.applicationBundleVersion as EnterSubmissionBoundaryRequest['applicationBundleVersion'],
    };
    const result = await input.client.enterBoundary(record.authority.missionId, request);
    if (!result.ok) return descriptor(record);

    record.boundaryId = result.value.boundary.id;
    record.attemptRevision = result.value.boundary.attemptRevision;
    record.acceptedApplicationRevision = result.value.application.applicationRevision;
    record.triggerClientRequestId = null;
    record.triggerOutboxState = null;
    switch (result.value.application.submissionState) {
      case 'TRIGGERING_RISK':
        record.triggerClientRequestId = allocateUuid();
        record.triggerOutboxState = 'READY_FOR_USER_GESTURE';
        record.state = 'WAIT_FOR_USER_RETRY';
        break;
      case 'OUTCOME_UNKNOWN':
        // A server-live replay is not proof that this runtime observed or
        // confirmed a local trigger. Keep the permanent guard without an outbox.
        record.state = 'OUTCOME_UNKNOWN';
        break;
      case 'TRIGGERED_LOCKED':
        record.state = 'TRIGGERED_LOCKED';
        break;
      default:
        return descriptor(record);
    }
    await input.persistence.save(snapshot);
    return descriptor(record);
  }

  function triggerRecord(
    snapshot: Snapshot,
    tabId: number,
    message: SubmissionBoundaryTriggerMessage,
    requireCurrentLease = true,
  ): StoredBinding | null {
    const record = snapshot.bindings[message.bindingId];
    const nowMs = requireCurrentLease ? now() : 0;
    if (!record ||
      record.tabId !== tabId ||
      !sameSubmissionAuthority(record.authority, message.authority) ||
      (requireCurrentLease && !(Number.isFinite(nowMs) && record.expiresAtMs > nowMs)) ||
      record.triggerClientRequestId !== message.triggerClientRequestId ||
      !record.boundaryId ||
      !record.attemptRevision ||
      !record.acceptedApplicationRevision
    ) return null;
    return record;
  }

  async function observeTriggerInner(
    tabId: number,
    message: SubmissionBoundaryTriggerObservedMessage,
  ): Promise<SubmissionArmDescriptor> {
    const snapshot = await load();
    const record = triggerRecord(snapshot, tabId, message);
    if (!record) return { mode: 'BLOCKED' };
    if (record.state === 'TRIGGERED_LOCKED') return descriptor(record);
    if (record.state === 'WAIT_FOR_USER_RETRY') {
      record.state = 'WAIT_FOR_FINAL_RETRY';
      record.triggerOutboxState = 'FINAL_RETRY_PREPARED';
      await input.persistence.save(snapshot);
    }
    return descriptor(record);
  }

  async function cancelTriggerInner(
    tabId: number,
    message: SubmissionBoundaryTriggerCancelledMessage,
  ): Promise<SubmissionArmDescriptor> {
    const snapshot = await load();
    // Cancellation only narrows a known-blocked local preparation, so an exact
    // stale binding may be safely cancelled even after its execution lease.
    const record = triggerRecord(snapshot, tabId, message, false);
    if (!record) return { mode: 'BLOCKED' };
    if (
      record.state === 'WAIT_FOR_FINAL_RETRY' &&
      record.triggerOutboxState === 'FINAL_RETRY_PREPARED'
    ) {
      record.state = 'WAIT_FOR_USER_RETRY';
      record.triggerOutboxState = 'READY_FOR_USER_GESTURE';
      await input.persistence.save(snapshot);
    }
    return descriptor(record);
  }

  async function confirmTriggerInner(
    tabId: number,
    message: SubmissionBoundaryTriggerConfirmedMessage,
    replayPersistedConfirmation = false,
  ): Promise<SubmissionArmDescriptor> {
    const snapshot = await load();
    const record = triggerRecord(snapshot, tabId, message, !replayPersistedConfirmation);
    if (!record) return { mode: 'BLOCKED' };
    if (record.state === 'TRIGGERED_LOCKED') return descriptor(record);
    if (
      record.state === 'WAIT_FOR_FINAL_RETRY' &&
      record.triggerOutboxState === 'FINAL_RETRY_PREPARED'
    ) {
      record.state = 'OUTCOME_UNKNOWN';
      record.triggerOutboxState = 'TRIGGER_CONFIRMED';
      await input.persistence.save(snapshot);
    } else if (
      record.state !== 'OUTCOME_UNKNOWN' ||
      record.triggerOutboxState !== 'TRIGGER_CONFIRMED'
    ) return descriptor(record);

    const request: Omit<
      Extract<RecordSubmissionEventRequest, { eventType: 'SUBMISSION_TRIGGERED' }>,
      'extensionInstallId'
    > = {
      clientRequestId: record.triggerClientRequestId as Extract<
        RecordSubmissionEventRequest,
        { eventType: 'SUBMISSION_TRIGGERED' }
      >['clientRequestId'],
      eventType: 'SUBMISSION_TRIGGERED',
      applicationId: record.authority.applicationId as Extract<
        RecordSubmissionEventRequest,
        { eventType: 'SUBMISSION_TRIGGERED' }
      >['applicationId'],
      expectedApplicationRevision: record.acceptedApplicationRevision as Extract<
        RecordSubmissionEventRequest,
        { eventType: 'SUBMISSION_TRIGGERED' }
      >['expectedApplicationRevision'],
      applicationBundleVersion: record.authority.applicationBundleVersion as Extract<
        RecordSubmissionEventRequest,
        { eventType: 'SUBMISSION_TRIGGERED' }
      >['applicationBundleVersion'],
      boundaryId: record.boundaryId as Extract<
        RecordSubmissionEventRequest,
        { eventType: 'SUBMISSION_TRIGGERED' }
      >['boundaryId'],
      attemptRevision: record.attemptRevision as Extract<
        RecordSubmissionEventRequest,
        { eventType: 'SUBMISSION_TRIGGERED' }
      >['attemptRevision'],
    };
    const result = await input.client.recordTriggered(record.authority.missionId, request);
    if (!result.ok) return descriptor(record);
    record.state = 'TRIGGERED_LOCKED';
    record.triggerOutboxState = null;
    await input.persistence.save(snapshot);
    return descriptor(record);
  }

  async function recoverInner(): Promise<void> {
    const snapshot = await load();
    const recoverable = Object.values(snapshot.bindings).map((record) => ({
      tabId: record.tabId,
      bindingId: record.bindingId,
      authority: record.authority,
      state: record.state,
      triggerClientRequestId: record.triggerClientRequestId,
      triggerOutboxState: record.triggerOutboxState,
    }));
    // Each replay reloads storage so a successful transition cannot be
    // overwritten by the stale snapshot captured above.
    for (const record of recoverable) {
      if (record.state === 'BOUNDARY_PENDING') {
        await enterInner(record.tabId, {
          kind: 'submission-boundary/enter',
          bindingId: record.bindingId as SubmissionBoundaryEnterMessage['bindingId'],
          authority: record.authority,
        });
      } else if (
        record.state === 'OUTCOME_UNKNOWN' &&
        record.triggerOutboxState === 'TRIGGER_CONFIRMED' &&
        record.triggerClientRequestId
      ) {
        await confirmTriggerInner(record.tabId, {
          kind: 'submission-boundary/trigger-confirmed',
          bindingId: record.bindingId as SubmissionBoundaryTriggerConfirmedMessage['bindingId'],
          authority: record.authority,
          triggerClientRequestId: record.triggerClientRequestId as SubmissionBoundaryTriggerConfirmedMessage['triggerClientRequestId'],
        }, true);
      }
    }
  }

  return Object.freeze({
    arm: (tabId: number, authority: SubmissionAuthority, expiresAtMs: number) =>
      exclusive(() => armInner(tabId, authority, expiresAtMs)),
    enter: (tabId: number, message: SubmissionBoundaryEnterMessage) => exclusive(() => enterInner(tabId, message)),
    observeTrigger: (tabId: number, message: SubmissionBoundaryTriggerObservedMessage) =>
      exclusive(() => observeTriggerInner(tabId, message)),
    confirmTrigger: (tabId: number, message: SubmissionBoundaryTriggerConfirmedMessage) =>
      exclusive(() => confirmTriggerInner(tabId, message)),
    cancelTrigger: (tabId: number, message: SubmissionBoundaryTriggerCancelledMessage) =>
      exclusive(() => cancelTriggerInner(tabId, message)),
    handleMessage: (tabId: number, message: SubmissionBoundaryRuntimeMessage) => {
      switch (message.kind) {
        case 'submission-boundary/enter':
          return exclusive(() => enterInner(tabId, message));
        case 'submission-boundary/trigger-observed':
          return exclusive(() => observeTriggerInner(tabId, message));
        case 'submission-boundary/trigger-confirmed':
          return exclusive(() => confirmTriggerInner(tabId, message));
        case 'submission-boundary/trigger-cancelled':
          return exclusive(() => cancelTriggerInner(tabId, message));
      }
    },
    recover: () => exclusive(recoverInner),
  });
}

function boundRecord(
  snapshot: Snapshot,
  tabId: number,
  bindingId: string,
  authority: SubmissionAuthority,
  nowMs: number,
): StoredBinding | null {
  const record = snapshot.bindings[bindingId];
  return record &&
    Number.isFinite(nowMs) &&
    record.expiresAtMs > nowMs &&
    record.tabId === tabId &&
    sameSubmissionAuthority(record.authority, authority)
    ? record
    : null;
}

function parseSnapshot(value: unknown): Snapshot | null {
  if (
    !exactRecord(value, ['schemaVersion', 'bindings', 'legacyAuthorityBlocks']) ||
    value['schemaVersion'] !== SNAPSHOT_VERSION
  ) {
    return null;
  }
  if (!isRecord(value['bindings']) || !Array.isArray(value['legacyAuthorityBlocks'])) return null;
  const bindings: Record<string, StoredBinding> = {};
  for (const [bindingId, raw] of Object.entries(value['bindings'])) {
    if (!parseStoredBinding(raw, bindingId)) return null;
    bindings[bindingId] = raw;
  }
  const legacyAuthorityBlocks: LegacyAuthorityBlock[] = [];
  for (const raw of value['legacyAuthorityBlocks']) {
    const block = parseLegacyAuthorityBlock(raw);
    if (!block) return null;
    legacyAuthorityBlocks.push(block);
  }
  return { schemaVersion: SNAPSHOT_VERSION, bindings, legacyAuthorityBlocks };
}

function parseStoredBinding(value: unknown, bindingId: string): value is StoredBinding {
  if (!exactRecord(value, [
    'bindingId', 'tabId', 'authority', 'expiresAtMs', 'state', 'boundaryClientRequestId',
    'boundaryId', 'attemptRevision', 'acceptedApplicationRevision',
    'triggerClientRequestId', 'triggerOutboxState',
  ])) return false;
  if (
    value['bindingId'] !== bindingId ||
    !Number.isInteger(value['tabId']) ||
    Number(value['tabId']) < 0 ||
    !Number.isSafeInteger(value['expiresAtMs']) ||
    Number(value['expiresAtMs']) <= 0 ||
    !parseSubmissionAuthority(value['authority']) ||
    !parseUuid(value['bindingId']) ||
    ![
      'ARMED', 'BOUNDARY_PENDING', 'WAIT_FOR_USER_RETRY', 'WAIT_FOR_FINAL_RETRY',
      'OUTCOME_UNKNOWN', 'TRIGGERED_LOCKED',
    ].includes(
      String(value['state']),
    )
  ) return false;
  const boundaryRequestId = uuidOrNull(value['boundaryClientRequestId']);
  const boundaryId = uuidOrNull(value['boundaryId']);
  const attemptRevision = decimalOrNull(value['attemptRevision']);
  const applicationRevision = decimalOrNull(value['acceptedApplicationRevision']);
  const triggerRequestId = uuidOrNull(value['triggerClientRequestId']);
  if (
    boundaryRequestId === false || boundaryId === false || attemptRevision === false ||
    applicationRevision === false || triggerRequestId === false
  ) return false;
  switch (value['state']) {
    case 'ARMED':
      return boundaryRequestId === null && boundaryId === null && attemptRevision === null &&
        applicationRevision === null && triggerRequestId === null && value['triggerOutboxState'] === null;
    case 'BOUNDARY_PENDING':
      return boundaryRequestId !== null && boundaryId === null && attemptRevision === null &&
        applicationRevision === null && triggerRequestId === null && value['triggerOutboxState'] === null;
    case 'WAIT_FOR_USER_RETRY':
      return boundaryRequestId !== null && boundaryId !== null && attemptRevision !== null &&
        applicationRevision !== null && triggerRequestId !== null &&
        value['triggerOutboxState'] === 'READY_FOR_USER_GESTURE';
    case 'WAIT_FOR_FINAL_RETRY':
      return boundaryRequestId !== null && boundaryId !== null && attemptRevision !== null &&
        applicationRevision !== null && triggerRequestId !== null &&
        value['triggerOutboxState'] === 'FINAL_RETRY_PREPARED';
    case 'OUTCOME_UNKNOWN':
      return boundaryRequestId !== null && boundaryId !== null && attemptRevision !== null &&
        applicationRevision !== null && (
          (triggerRequestId === null && value['triggerOutboxState'] === null) ||
          (triggerRequestId !== null && value['triggerOutboxState'] === 'TRIGGER_CONFIRMED')
        );
    case 'TRIGGERED_LOCKED':
      return boundaryRequestId !== null && boundaryId !== null && attemptRevision !== null &&
        applicationRevision !== null && value['triggerOutboxState'] === null;
    default:
      return false;
  }
}

function parseLegacyAuthorityBlock(value: unknown): LegacyAuthorityBlock | null {
  if (!exactRecord(value, ['tabId', 'authority'])) return null;
  const authority = parseSubmissionAuthority(value['authority']);
  if (!Number.isInteger(value['tabId']) || Number(value['tabId']) < 0 || !authority) return null;
  return { tabId: Number(value['tabId']), authority };
}

/**
 * V1 carried no execution deadline. Safe pre-trigger records may be discarded,
 * but OUTCOME_UNKNOWN/TRIGGERED_LOCKED can represent a native action that
 * already escaped the page. Preserve those exact authorities as local blocks;
 * inventing a deadline or silently clearing them would both fail open.
 */
function migrateLegacySnapshot(value: unknown): Snapshot | null {
  if (!exactRecord(value, ['schemaVersion', 'bindings']) || value['schemaVersion'] !== 1) return null;
  if (!isRecord(value['bindings'])) return null;
  const legacyAuthorityBlocks: LegacyAuthorityBlock[] = [];
  for (const [bindingId, raw] of Object.entries(value['bindings'])) {
    if (!parseLegacyStoredBinding(raw, bindingId)) return null;
    if (raw['state'] !== 'OUTCOME_UNKNOWN' && raw['state'] !== 'TRIGGERED_LOCKED') continue;
    legacyAuthorityBlocks.push({
      tabId: Number(raw['tabId']),
      authority: raw['authority'] as SubmissionAuthority,
    });
  }
  return {
    schemaVersion: SNAPSHOT_VERSION,
    bindings: {},
    legacyAuthorityBlocks,
  };
}

function parseLegacyStoredBinding(value: unknown, bindingId: string): value is Record<string, unknown> {
  if (!exactRecord(value, [
    'bindingId', 'tabId', 'authority', 'state', 'boundaryClientRequestId',
    'boundaryId', 'attemptRevision', 'acceptedApplicationRevision',
    'triggerClientRequestId', 'triggerOutboxState',
  ])) return false;
  if (
    value['bindingId'] !== bindingId ||
    !parseUuid(value['bindingId']) ||
    !Number.isInteger(value['tabId']) ||
    Number(value['tabId']) < 0 ||
    !parseSubmissionAuthority(value['authority']) ||
    !['ARMED', 'BOUNDARY_PENDING', 'WAIT_FOR_USER_RETRY', 'OUTCOME_UNKNOWN', 'TRIGGERED_LOCKED']
      .includes(String(value['state']))
  ) return false;
  const boundaryRequestId = uuidOrNull(value['boundaryClientRequestId']);
  const boundaryId = uuidOrNull(value['boundaryId']);
  const attemptRevision = decimalOrNull(value['attemptRevision']);
  const applicationRevision = decimalOrNull(value['acceptedApplicationRevision']);
  const triggerRequestId = uuidOrNull(value['triggerClientRequestId']);
  if (
    boundaryRequestId === false || boundaryId === false || attemptRevision === false ||
    applicationRevision === false || triggerRequestId === false
  ) return false;
  switch (value['state']) {
    case 'ARMED':
      return boundaryRequestId === null && boundaryId === null && attemptRevision === null &&
        applicationRevision === null && triggerRequestId === null && value['triggerOutboxState'] === null;
    case 'BOUNDARY_PENDING':
      return boundaryRequestId !== null && boundaryId === null && attemptRevision === null &&
        applicationRevision === null && triggerRequestId === null && value['triggerOutboxState'] === null;
    case 'WAIT_FOR_USER_RETRY':
      return boundaryRequestId !== null && boundaryId !== null && attemptRevision !== null &&
        applicationRevision !== null && triggerRequestId !== null &&
        value['triggerOutboxState'] === 'READY_FOR_USER_GESTURE';
    case 'OUTCOME_UNKNOWN':
      return boundaryRequestId !== null && boundaryId !== null && attemptRevision !== null &&
        applicationRevision !== null && (
          (triggerRequestId === null && value['triggerOutboxState'] === null) ||
          (triggerRequestId !== null && ['TRIGGER_CHECK_PENDING', 'TRIGGER_CONFIRMED']
            .includes(String(value['triggerOutboxState'])))
        );
    case 'TRIGGERED_LOCKED':
      return boundaryRequestId !== null && boundaryId !== null && attemptRevision !== null &&
        applicationRevision !== null && value['triggerOutboxState'] === null;
    default:
      return false;
  }
}

function uuidOrNull(value: unknown): string | null | false {
  if (value === null) return null;
  return typeof value === 'string' && parseUuid(value) ? value : false;
}

function decimalOrNull(value: unknown): string | null | false {
  if (value === null) return null;
  return typeof value === 'string' && /^[1-9][0-9]*$/.test(value) ? value : false;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function exactRecord(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return isRecord(value) && Object.keys(value).sort().join(',') === [...keys].sort().join(',');
}
