import {
  parseTrustTelemetryEvent,
  parseUuid,
  type AutofillExecutionTelemetryEventV1,
  type FormStructureReportEventV1,
  type TrustTelemetryEventV1,
} from '@edaix/contracts';

export const TRUST_TELEMETRY_DIAGNOSTIC_CODES = [
  'TELEMETRY_BUFFER_DROPPED',
  'TELEMETRY_STORAGE_UNAVAILABLE',
  'TELEMETRY_EVENT_REJECTED',
] as const;

export type TrustTelemetryErrorCode =
  | 'TELEMETRY_STORAGE_UNAVAILABLE'
  | 'TELEMETRY_LOCAL_CLEAR_FAILED'
  | 'TELEMETRY_PROVIDER_DELETE_PENDING';

export class TrustTelemetryClientError extends Error {
  readonly code: TrustTelemetryErrorCode;

  constructor(code: TrustTelemetryErrorCode) {
    super(code);
    this.name = 'TrustTelemetryClientError';
    this.code = code;
  }
}

export function trustTelemetryErrorCode(error: unknown): TrustTelemetryErrorCode | 'TELEMETRY_LOCAL_FAILED' {
  return error instanceof TrustTelemetryClientError ? error.code : 'TELEMETRY_LOCAL_FAILED';
}

export interface TrustTelemetryStore {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown): Promise<void>;
  remove(key: string): Promise<void>;
}

export type TrustTelemetryTransportResult = 'ACCEPTED' | 'RETRY' | 'DISABLED';
export interface TrustTelemetryTransport {
  send(event: TrustTelemetryEventV1): Promise<TrustTelemetryTransportResult>;
  deleteIdentity(pseudonymousId: string): Promise<TrustTelemetryTransportResult>;
}

export type AutofillExecutionTelemetryDraft = Omit<AutofillExecutionTelemetryEventV1, 'schemaVersion' | 'eventType' | 'eventId' | 'pseudonymousId' | 'occurredAt'>;
export type FormStructureReportTelemetryDraft = Omit<FormStructureReportEventV1, 'schemaVersion' | 'eventType' | 'eventId' | 'pseudonymousId' | 'occurredAt'>;

export interface TrustTelemetryClient {
  getConsent(): Promise<boolean>;
  setConsent(enabled: boolean): Promise<void>;
  captureExecution(draft: AutofillExecutionTelemetryDraft): Promise<TrustTelemetryTransportResult>;
  reportStructure(draft: FormStructureReportTelemetryDraft): Promise<{ status: 'ACCEPTED' | 'COPY_AVAILABLE'; event: FormStructureReportEventV1 }>;
  flush(): Promise<void>;
  clear(
    deletionOnlyOverride?: TrustTelemetryTransport['deleteIdentity'],
  ): Promise<void>;
}

export interface TrustTelemetryClientDeps {
  readonly store: TrustTelemetryStore;
  readonly transport: TrustTelemetryTransport;
  readonly now?: () => number;
  readonly uuid?: () => string;
  readonly onDiagnostic?: (code: (typeof TRUST_TELEMETRY_DIAGNOSTIC_CODES)[number]) => void;
  readonly automaticDeliveryEnabled?: boolean;
}

const CONSENT_KEY = 'trustTelemetryConsent';
const IDENTITY_KEY = 'trustTelemetryIdentity';
const BUFFER_KEY = 'trustTelemetryBuffer';
const DELETION_PENDING_KEY = 'trustTelemetryDeletionPending';
const MAX_BUFFER_EVENTS = 100;
const BUFFER_TTL_MS = 24 * 60 * 60 * 1000;
const IDENTITY_TTL_MS = 30 * 24 * 60 * 60 * 1000;

interface StoredIdentity { readonly id: string; readonly createdAtMs: number }
interface BufferedEvent { readonly queuedAtMs: number; readonly event: TrustTelemetryEventV1 }
interface PendingDeletion {
  readonly clearPending: true;
  readonly identityId: string | null;
}

