import { parseUuid } from '../common.ts';
import { parseExecutionRuntimeAuthorizationV1, type ExecutionRuntimeAuthorizationV1 } from '../executionRuntimeAuthorization.ts';

/** The Portal supplies a Mission reference, never its own target, mapping or grant. */
export interface PilotWizardContextSelection {
  readonly kind: 'pilot-ua5/select-wizard-context';
  readonly schemaVersion: 1;
  readonly correlationId: string;
  readonly expectedOwnerId: string;
  readonly missionId: string;
  readonly missionRevision: string;
}

/** Acknowledges only the read-only selection; it is never an execution grant. */
export interface PilotWizardContextSelectionResult {
  readonly kind: 'pilot-ua5/wizard-context-selected';
  readonly schemaVersion: 1;
  readonly correlationId: string;
  readonly ok: boolean;
}

/** Private worker-to-content, selector-free context. No Mission identity is sent to content. */
export interface PilotWizardScanContext {
  readonly schemaVersion: 1;
  readonly scope: 'LOCAL_SESSION';
  readonly sessionId: string;
  readonly requestId: string;
  readonly expiresAtMs: number;
  readonly authorization: ExecutionRuntimeAuthorizationV1 & Readonly<{ purpose: 'DISCOVERY' }>;
}

function record(input: unknown, keys: readonly string[]): Record<string, unknown> | null {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return null;
  const proto = Object.getPrototypeOf(input);
  if (proto !== Object.prototype && proto !== null) return null;
  const properties = Object.getOwnPropertyDescriptors(input), names = Reflect.ownKeys(properties);
  if (names.length !== keys.length || names.some((key) => typeof key !== 'string' || !keys.includes(key))) return null;
  const value: Record<string, unknown> = {};
  for (const key of keys) {
    const property = properties[key];
    if (!property || !('value' in property) || !property.enumerable) return null;
    value[key] = property.value;
  }
  return value;
}

export function parsePilotWizardContextSelection(input: unknown): PilotWizardContextSelection | null {
  try {
    const value = record(input, ['kind', 'schemaVersion', 'correlationId', 'expectedOwnerId', 'missionId', 'missionRevision']);
    if (!value || value.kind !== 'pilot-ua5/select-wizard-context' || value.schemaVersion !== 1 ||
        parseUuid(value.correlationId) === null || parseUuid(value.expectedOwnerId) === null || parseUuid(value.missionId) === null ||
        typeof value.missionRevision !== 'string' || !/^[1-9][0-9]{0,31}$/u.test(value.missionRevision)) return null;
    return Object.freeze(value as unknown as PilotWizardContextSelection);
  } catch { return null; }
}

export function parsePilotWizardScanContext(input: unknown): PilotWizardScanContext | null {
  try {
    const value = record(input, ['schemaVersion', 'scope', 'sessionId', 'requestId', 'expiresAtMs', 'authorization']);
    if (!value || value.schemaVersion !== 1 || value.scope !== 'LOCAL_SESSION' ||
        typeof value.sessionId !== 'string' || !/^[a-f0-9]{32}$/u.test(value.sessionId) ||
        typeof value.requestId !== 'string' || !/^[a-f0-9]{32}$/u.test(value.requestId) ||
        !Number.isSafeInteger(value.expiresAtMs) || Number(value.expiresAtMs) < 1) return null;
    const authorization = parseExecutionRuntimeAuthorizationV1(value.authorization);
    if (authorization?.purpose !== 'DISCOVERY') return null;
    return Object.freeze({ schemaVersion: 1, scope: 'LOCAL_SESSION', sessionId: value.sessionId,
      requestId: value.requestId, expiresAtMs: Number(value.expiresAtMs), authorization: Object.freeze({ ...authorization, purpose: 'DISCOVERY' }) });
  } catch { return null; }
}

export function parsePilotWizardContextSelectionResult(input: unknown): PilotWizardContextSelectionResult | null {
  try {
    const value = record(input, ['kind', 'schemaVersion', 'correlationId', 'ok']);
    if (!value || value.kind !== 'pilot-ua5/wizard-context-selected' || value.schemaVersion !== 1 ||
        parseUuid(value.correlationId) === null || typeof value.ok !== 'boolean') return null;
    return Object.freeze(value as unknown as PilotWizardContextSelectionResult);
  } catch { return null; }
}
