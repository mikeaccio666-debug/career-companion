import { parsePilotUa5ProfileCheck, parsePilotUa5ProfileCurrentnessResponse, type PilotUa5ProfileCurrentnessResponse } from '@edaix/contracts/draft/pilot-ua5-profile-currentness';
import { parsePilotWizardScanContext, type PilotWizardScanContext } from '@edaix/contracts/draft/pilot-wizard-context';
import { parsePilotLocalWizardProjection, type PilotLocalWizardProjection } from '@edaix/contracts/draft/pilot-local-wizard';
/**
 * Internal connected-dev transport for the current-page UA-5 run.
 *
 * The Panel side of this protocol is value-free by construction: it can ask
 * for one run and receive only closed progress counts or the canonical terminal
 * projection, including its selector-free exact page binding. Payload values
 * remain on the private background -> content branch.
 */

import {
  parsePilotUa5CompositionRequest,
  parsePilotUa5RunProjection,
  parsePilotUa5ReadOnlyScan,
  type PilotUa5CompositionRequest,
  type PilotUa5ReadOnlyScan,
} from '@edaix/contracts/draft/pilot-ua5-certification';
import {
  parsePilotUa5ProfilePayloadResponse,
  type PilotUa5ProfilePayloadResponse,
} from '@edaix/contracts/draft/pilot-ua5-profile-payloads';
import {
  parsePilotUa1DiscoveryRequest,
  parsePilotUa1DiscoveryRuntimeResponse,
  type PilotUa1DiscoveryFailure,
  type PilotUa1DiscoveryRequest,
} from './pilotUa1DiscoveryProtocol';
import type { PilotUa1PageBinding } from '@edaix/contracts/draft';
import {
  PILOT_UA5_RUN_FAILURE_CODES,
  type PilotUa5ProgressEvent,
  type PilotUa5RunFailureCode,
  type PilotUa5RunResult,
} from './pilotUa5Orchestrator';

export const PILOT_UA5_CONNECTED_PROTOCOL_VERSION = 2 as const;
export const PILOT_UA5_PANEL_PORT_NAME = 'edaix-pilot-ua5-panel-v2' as const;
export const PILOT_UA5_CONTENT_PORT_NAME = 'edaix-pilot-ua5-content-v2' as const;
export const PILOT_UA5_READINESS_STATUSES = Object.freeze([
  'USER_ACTION_REQUIRED',
  'SITE_ACCESS_REQUIRED',
  'API_UNREACHABLE',
  'AUTH_REQUIRED',
  'PAGE_NOT_REGISTERED',
  'LIVE_WRITE_NOT_AUTHORIZED',
  'PROFILE_UNAVAILABLE',
  'RECOVERY_REQUIRED',
  'READY',
] as const);

export type PilotUa5ReadinessStatus =
  | 'CHECKING'
  | (typeof PILOT_UA5_READINESS_STATUSES)[number];

export interface PilotUa5ConnectedPort {
  readonly name: string;
  readonly sender?: Readonly<{
    readonly id?: string;
    readonly url?: string;
    readonly tab?: Readonly<{ readonly id?: number }>;
  }>;
  postMessage(message: unknown): void;
  readonly onMessage: {
    addListener(listener: (message: unknown) => void): void;
    removeListener?(listener: (message: unknown) => void): void;
  };
  readonly onDisconnect: {
    addListener(listener: () => void): void;
    removeListener?(listener: () => void): void;
  };
  disconnect(): void;
}

// Internal envelope types are inferred from these strict parsers. Business
// payloads and projections continue to use the executable contracts package.
/** Content-local authorization retained only until the immediately following setter. */
export type PilotUa5LeafWriteAuthorization = false | Readonly<{
  allowed: true;
  writeNotAfterMs: number;
}>;

const REQUEST_ID = /^[0-9a-f]{32}$/u;
const QUESTION_ID = /^[A-Za-z0-9._:-]{1,128}$/u;
const FAILURE_CODES = new Set<string>(PILOT_UA5_RUN_FAILURE_CODES);
const READINESS_STATUSES = new Set<string>(PILOT_UA5_READINESS_STATUSES);

function ownDataSnapshot(value: unknown): Readonly<Record<string, unknown>> | null {
  try {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return null;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const result: Record<string, unknown> = Object.create(null);
    for (const key of Reflect.ownKeys(descriptors)) {
      if (typeof key !== 'string') return null;
      const descriptor = descriptors[key];
      if (!descriptor?.enumerable || !('value' in descriptor)) return null;
      result[key] = descriptor.value;
    }
    return Object.freeze(result);
  } catch {
    return null;
  }
}