export function createTrustTelemetryClient(deps: TrustTelemetryClientDeps): TrustTelemetryClient {
  const now = deps.now ?? Date.now;
  const uuid = deps.uuid ?? (() => crypto.randomUUID());
  const diag = (code: (typeof TRUST_TELEMETRY_DIAGNOSTIC_CODES)[number]) => deps.onDiagnostic?.(code);
  let automaticDeliveryDenied = false;

  async function get(key: string): Promise<unknown> {
    try { return await deps.store.get(key); } catch {
      diag('TELEMETRY_STORAGE_UNAVAILABLE');
      throw new TrustTelemetryClientError('TELEMETRY_STORAGE_UNAVAILABLE');
    }
  }
  async function set(key: string, value: unknown): Promise<void> {
    try { await deps.store.set(key, value); } catch {
      diag('TELEMETRY_STORAGE_UNAVAILABLE');
      throw new TrustTelemetryClientError('TELEMETRY_STORAGE_UNAVAILABLE');
    }
  }
  async function remove(key: string): Promise<void> {
    try { await deps.store.remove(key); } catch {
      diag('TELEMETRY_STORAGE_UNAVAILABLE');
      throw new TrustTelemetryClientError('TELEMETRY_STORAGE_UNAVAILABLE');
    }
  }

  async function readPendingDeletion(): Promise<PendingDeletion | null> {
    const value = await get(DELETION_PENDING_KEY);
    if (typeof value !== 'object' || value === null) return null;
    const record = value as Record<string, unknown>;
    const identityId = parseUuid(record.identityId);
    if (identityId) return { clearPending: true, identityId };
    return record.clearPending === true && record.identityId === null
      ? { clearPending: true, identityId: null }
      : null;
  }

  async function readIdentity(): Promise<StoredIdentity | null> {
    const value = await get(IDENTITY_KEY);
    if (typeof value !== 'object' || value === null) return null;
    const record = value as Record<string, unknown>;
    const id = parseUuid(record.id);
    return id && Number.isSafeInteger(record.createdAtMs) && (record.createdAtMs as number) >= 0
      ? { id, createdAtMs: record.createdAtMs as number }
      : null;
  }

  async function identity(): Promise<string> {
    const current = await readIdentity();
    if (current && now() - current.createdAtMs < IDENTITY_TTL_MS) return current.id;
    if (current) {
      await remove(BUFFER_KEY);
      await remove(IDENTITY_KEY);
    }
    const created: StoredIdentity = { id: uuid(), createdAtMs: now() };
    if (!parseUuid(created.id)) {
      diag('TELEMETRY_EVENT_REJECTED');
      throw new Error('TELEMETRY_UUID_SOURCE_INVALID');
    }
    await set(IDENTITY_KEY, created);
    if (current) await deps.transport.deleteIdentity(current.id);
    return created.id;
  }

  async function readBuffer(): Promise<BufferedEvent[]> {
    const raw = await get(BUFFER_KEY);
    if (!Array.isArray(raw)) return [];
    const cutoff = now() - BUFFER_TTL_MS;
    const valid: BufferedEvent[] = [];
    let dropped = false;
    for (const entry of raw) {
      if (typeof entry !== 'object' || entry === null) { dropped = true; continue; }
      const record = entry as Record<string, unknown>;
      if (!Number.isSafeInteger(record.queuedAtMs) || (record.queuedAtMs as number) < cutoff) { dropped = true; continue; }
      const event = parseTrustTelemetryEvent(record.event, now());
      if (!event) { dropped = true; continue; }
      valid.push({ queuedAtMs: record.queuedAtMs as number, event });
    }
    if (dropped) diag('TELEMETRY_BUFFER_DROPPED');
    if (valid.length !== raw.length) await set(BUFFER_KEY, valid);
    return valid;
  }

  async function enqueue(event: TrustTelemetryEventV1): Promise<void> {
    const buffer = await readBuffer();
    buffer.push({ queuedAtMs: now(), event });
    while (buffer.length > MAX_BUFFER_EVENTS) {
      buffer.shift();
      diag('TELEMETRY_BUFFER_DROPPED');
    }
    await set(BUFFER_KEY, buffer);
  }

  function buildEvent<T extends TrustTelemetryEventV1>(body: unknown): T {
    const parsed = parseTrustTelemetryEvent(body, now());
    if (!parsed) {
      diag('TELEMETRY_EVENT_REJECTED');
      throw new Error('TELEMETRY_EVENT_REJECTED');
    }
    return parsed as T;
  }

  const client: TrustTelemetryClient = {
    async getConsent() {
      if (automaticDeliveryDenied) return false;
      try {
        if (await readPendingDeletion()) {
          automaticDeliveryDenied = true;
          return false;
        }
        return (await get(CONSENT_KEY)) === true;
      } catch { return false; }
    },
    async setConsent(enabled) {
      if (!enabled) { await client.clear(); return; }
      if (await readPendingDeletion()) {
        automaticDeliveryDenied = true;
        throw new TrustTelemetryClientError('TELEMETRY_PROVIDER_DELETE_PENDING');
      }
      await set(CONSENT_KEY, true);
      automaticDeliveryDenied = false;
      try {
        await client.flush();
      } catch (error) {
        automaticDeliveryDenied = true;
        try { await remove(CONSENT_KEY); } catch {
          throw new TrustTelemetryClientError('TELEMETRY_LOCAL_CLEAR_FAILED');
        }
        throw error;
      }
    },
    async captureExecution(draft) {
      if (deps.automaticDeliveryEnabled !== true || automaticDeliveryDenied) return 'DISABLED';
      if (!(await client.getConsent())) return 'DISABLED';
      await client.flush();
      if (automaticDeliveryDenied) return 'DISABLED';
      const event = buildEvent<AutofillExecutionTelemetryEventV1>({
        ...draft,
        schemaVersion: 1,
        eventType: 'AUTOFILL_EXECUTION',
        eventId: uuid(),
        pseudonymousId: await identity(),
        occurredAt: new Date(now()).toISOString(),
      });
      if (automaticDeliveryDenied) return 'DISABLED';
      const result = await deps.transport.send(event);
      if (result !== 'ACCEPTED' && !automaticDeliveryDenied) await enqueue(event);
      return result;
    },
    async reportStructure(draft) {
      const event = buildEvent<FormStructureReportEventV1>({
        ...draft,
        schemaVersion: 1,
        eventType: 'FORM_STRUCTURE_REPORT',
        eventId: uuid(),
        pseudonymousId: await identity(),
        occurredAt: new Date(now()).toISOString(),
      });
      const result = await deps.transport.send(event);
      return { status: result === 'ACCEPTED' ? 'ACCEPTED' : 'COPY_AVAILABLE', event };
    },
    async flush() {
      if (deps.automaticDeliveryEnabled !== true || automaticDeliveryDenied) return;
      if (!(await client.getConsent())) return;
      const buffer = await readBuffer();
      const remaining: BufferedEvent[] = [];
      for (let index = 0; index < buffer.length; index += 1) {
        if (automaticDeliveryDenied) return;
        const entry = buffer[index]!;
        if (await deps.transport.send(entry.event) !== 'ACCEPTED') {
          remaining.push(...buffer.slice(index));
          break;
        }
      }
      if (automaticDeliveryDenied) return;
      await set(BUFFER_KEY, remaining);
    },
    async clear(deletionOnlyOverride) {
      automaticDeliveryDenied = true;
      let localClearFailed = false;
      let current: StoredIdentity | null = null;
      let pending: PendingDeletion | null = null;
      try { current = await readIdentity(); } catch { localClearFailed = true; }
      try { pending = await readPendingDeletion(); } catch { localClearFailed = true; }

      const identityId = pending?.identityId ?? current?.id ?? null;
      let hasRetryableDeletion = false;
      try {
        await set(DELETION_PENDING_KEY, { clearPending: true, identityId });
        hasRetryableDeletion = true;
      } catch {
        localClearFailed = true;
      }

      for (const key of [CONSENT_KEY, BUFFER_KEY]) {
        try { await remove(key); } catch { localClearFailed = true; }
      }
      if (!identityId || hasRetryableDeletion) {
        try { await remove(IDENTITY_KEY); } catch { localClearFailed = true; }
      }

      let providerDeletePending = false;
      if (identityId) {
        let result: TrustTelemetryTransportResult = 'RETRY';
        const deleteIdentity = deletionOnlyOverride ?? deps.transport.deleteIdentity;
        try { result = await deleteIdentity(identityId); } catch { result = 'RETRY'; }
        if (result !== 'ACCEPTED') providerDeletePending = true;
      }

      if (!localClearFailed && !providerDeletePending) {
        try { await remove(DELETION_PENDING_KEY); } catch { localClearFailed = true; }
      }

      if (localClearFailed) throw new TrustTelemetryClientError('TELEMETRY_LOCAL_CLEAR_FAILED');
      if (providerDeletePending) throw new TrustTelemetryClientError('TELEMETRY_PROVIDER_DELETE_PENDING');
    },
  };
  return client;
}

