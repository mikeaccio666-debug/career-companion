import { parseIsoDateTime, parseUuid, type IsoDateTime, type Uuid } from './common.ts';

export const TRUST_TELEMETRY_VENDORS = ['greenhouse', 'lever', 'ashby', 'workable'] as const;
export const TRUST_TELEMETRY_RESULTS = ['SUCCEEDED', 'PARTIAL', 'FAILED', 'USER_ACTION_REQUIRED'] as const;
export const TRUST_TELEMETRY_EXECUTION_REASONS = [
  'NONE', 'NO_VALUE', 'NOT_EMPTY', 'PAGE_CHANGED', 'VALIDATION_FAILED',
  'POLICY_BLOCKED', 'USER_CANCELLED', 'UNKNOWN_SAFE_FAILURE',
] as const;
export const TRUST_TELEMETRY_REPORT_REASONS = [
  'USER_REPORTED', 'LOW_FILL_RATE', 'UNSUPPORTED_CONTROLS', 'PAGE_CHANGED',
  'UNKNOWN_SAFE_FAILURE',
] as const;
export const TRUST_TELEMETRY_FRAME_DEPTH_BUCKETS = ['ZERO', 'ONE', 'TWO_PLUS'] as const;
export const TRUST_TELEMETRY_TAGS = ['INPUT', 'SELECT', 'TEXTAREA', 'OTHER'] as const;
export const TRUST_TELEMETRY_TYPES = [
  'TEXT', 'EMAIL', 'TEL', 'URL', 'NUMBER', 'DATE', 'FILE', 'CHECKBOX', 'RADIO',
  'SELECT_ONE', 'TEXTAREA', 'OTHER',
] as const;
export const TRUST_TELEMETRY_KINDS = ['TEXT', 'TEXTAREA', 'SELECT', 'COMBOBOX', 'FILE', 'UNSUPPORTED'] as const;
export const TRUST_TELEMETRY_CONFIDENCE_BUCKETS = ['ZERO', 'LOW', 'MEDIUM', 'HIGH'] as const;
export const TRUST_TELEMETRY_FORBIDDEN_KEYS = [
  'boardkey', 'fieldkey', 'matchedkey', 'labelhash', 'label', 'value', 'url',
  'hostname', 'origin', 'selector', 'dom', 'html', 'page', 'screenshot', 'resume',
  'jd', 'email', 'token', 'userid', 'installid', 'distinctid', 'properties', 'text',
  'message',
] as const;

export type TrustTelemetryVendor = (typeof TRUST_TELEMETRY_VENDORS)[number];
export type TrustTelemetryResult = (typeof TRUST_TELEMETRY_RESULTS)[number];
export type TrustTelemetryExecutionReason = (typeof TRUST_TELEMETRY_EXECUTION_REASONS)[number];
export type TrustTelemetryReportReason = (typeof TRUST_TELEMETRY_REPORT_REASONS)[number];

export interface TrustTelemetryCountsV1 {
  readonly fieldCount: number;
  readonly mappedCount: number;
  readonly filledCount: number;
  readonly skippedCount: number;
  readonly manualCount: number;
}

export interface AutofillExecutionTelemetryEventV1 {
  readonly schemaVersion: 1;
  readonly eventType: 'AUTOFILL_EXECUTION';
  readonly eventId: Uuid;
  readonly pseudonymousId: Uuid;
  readonly occurredAt: IsoDateTime;
  readonly vendor: TrustTelemetryVendor;
  readonly result: TrustTelemetryResult;
  readonly reasonCode: TrustTelemetryExecutionReason;
  readonly counts: TrustTelemetryCountsV1;
}

export interface FormStructureShapeV1 {
  readonly tag: (typeof TRUST_TELEMETRY_TAGS)[number];
  readonly type: (typeof TRUST_TELEMETRY_TYPES)[number];
  readonly kind: (typeof TRUST_TELEMETRY_KINDS)[number];
  readonly confidenceBucket: (typeof TRUST_TELEMETRY_CONFIDENCE_BUCKETS)[number];
  readonly count: number;
}

export interface FormStructureReportEventV1 {
  readonly schemaVersion: 1;
  readonly eventType: 'FORM_STRUCTURE_REPORT';
  readonly eventId: Uuid;
  readonly pseudonymousId: Uuid;
  readonly occurredAt: IsoDateTime;
  readonly vendor: TrustTelemetryVendor;
  readonly rulePackVersion: string;
  readonly frameDepthBucket: (typeof TRUST_TELEMETRY_FRAME_DEPTH_BUCKETS)[number];
  readonly reasonCode: TrustTelemetryReportReason;
  readonly counts: TrustTelemetryCountsV1;
  readonly shapes: readonly FormStructureShapeV1[];
}

export type TrustTelemetryEventV1 = AutofillExecutionTelemetryEventV1 | FormStructureReportEventV1;
export interface TrustTelemetryDeletionRequestV1 { readonly schemaVersion: 1; readonly pseudonymousId: Uuid }
export interface TrustTelemetryAcceptedResponseV1 { readonly schemaVersion: 1; readonly status: 'ACCEPTED' }

const MAX_EVENT_AGE_MS = 24 * 60 * 60 * 1000;
const MAX_EVENT_FUTURE_SKEW_MS = 5 * 60 * 1000;
const forbidden = new Set<string>(TRUST_TELEMETRY_FORBIDDEN_KEYS);