function exactKeys(
  fields: Readonly<Record<string, unknown>> | null,
  expectedKeys: readonly string[],
): Readonly<Record<string, unknown>> | null {
  if (fields === null) return null;
  const keys = Object.keys(fields);
  return keys.length === expectedKeys.length && keys.every((key) => expectedKeys.includes(key))
    ? fields : null;
}

export function ownDataValues(value: unknown, keys: readonly string[]): Readonly<Record<string, unknown>> | null {
  return exactKeys(ownDataSnapshot(value), keys);
}

function requestFields(value: unknown, kind: string, keys: readonly string[]) {
  const fields = ownDataValues(value, ['kind', 'version', 'requestId', ...keys]);
  return fields?.kind === kind && fields.version === PILOT_UA5_CONNECTED_PROTOCOL_VERSION &&
    validRequestId(fields.requestId) ? fields as Readonly<Record<string, unknown>> & { requestId: string } : null;
}

function validRequestId(value: unknown): value is string {
  return typeof value === 'string' && REQUEST_ID.test(value);
}

function parsePageBinding(value: unknown): PilotUa1PageBinding | null {
  const fields = ownDataValues(value, ['origin', 'pathname', 'domGeneration']);
  if (fields === null) return null;
  const origin = parseExactHttpsOrigin(fields.origin);
  if (origin === null) return null;
  const pathname = parseExactPathname(fields.pathname, origin);
  if (
    pathname === null ||
    typeof fields.domGeneration !== 'string' ||
    !/^[a-f0-9]{64}$/u.test(fields.domGeneration)
  ) return null;
  return Object.freeze({ origin, pathname, domGeneration: fields.domGeneration });
}

function parseExactHttpsOrigin(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0 || value.length > 256) return null;
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'https:' &&
      parsed.username === '' &&
      parsed.password === '' &&
      parsed.pathname === '/' &&
      parsed.search === '' &&
      parsed.hash === '' &&
      parsed.origin === value
      ? value
      : null;
  } catch {
    return null;
  }
}

function parseExactPathname(value: unknown, origin: string): string | null {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 2_048 ||
    value !== value.trim() ||
    !value.startsWith('/') ||
    value.startsWith('//') ||
    value.includes('\\') ||
    value.includes('?') ||
    value.includes('#') ||
    /[\u0000-\u001F\u007F]/u.test(value) ||
    /%(?![0-9A-F]{2})/iu.test(value) ||
    /%(?:2E|2F|5C|25|00)/iu.test(value)
  ) return null;
  try {
    const parsed = new URL(value, origin);
    return parsed.origin === origin &&
      parsed.pathname === value &&
      parsed.search === '' &&
      parsed.hash === ''
      ? value
      : null;
  } catch {
    return null;
  }
}

export function parsePilotUa5ConnectedPageReady(
  value: unknown,
) {
  const fields = ownDataValues(value, ['kind', 'version', 'origin', 'pathname']);
  if (
    fields?.kind !== 'pilot-ua5/page-ready' ||
    fields.version !== PILOT_UA5_CONNECTED_PROTOCOL_VERSION
  ) return null;
  const origin = parseExactHttpsOrigin(fields.origin);
  if (origin === null) return null;
  const pathname = parseExactPathname(fields.pathname, origin);
  return pathname === null ? null : Object.freeze({
    kind: 'pilot-ua5/page-ready',
    version: PILOT_UA5_CONNECTED_PROTOCOL_VERSION,
    origin,
    pathname,
  });
}

export function createPilotUa5ConnectedPageReady(
  origin: string,
  pathname: string,
) {
  return parsePilotUa5ConnectedPageReady({
    kind: 'pilot-ua5/page-ready',
    version: PILOT_UA5_CONNECTED_PROTOCOL_VERSION,
    origin,
    pathname,
  });
}