export interface TrustTelemetryHttpTransportDeps {
  readonly apiBase: string;
  readonly getAccessToken: () => Promise<string | null>;
  readonly refreshAccessToken: () => Promise<string | null>;
  readonly getInstallId: () => Promise<string>;
  readonly fetchFn?: typeof fetch;
}

export function createTrustTelemetryHttpTransport(deps: TrustTelemetryHttpTransportDeps): TrustTelemetryTransport {
  const fetchFn = deps.fetchFn ?? fetch;
  async function post(path: string, body: unknown): Promise<TrustTelemetryTransportResult> {
    let token = await deps.getAccessToken();
    if (!token) return 'RETRY';
    const installId = await deps.getInstallId();
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const response = await fetchFn(new URL(path, deps.apiBase).toString(), {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${token}`,
            'x-edaix-extension-install-id': installId,
          },
          body: JSON.stringify(body),
        });
        if (response.status === 401 && attempt === 0) {
          token = await deps.refreshAccessToken();
          if (!token) return 'RETRY';
          continue;
        }
        if (response.status === 202) return 'ACCEPTED';
        if (response.status === 503) {
          const error = await safeJson(response);
          return isErrorCode(error, 'TELEMETRY_DISABLED') ? 'DISABLED' : 'RETRY';
        }
        return 'RETRY';
      } catch {
        return 'RETRY';
      }
    }
    return 'RETRY';
  }
  return {
    send: (event) => post('/api/v1/agent/trust-telemetry/events', event),
    deleteIdentity: (pseudonymousId) => post('/api/v1/agent/trust-telemetry/deletions', { schemaVersion: 1, pseudonymousId }),
  };
}

async function safeJson(response: Response): Promise<unknown> {
  try { return await response.json(); } catch { return null; }
}
function isErrorCode(value: unknown, code: string): boolean {
  return typeof value === 'object' && value !== null && (value as Record<string, unknown>).code === code;
}