export function parseTrustTelemetryEvent(value: unknown, nowMs = Date.now()): TrustTelemetryEventV1 | null {
  if (!isRecord(value) || hasForbiddenKey(value)) return null;
  const common = parseCommon(value, nowMs);
  if (!common) return null;
  if (value.eventType === 'AUTOFILL_EXECUTION') {
    if (!exactKeys(value, ['schemaVersion', 'eventType', 'eventId', 'pseudonymousId', 'occurredAt', 'vendor', 'result', 'reasonCode', 'counts'])) return null;
    if (!includes(TRUST_TELEMETRY_RESULTS, value.result) || !includes(TRUST_TELEMETRY_EXECUTION_REASONS, value.reasonCode)) return null;
    return { ...common, eventType: 'AUTOFILL_EXECUTION', result: value.result, reasonCode: value.reasonCode };
  }
  if (value.eventType !== 'FORM_STRUCTURE_REPORT') return null;
  if (!exactKeys(value, ['schemaVersion', 'eventType', 'eventId', 'pseudonymousId', 'occurredAt', 'vendor', 'rulePackVersion', 'frameDepthBucket', 'reasonCode', 'counts', 'shapes'])) return null;
  if (typeof value.rulePackVersion !== 'string' || !/^[A-Za-z0-9._-]{1,64}$/.test(value.rulePackVersion)) return null;
  if (!includes(TRUST_TELEMETRY_FRAME_DEPTH_BUCKETS, value.frameDepthBucket) || !includes(TRUST_TELEMETRY_REPORT_REASONS, value.reasonCode)) return null;
  const shapes = parseShapes(value.shapes, common.counts.fieldCount);
  if (!shapes) return null;
  return {
    ...common,
    eventType: 'FORM_STRUCTURE_REPORT',
    rulePackVersion: value.rulePackVersion,
    frameDepthBucket: value.frameDepthBucket,
    reasonCode: value.reasonCode,
    shapes,
  };
}

export function parseTrustTelemetryDeletionRequest(value: unknown): TrustTelemetryDeletionRequestV1 | null {
  if (!isRecord(value) || hasForbiddenKey(value) || !exactKeys(value, ['schemaVersion', 'pseudonymousId'])) return null;
  const pseudonymousId = parseUuid(value.pseudonymousId);
  return value.schemaVersion === 1 && pseudonymousId ? { schemaVersion: 1, pseudonymousId } : null;
}

function parseCommon(value: Record<string, unknown>, nowMs: number): Omit<AutofillExecutionTelemetryEventV1, 'eventType' | 'result' | 'reasonCode'> | null {
  const eventId = parseUuid(value.eventId);
  const pseudonymousId = parseUuid(value.pseudonymousId);
  const occurredAt = parseIsoDateTime(value.occurredAt);
  if (value.schemaVersion !== 1 || !eventId || !pseudonymousId || !occurredAt || !includes(TRUST_TELEMETRY_VENDORS, value.vendor)) return null;
  const occurredMs = Date.parse(occurredAt);
  if (occurredMs < nowMs - MAX_EVENT_AGE_MS || occurredMs > nowMs + MAX_EVENT_FUTURE_SKEW_MS) return null;
  const counts = parseCounts(value.counts);
  return counts ? { schemaVersion: 1, eventId, pseudonymousId, occurredAt, vendor: value.vendor, counts } : null;
}

function parseCounts(value: unknown): TrustTelemetryCountsV1 | null {
  if (!isRecord(value) || !exactKeys(value, ['fieldCount', 'mappedCount', 'filledCount', 'skippedCount', 'manualCount'])) return null;
  const counts = ['fieldCount', 'mappedCount', 'filledCount', 'skippedCount', 'manualCount'].map((key) => value[key]);
  if (!counts.every((count) => Number.isInteger(count) && (count as number) >= 0 && (count as number) <= 1000)) return null;
  const [fieldCount, mappedCount, filledCount, skippedCount, manualCount] = counts as number[];
  if (mappedCount !== filledCount + skippedCount || fieldCount !== mappedCount + manualCount) return null;
  return { fieldCount, mappedCount, filledCount, skippedCount, manualCount };
}

function parseShapes(value: unknown, expectedCount: number): readonly FormStructureShapeV1[] | null {
  if (!Array.isArray(value) || value.length > 50) return null;
  const seen = new Set<string>();
  let total = 0;
  const shapes: FormStructureShapeV1[] = [];
  for (const item of value) {
    if (!isRecord(item) || !exactKeys(item, ['tag', 'type', 'kind', 'confidenceBucket', 'count'])) return null;
    if (!includes(TRUST_TELEMETRY_TAGS, item.tag) || !includes(TRUST_TELEMETRY_TYPES, item.type) || !includes(TRUST_TELEMETRY_KINDS, item.kind) || !includes(TRUST_TELEMETRY_CONFIDENCE_BUCKETS, item.confidenceBucket)) return null;
    if (!Number.isInteger(item.count) || (item.count as number) < 1 || (item.count as number) > 1000) return null;
    const identity = `${item.tag}|${item.type}|${item.kind}|${item.confidenceBucket}`;
    if (seen.has(identity)) return null;
    seen.add(identity);
    total += item.count as number;
    shapes.push({ tag: item.tag, type: item.type, kind: item.kind, confidenceBucket: item.confidenceBucket, count: item.count as number });
  }
  return total === expectedCount ? shapes : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => Object.prototype.hasOwnProperty.call(value, key));
}

function hasForbiddenKey(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(hasForbiddenKey);
  if (!isRecord(value)) return false;
  return Object.entries(value).some(([key, nested]) => forbidden.has(key.toLowerCase()) || hasForbiddenKey(nested));
}

function includes<const T extends readonly string[]>(values: T, value: unknown): value is T[number] {
  return typeof value === 'string' && (values as readonly string[]).includes(value);
}