export function parsePilotUa5ProgressEvent(value: unknown): PilotUa5ProgressEvent | null {
  const snapshot = ownDataSnapshot(value);
  const observed = exactKeys(snapshot, ['phase', 'observedControls']);
  if (
    observed?.phase === 'OBSERVED' &&
    Number.isSafeInteger(observed.observedControls) &&
    Number(observed.observedControls) >= 0 &&
    Number(observed.observedControls) <= 500
  ) {
    return Object.freeze({
      phase: 'OBSERVED',
      observedControls: Number(observed.observedControls),
    });
  }

  const composed = exactKeys(snapshot, [
    'phase', 'observableQuestions', 'authorizedQuestions',
  ]);
  if (
    composed?.phase === 'COMPOSED' &&
    Number.isSafeInteger(composed.observableQuestions) &&
    Number.isSafeInteger(composed.authorizedQuestions) &&
    Number(composed.observableQuestions) >= 0 &&
    Number(composed.observableQuestions) <= 500 &&
    Number(composed.authorizedQuestions) >= 0 &&
    Number(composed.authorizedQuestions) <= Number(composed.observableQuestions)
  ) {
    return Object.freeze({
      phase: 'COMPOSED',
      observableQuestions: Number(composed.observableQuestions),
      authorizedQuestions: Number(composed.authorizedQuestions),
    });
  }

  const settled = exactKeys(snapshot, [
    'phase', 'requiredCompleted', 'requiredQuestions',
  ]);
  if (
    settled?.phase === 'SETTLED' &&
    Number.isSafeInteger(settled.requiredCompleted) &&
    Number.isSafeInteger(settled.requiredQuestions) &&
    Number(settled.requiredCompleted) >= 0 &&
    Number(settled.requiredQuestions) >= 0 &&
    Number(settled.requiredQuestions) <= 500 &&
    Number(settled.requiredCompleted) <= Number(settled.requiredQuestions)
  ) {
    return Object.freeze({
      phase: 'SETTLED',
      requiredCompleted: Number(settled.requiredCompleted),
      requiredQuestions: Number(settled.requiredQuestions),
    });
  }
  return null;
}

export function parsePilotUa5RunResult(value: unknown): PilotUa5RunResult | null {
  const success = ownDataValues(value, ['ok', 'projection']);
  if (success?.ok === true) {
    const parsed = parsePilotUa5RunProjection(success.projection);
    return parsed.ok
      ? Object.freeze({ ok: true, projection: parsed.value })
      : null;
  }
  const failure = ownDataValues(value, ['ok', 'code']);
  if (
    failure?.ok !== false ||
    typeof failure.code !== 'string' ||
    !FAILURE_CODES.has(failure.code)
  ) return null;
  return Object.freeze({ ok: false, code: failure.code as PilotUa5RunFailureCode });
}

export function parsePilotUa5PanelRequest(value: unknown) {
  return parseRequestSignal(value, 'pilot-ua5/start-current-page');
}

export function createPilotUa5PanelRequest(requestId: string) {
  return parsePilotUa5PanelRequest({
    kind: 'pilot-ua5/start-current-page',
    version: PILOT_UA5_CONNECTED_PROTOCOL_VERSION,
    requestId,
  });
}

// Independent read-only messages leave every existing v2 run/authorization
// parser unchanged. An older peer rejects them; it cannot downgrade to a run.
export type PilotUa5ReadOnlyScanResult =
  | Readonly<{ ok: true; scan: PilotUa5ReadOnlyScan; wizard?: PilotLocalWizardProjection }>
  | PilotUa1DiscoveryFailure;

export function parsePilotUa5ReadOnlyScanResult(value: unknown): PilotUa5ReadOnlyScanResult | null {
  const fields = ownDataSnapshot(value);
  if (fields?.ok === false) {
    const failed = parsePilotUa1DiscoveryRuntimeResponse(fields);
    return failed?.ok === false ? failed : null;
  }
  const withWizard = exactKeys(fields, ['ok', 'scan', 'wizard']);
  const success = exactKeys(fields, ['ok', 'scan']) ?? withWizard;
  if (success?.ok !== true) return null;
  const parsed = parsePilotUa5ReadOnlyScan(success.scan);
  if (!parsed.ok) return null;
  const wizard = withWizard ? parsePilotLocalWizardProjection(withWizard.wizard) : null;
  if (withWizard && !wizard?.ok) return null;
  return Object.freeze({ ok: true, scan: parsed.value, ...(wizard?.ok ? { wizard: wizard.value } : {}) });
}

export function parsePilotUa5ContinueOfferRequest(value: unknown) {
  const fields = requestFields(value, 'pilot-ua5/get-continue-offer', ['runRequestId']);
  return fields && validRequestId(fields.runRequestId) ? Object.freeze({
    kind: 'pilot-ua5/get-continue-offer' as const, version: PILOT_UA5_CONNECTED_PROTOCOL_VERSION,
    requestId: fields.requestId, runRequestId: fields.runRequestId,
  }) : null;
}

export function createPilotUa5ContinueOfferRequest(requestId: string, runRequestId: string) {
  return parsePilotUa5ContinueOfferRequest({ kind: 'pilot-ua5/get-continue-offer', version: PILOT_UA5_CONNECTED_PROTOCOL_VERSION, requestId, runRequestId });
}

export function parsePilotUa5ContinueOfferMessage(value: unknown) {
  const fields = requestFields(value, 'pilot-ua5/continue-offer', ['runRequestId', 'offer']);
  if (!fields || !validRequestId(fields.runRequestId)) return null;
  const offer = parsePilotUa5ContinueOffer(fields.offer);
  if (fields.offer !== null && offer === null) return null;
  return Object.freeze({
    kind: 'pilot-ua5/continue-offer' as const, version: PILOT_UA5_CONNECTED_PROTOCOL_VERSION,
    requestId: fields.requestId, runRequestId: fields.runRequestId,
    offer,
  });
}

export type PilotUa5ContinueOffer = NonNullable<NonNullable<ReturnType<typeof parsePilotUa5ContinueOfferMessage>>['offer']>;

export function parsePilotUa5ContinueOffer(value: unknown) {
  const offer = ownDataValues(value, ['intentId', 'expiresAtMs']);
  return offer && validRequestId(offer.intentId) && typeof offer.expiresAtMs === 'number' &&
    Number.isSafeInteger(offer.expiresAtMs) && offer.expiresAtMs > 0
    ? Object.freeze({ intentId: offer.intentId, expiresAtMs: offer.expiresAtMs }) : null;
}

export function pilotUa5ContinueOfferMessage(requestId: string, runRequestId: string, offer: PilotUa5ContinueOffer | null) {
  return parsePilotUa5ContinueOfferMessage({ kind: 'pilot-ua5/continue-offer', version: PILOT_UA5_CONNECTED_PROTOCOL_VERSION, requestId, runRequestId, offer });
}

export function parsePilotUa5ContinueRequest(value: unknown) {
  const fields = requestFields(value, 'pilot-ua5/continue-read-only', ['runRequestId', 'intentId']);
  return fields && validRequestId(fields.runRequestId) && validRequestId(fields.intentId) && fields.requestId !== fields.runRequestId ? Object.freeze({
    kind: 'pilot-ua5/continue-read-only' as const, version: PILOT_UA5_CONNECTED_PROTOCOL_VERSION,
    requestId: fields.requestId, runRequestId: fields.runRequestId, intentId: fields.intentId,
  }) : null;
}

export function createPilotUa5ContinueRequest(requestId: string, runRequestId: string, intentId: string) {
  return parsePilotUa5ContinueRequest({ kind: 'pilot-ua5/continue-read-only', version: PILOT_UA5_CONNECTED_PROTOCOL_VERSION, requestId, runRequestId, intentId });
}

export function parsePilotUa5ContentRescanRequest(value: unknown) {
  const withWizard = requestFields(value, 'pilot-ua5/rescan-wizard-current-page', ['runRequestId', 'discovery', 'wizardContext']);
  const fields = requestFields(value, 'pilot-ua5/rescan-current-page', ['runRequestId', 'discovery']) ?? withWizard;
  if (!fields || !validRequestId(fields.runRequestId) || fields.runRequestId === fields.requestId) return null;
  const discovery = parsePilotUa1DiscoveryRequest(fields.discovery);
  const wizardContext = withWizard ? parsePilotWizardScanContext(withWizard.wizardContext) : null;
  if (withWizard && (!wizardContext || wizardContext.requestId !== fields.requestId)) return null;
  return discovery?.requestId === fields.requestId ? Object.freeze({
    kind: withWizard ? 'pilot-ua5/rescan-wizard-current-page' as const : 'pilot-ua5/rescan-current-page' as const, version: PILOT_UA5_CONNECTED_PROTOCOL_VERSION,
    requestId: fields.requestId, runRequestId: fields.runRequestId, discovery,
    ...(wizardContext ? { wizardContext } : {}),
  }) : null;
}

export function createPilotUa5ContentRescanRequest(requestId: string, runRequestId: string, discovery: PilotUa1DiscoveryRequest, wizardContext?: PilotWizardScanContext) {
  return parsePilotUa5ContentRescanRequest({ kind: wizardContext ? 'pilot-ua5/rescan-wizard-current-page' : 'pilot-ua5/rescan-current-page',
    version: PILOT_UA5_CONNECTED_PROTOCOL_VERSION, requestId, runRequestId, discovery, ...(wizardContext ? { wizardContext } : {}) });
}

export function parsePilotUa5RescanResultMessage(value: unknown) {
  const withWizard = requestFields(value, 'pilot-ua5/wizard-rescan-result', ['runRequestId', 'result']);
  const fields = requestFields(value, 'pilot-ua5/rescan-result', ['runRequestId', 'result']) ?? withWizard;
  if (!fields || !validRequestId(fields.runRequestId)) return null;
  const result = parsePilotUa5ReadOnlyScanResult(fields.result);
  if (result?.ok && (result.wizard !== undefined) !== (withWizard !== null)) return null;
  if (withWizard && !result?.ok) return null;
  return result === null ? null : Object.freeze({
    kind: withWizard ? 'pilot-ua5/wizard-rescan-result' as const : 'pilot-ua5/rescan-result' as const, version: PILOT_UA5_CONNECTED_PROTOCOL_VERSION,
    requestId: fields.requestId, runRequestId: fields.runRequestId, result,
  });
}

export function pilotUa5RescanResultMessage(requestId: string, runRequestId: string, result: PilotUa5ReadOnlyScanResult) {
  return parsePilotUa5RescanResultMessage({ kind: result.ok && result.wizard ? 'pilot-ua5/wizard-rescan-result' : 'pilot-ua5/rescan-result', version: PILOT_UA5_CONNECTED_PROTOCOL_VERSION, requestId, runRequestId, result });
}

export function parsePilotUa5ReadinessRequest(value: unknown) {
  return parseRequestSignal(value, 'pilot-ua5/probe-readiness');
}

export function createPilotUa5ReadinessRequest(
  requestId: string,
) {
  return parsePilotUa5ReadinessRequest({
    kind: 'pilot-ua5/probe-readiness',
    version: PILOT_UA5_CONNECTED_PROTOCOL_VERSION,
    requestId,
  });
}

export function parsePilotUa5ReadinessEvent(
  value: unknown,
) {
  const fields = requestFields(value, 'pilot-ua5/readiness', ['status']);
  if (fields === null ||
    typeof fields.status !== 'string' ||
    !READINESS_STATUSES.has(fields.status)
  ) return null;
  return Object.freeze({
    kind: 'pilot-ua5/readiness',
    version: PILOT_UA5_CONNECTED_PROTOCOL_VERSION,
    requestId: fields.requestId,
    status: fields.status as Exclude<PilotUa5ReadinessStatus, 'CHECKING'>,
  });
}

export function pilotUa5ReadinessMessage(
  requestId: string,
  status: Exclude<PilotUa5ReadinessStatus, 'CHECKING'>,
) {
  return parsePilotUa5ReadinessEvent({
    kind: 'pilot-ua5/readiness',
    version: PILOT_UA5_CONNECTED_PROTOCOL_VERSION,
    requestId,
    status,
  });
}

export function parsePilotUa5ContentRunRequest(
  value: unknown,
) {
  const withWizard = requestFields(value, 'pilot-ua5/run-wizard-exact-page', ['discovery', 'wizardContext']);
  const fields = requestFields(value, 'pilot-ua5/run-exact-page', ['discovery']) ?? withWizard;
  if (fields === null) return null;
  const discovery = parsePilotUa1DiscoveryRequest(fields.discovery);
  if (discovery === null) return null;
  const wizardContext = withWizard ? parsePilotWizardScanContext(withWizard.wizardContext) : null;
  if (withWizard && (!wizardContext || wizardContext.requestId !== fields.requestId || discovery.requestId !== fields.requestId)) return null;
  return Object.freeze({
    kind: withWizard ? 'pilot-ua5/run-wizard-exact-page' as const : 'pilot-ua5/run-exact-page' as const,
    version: PILOT_UA5_CONNECTED_PROTOCOL_VERSION,
    requestId: fields.requestId,
    discovery,
    ...(wizardContext ? { wizardContext } : {}),
  });
}

export function createPilotUa5ContentRunRequest(
  requestId: string,
  discovery: PilotUa1DiscoveryRequest,
  wizardContext?: PilotWizardScanContext,
) {
  return parsePilotUa5ContentRunRequest({
    kind: wizardContext ? 'pilot-ua5/run-wizard-exact-page' : 'pilot-ua5/run-exact-page',
    version: PILOT_UA5_CONNECTED_PROTOCOL_VERSION,
    requestId,
    discovery,
    ...(wizardContext ? { wizardContext } : {}),
  });
}

export function parsePilotUa5WriteCheckRequest(
  value: unknown,
) {
  const fields = requestFields(value, 'pilot-ua5/write-check', ['ordinal', 'binding', 'questionId']);
  if (fields === null || typeof fields.questionId !== 'string' || !QUESTION_ID.test(fields.questionId) ||
    !Number.isSafeInteger(fields.ordinal) ||
    Number(fields.ordinal) < 1 ||
    Number(fields.ordinal) > 500
  ) return null;
  const binding = parsePageBinding(fields.binding);
  return binding === null ? null : Object.freeze({
    kind: 'pilot-ua5/write-check',
    version: PILOT_UA5_CONNECTED_PROTOCOL_VERSION,
    requestId: fields.requestId,
    ordinal: Number(fields.ordinal),
    questionId: fields.questionId,
    binding,
  });
}

export function createPilotUa5WriteCheckRequest(
  requestId: string,
  ordinal: number,
  binding: PilotUa1PageBinding,
  questionId: string,
) {
  return parsePilotUa5WriteCheckRequest({
    kind: 'pilot-ua5/write-check',
    version: PILOT_UA5_CONNECTED_PROTOCOL_VERSION,
    requestId,
    ordinal,
    questionId,
    binding,
  });
}

export function parsePilotUa5WriteCheckResult(
  value: unknown,
) {
  const fields = requestFields(value, 'pilot-ua5/write-check-result', ['ordinal', 'allowed', 'writeNotAfterMs', 'questionId']);
  if (fields === null || typeof fields.questionId !== 'string' || !QUESTION_ID.test(fields.questionId) ||
    !Number.isSafeInteger(fields.ordinal) ||
    Number(fields.ordinal) < 1 ||
    Number(fields.ordinal) > 500 ||
    typeof fields.allowed !== 'boolean' ||
    (fields.allowed === true && (
      !Number.isSafeInteger(fields.writeNotAfterMs) || Number(fields.writeNotAfterMs) <= 0
    )) ||
    (fields.allowed === false && fields.writeNotAfterMs !== null)
  ) return null;
  return Object.freeze({
    kind: 'pilot-ua5/write-check-result',
    version: PILOT_UA5_CONNECTED_PROTOCOL_VERSION,
    requestId: fields.requestId,
    ordinal: Number(fields.ordinal),
    questionId: fields.questionId,
    allowed: fields.allowed,
    writeNotAfterMs: fields.allowed ? Number(fields.writeNotAfterMs) : null,
  });
}

export function pilotUa5WriteCheckResultMessage(
  requestId: string,
  ordinal: number,
  allowed: boolean,
  writeNotAfterMs: number | null,
  questionId: string,
) {
  return parsePilotUa5WriteCheckResult({
    kind: 'pilot-ua5/write-check-result',
    version: PILOT_UA5_CONNECTED_PROTOCOL_VERSION,
    requestId,
    ordinal,
    questionId,
    allowed,
    writeNotAfterMs,
  });
}

function parseRequestSignal<TKind extends string>(
  value: unknown,
  kind: TKind,
) {
  const fields = requestFields(value, kind, []);
  if (fields === null) return null;
  return Object.freeze({
    kind,
    version: PILOT_UA5_CONNECTED_PROTOCOL_VERSION,
    requestId: fields.requestId,
  });
}

export function parsePilotUa5CurrentResultRequest(value: unknown) {
  return parseRequestSignal(value, 'pilot-ua5/get-current-result');
}

export function createPilotUa5CurrentResultRequest(requestId: string) {
  return parsePilotUa5CurrentResultRequest({
    kind: 'pilot-ua5/get-current-result',
    version: PILOT_UA5_CONNECTED_PROTOCOL_VERSION,
    requestId,
  });
}

export function parsePilotUa5UndoRequest(value: unknown) {
  const fields = requestFields(value, 'pilot-ua5/undo-field', ['runRequestId', 'questionId']);
  if (fields === null ||
    !validRequestId(fields.runRequestId) ||
    typeof fields.questionId !== 'string' ||
    !QUESTION_ID.test(fields.questionId)
  ) return null;
  return Object.freeze({
    kind: 'pilot-ua5/undo-field',
    version: PILOT_UA5_CONNECTED_PROTOCOL_VERSION,
    requestId: fields.requestId,
    runRequestId: fields.runRequestId,
    questionId: fields.questionId,
  });
}

export function createPilotUa5UndoRequest(
  requestId: string,
  runRequestId: string,
  questionId: string,
) {
  return parsePilotUa5UndoRequest({
    kind: 'pilot-ua5/undo-field',
    version: PILOT_UA5_CONNECTED_PROTOCOL_VERSION,
    requestId,
    runRequestId,
    questionId,
  });
}

export function parsePilotUa5UndoResult(value: unknown) {
  const fields = requestFields(value, 'pilot-ua5/undo-result', ['runRequestId', 'questionId', 'status']);
  if (fields === null ||
    !validRequestId(fields.runRequestId) ||
    typeof fields.questionId !== 'string' ||
    !QUESTION_ID.test(fields.questionId) ||
    (fields.status !== 'RESTORED' && fields.status !== 'UNAVAILABLE')
  ) return null;
  return Object.freeze({
    kind: 'pilot-ua5/undo-result',
    version: PILOT_UA5_CONNECTED_PROTOCOL_VERSION,
    requestId: fields.requestId,
    runRequestId: fields.runRequestId,
    questionId: fields.questionId,
    status: fields.status,
  });
}

export function pilotUa5UndoResultMessage(
  requestId: string,
  runRequestId: string,
  questionId: string,
  status: 'RESTORED' | 'UNAVAILABLE',
) {
  return parsePilotUa5UndoResult({
    kind: 'pilot-ua5/undo-result',
    version: PILOT_UA5_CONNECTED_PROTOCOL_VERSION,
    requestId,
    runRequestId,
    questionId,
    status,
  });
}

const resultWizards = new WeakMap<PilotUa5RunResult, PilotLocalWizardProjection>();

/** Only exact results parsed from a distinct wizard terminal carry metadata. */
export function readPilotUa5ResultWizard(result: PilotUa5RunResult): PilotLocalWizardProjection | undefined {
  return resultWizards.get(result);
}

export function parsePilotUa5PanelEvent(value: unknown) {
  const progress = ownDataValues(value, ['kind', 'version', 'requestId', 'event']);
  if (
    progress?.kind === 'pilot-ua5/progress' &&
    progress.version === PILOT_UA5_CONNECTED_PROTOCOL_VERSION &&
    validRequestId(progress.requestId)
  ) {
    const event = parsePilotUa5ProgressEvent(progress.event);
    return event === null ? null : Object.freeze({
      kind: 'pilot-ua5/progress',
      version: PILOT_UA5_CONNECTED_PROTOCOL_VERSION,
      requestId: progress.requestId,
      event,
    });
  }
  const withWizard = ownDataValues(value, ['kind', 'version', 'requestId', 'result', 'wizard']);
  const terminal = ownDataValues(value, ['kind', 'version', 'requestId', 'result']) ?? withWizard;
  if (
    terminal?.kind !== (withWizard ? 'pilot-ua5/wizard-result' : 'pilot-ua5/result') ||
    terminal.version !== PILOT_UA5_CONNECTED_PROTOCOL_VERSION ||
    !validRequestId(terminal.requestId)
  ) return null;
  const result = parsePilotUa5RunResult(terminal.result);
  const wizard = withWizard ? parsePilotLocalWizardProjection(withWizard.wizard) : null;
  if (withWizard && (!wizard?.ok || !result?.ok)) return null;
  if (wizard?.ok && result) resultWizards.set(result, wizard.value);
  return result === null ? null : Object.freeze({
    kind: withWizard ? 'pilot-ua5/wizard-result' as const : 'pilot-ua5/result' as const,
    version: PILOT_UA5_CONNECTED_PROTOCOL_VERSION,
    requestId: terminal.requestId,
    result,
    ...(wizard?.ok ? { wizard: wizard.value } : {}),
  });
}

export function pilotUa5ProgressMessage(
  requestId: string,
  event: PilotUa5ProgressEvent,
) {
  return parsePilotUa5PanelEvent({
    kind: 'pilot-ua5/progress',
    version: PILOT_UA5_CONNECTED_PROTOCOL_VERSION,
    requestId,
    event,
  });
}

export function pilotUa5ResultMessage(
  requestId: string,
  result: PilotUa5RunResult,
  wizard?: PilotLocalWizardProjection,
) {
  return parsePilotUa5PanelEvent({
    kind: wizard ? 'pilot-ua5/wizard-result' : 'pilot-ua5/result',
    version: PILOT_UA5_CONNECTED_PROTOCOL_VERSION,
    requestId,
    result,
    ...(wizard ? { wizard } : {}),
  });
}

export function parsePilotUa5ProfilePayloadRequestMessage(
  value: unknown,
) {
  const fields = requestFields(value, 'pilot-ua5/profile-payload-request', ['request']);
  if (fields === null) return null;
  const parsed = parsePilotUa5CompositionRequest(fields.request);
  return parsed.ok ? Object.freeze({
    kind: 'pilot-ua5/profile-payload-request',
    version: PILOT_UA5_CONNECTED_PROTOCOL_VERSION,
    requestId: fields.requestId,
    request: parsed.value,
  }) : null;
}

export function pilotUa5ProfilePayloadRequestMessage(
  requestId: string,
  request: PilotUa5CompositionRequest,
) {
  return parsePilotUa5ProfilePayloadRequestMessage({
    kind: 'pilot-ua5/profile-payload-request',
    version: PILOT_UA5_CONNECTED_PROTOCOL_VERSION,
    requestId,
    request,
  });
}

export function parsePilotUa5ProfilePayloadResultMessage(
  value: unknown,
) {
  const fields = requestFields(value, 'pilot-ua5/profile-payload-result', ['response']);
  if (fields === null) return null;
  const parsed = parsePilotUa5ProfilePayloadResponse(fields.response);
  return parsed.ok ? Object.freeze({
    kind: 'pilot-ua5/profile-payload-result',
    version: PILOT_UA5_CONNECTED_PROTOCOL_VERSION,
    requestId: fields.requestId,
    response: parsed.value,
  }) : null;
}

export function pilotUa5ProfilePayloadResultMessage(
  requestId: string,
  response: PilotUa5ProfilePayloadResponse,
) {
  return parsePilotUa5ProfilePayloadResultMessage({
    kind: 'pilot-ua5/profile-payload-result',
    version: PILOT_UA5_CONNECTED_PROTOCOL_VERSION,
    requestId,
    response,
  });
}

export function pilotUa5ConnectedFailure(
  code: PilotUa5RunFailureCode = 'PILOT_CAPABILITY_DISABLED',
): PilotUa5RunResult {
  return Object.freeze({ ok: false, code });
}

export function isExactExtensionSender(
  sender: PilotUa5ConnectedPort['sender'],
  extensionId: string,
  expectedUrl: string,
): boolean {
  try {
    if (sender === undefined) return false;
    const descriptors = Object.getOwnPropertyDescriptors(sender);
    const keys = Reflect.ownKeys(descriptors);
    if (keys.some((key) => typeof key !== 'string')) return false;
    const id = descriptors.id;
    const url = descriptors.url;
    const tab = descriptors.tab;
    return id !== undefined && 'value' in id && id.value === extensionId &&
      url !== undefined && 'value' in url && url.value === expectedUrl &&
      (tab === undefined || !('value' in tab) || tab.value === undefined);
  } catch {
    return false;
  }
}


export function parsePilotUa5ProfileCheckRequest(value: unknown) {
  const fields = requestFields(value, 'pilot-ua5/profile-check', ['check']);
  if (!fields) return null;
  const check = parsePilotUa5ProfileCheck(fields.check);
  return check && check.runRequestId === fields.requestId ? Object.freeze({
    kind: 'pilot-ua5/profile-check', version: PILOT_UA5_CONNECTED_PROTOCOL_VERSION, requestId: fields.requestId, check,
  }) : null;
}
export function pilotUa5ProfileCheckRequestMessage(check: unknown) {
  const parsed = parsePilotUa5ProfileCheck(check);
  return parsed ? parsePilotUa5ProfileCheckRequest({ kind: 'pilot-ua5/profile-check',
    version: PILOT_UA5_CONNECTED_PROTOCOL_VERSION, requestId: parsed.runRequestId, check: parsed }) : null;
}
export function parsePilotUa5ProfileCheckResult(value: unknown) {
  const fields = requestFields(value, 'pilot-ua5/profile-check-result', ['ordinal', 'result']);
  if (!fields || !Number.isSafeInteger(fields.ordinal) || Number(fields.ordinal) < 1 || Number(fields.ordinal) > 500) return null;
  const result = parsePilotUa5ProfileCurrentnessResponse(fields.result);
  if (!result.ok || (result.value.ok && (result.value.check.runRequestId !== fields.requestId || result.value.check.ordinal !== fields.ordinal))) return null;
  return Object.freeze({ kind: 'pilot-ua5/profile-check-result', version: PILOT_UA5_CONNECTED_PROTOCOL_VERSION,
    requestId: fields.requestId, ordinal: Number(fields.ordinal), result: result.value });
}
export function pilotUa5ProfileCheckResultMessage(requestId: string, ordinal: number, result: PilotUa5ProfileCurrentnessResponse) {
  return parsePilotUa5ProfileCheckResult({ kind: 'pilot-ua5/profile-check-result', version: PILOT_UA5_CONNECTED_PROTOCOL_VERSION,
    requestId, ordinal, result });
}
