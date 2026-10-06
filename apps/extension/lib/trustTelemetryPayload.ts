import type { ApplyFieldDescriptor, ApplyFormDescriptor } from '@edaix/apply-kernel/contracts';
import type { ReceiptFieldOutcome } from '@edaix/contracts/draft';
import type {
  AutofillExecutionTelemetryDraft,
  FormStructureReportTelemetryDraft,
} from './trustTelemetryClient';

const TRUST_TELEMETRY_VENDORS = new Set(['greenhouse', 'lever', 'ashby', 'workable']);

export function supportsTrustTelemetryVendor(
  vendor: ApplyFormDescriptor['vendor'],
): vendor is AutofillExecutionTelemetryDraft['vendor'] {
  return TRUST_TELEMETRY_VENDORS.has(vendor);
}

export function buildExecutionTelemetryDraft(
  descriptor: ApplyFormDescriptor,
  outcomes: readonly ReceiptFieldOutcome[],
): AutofillExecutionTelemetryDraft | null {
  if (!supportsTrustTelemetryVendor(descriptor.vendor)) return null;
  const counts = countsFor(descriptor, outcomes);
  const failure = outcomes.find((outcome) => !outcome.ok);
  const result = counts.fieldCount === 0
    ? 'FAILED'
    : counts.filledCount === counts.fieldCount
    ? 'SUCCEEDED'
    : counts.filledCount > 0
      ? 'PARTIAL'
      : counts.manualCount > 0
        ? 'USER_ACTION_REQUIRED'
        : 'FAILED';
  return {
    vendor: descriptor.vendor,
    result,
    reasonCode: counts.fieldCount === 0
      ? 'UNKNOWN_SAFE_FAILURE'
      : failure && !failure.ok
        ? mapReason(failure.reason ?? 'UNKNOWN_SAFE_FAILURE')
        : counts.manualCount > 0
          ? 'NO_VALUE'
          : 'NONE',
    counts,
  };
}

export function buildStructureReportDraft(
  descriptor: ApplyFormDescriptor,
  outcomes: readonly ReceiptFieldOutcome[],
  rulePackVersion: string,
  frameDepthBucket: FormStructureReportTelemetryDraft['frameDepthBucket'],
): FormStructureReportTelemetryDraft | null {
  if (!supportsTrustTelemetryVendor(descriptor.vendor)) return null;
  return {
    vendor: descriptor.vendor,
    rulePackVersion,
    frameDepthBucket,
    reasonCode: 'USER_REPORTED',
    counts: countsFor(descriptor, outcomes),
    shapes: aggregateShapes(descriptor.fields),
  };
}

export function frameDepthBucket(win: Window = window): FormStructureReportTelemetryDraft['frameDepthBucket'] {
  if (win === win.top) return 'ZERO';
  return win.parent === win.top ? 'ONE' : 'TWO_PLUS';
}

function countsFor(descriptor: ApplyFormDescriptor, outcomes: readonly ReceiptFieldOutcome[]) {
  const fieldCount = descriptor.fields.length;
  const mappedCount = descriptor.fields.filter((field) => field.key !== null).length;
  const successfulKeys = new Set(outcomes.filter((outcome) => outcome.ok).map((outcome) => outcome.key));
  const filledCount = descriptor.fields.filter((field) => field.key !== null && successfulKeys.has(field.key)).length;
  return {
    fieldCount,
    mappedCount,
    filledCount,
    skippedCount: mappedCount - filledCount,
    manualCount: fieldCount - mappedCount,
  };
}

function aggregateShapes(fields: readonly ApplyFieldDescriptor[]): FormStructureReportTelemetryDraft['shapes'] {
  const counts = new Map<string, FormStructureReportTelemetryDraft['shapes'][number]>();
  for (const field of fields) {
    const shape = projectShape(field);
    const key = `${shape.tag}|${shape.type}|${shape.kind}|${shape.confidenceBucket}`;
    const existing = counts.get(key);
    counts.set(key, existing ? { ...existing, count: existing.count + 1 } : { ...shape, count: 1 });
  }
  const shapes = [...counts.values()];
  if (shapes.length <= 50) return shapes;
  const overflowIdentity = 'OTHER|OTHER|UNSUPPORTED|ZERO';
  const first = shapes.filter((shape) => `${shape.tag}|${shape.type}|${shape.kind}|${shape.confidenceBucket}` !== overflowIdentity).slice(0, 49);
  const retained = new Set(first);
  const overflowCount = shapes.filter((shape) => !retained.has(shape)).reduce((sum, shape) => sum + shape.count, 0);
  return [...first, { tag: 'OTHER', type: 'OTHER', kind: 'UNSUPPORTED', confidenceBucket: 'ZERO', count: overflowCount }];
}

function projectShape(field: ApplyFieldDescriptor): Omit<FormStructureReportTelemetryDraft['shapes'][number], 'count'> {
  const tagName = field.element.tagName.toUpperCase();
  const tag = tagName === 'INPUT' || tagName === 'SELECT' || tagName === 'TEXTAREA' ? tagName : 'OTHER';
  const type = projectType(field.element, tag);
  const kind = field.kind === 'unsupported' ? 'UNSUPPORTED' : field.kind.toUpperCase() as 'TEXT' | 'TEXTAREA' | 'SELECT' | 'COMBOBOX' | 'FILE';
  const confidenceBucket = field.confidence === 0 ? 'ZERO' : field.confidence < 0.7 ? 'LOW' : field.confidence < 0.9 ? 'MEDIUM' : 'HIGH';
  return { tag, type, kind, confidenceBucket };
}

function projectType(element: Element, tag: 'INPUT' | 'SELECT' | 'TEXTAREA' | 'OTHER') {
  if (tag === 'SELECT') return 'SELECT_ONE' as const;
  if (tag === 'TEXTAREA') return 'TEXTAREA' as const;
  if (tag !== 'INPUT') return 'OTHER' as const;
  const value = (element as HTMLInputElement).type.toUpperCase();
  return ['TEXT', 'EMAIL', 'TEL', 'URL', 'NUMBER', 'DATE', 'FILE', 'CHECKBOX', 'RADIO'].includes(value)
    ? value as 'TEXT' | 'EMAIL' | 'TEL' | 'URL' | 'NUMBER' | 'DATE' | 'FILE' | 'CHECKBOX' | 'RADIO'
    : 'OTHER' as const;
}

function mapReason(reason: string): AutofillExecutionTelemetryDraft['reasonCode'] {
  if (reason === 'NO_VALUE') return 'NO_VALUE';
  if (reason === 'NOT_EMPTY') return 'NOT_EMPTY';
  if (reason === 'DETACHED' || reason === 'IDENTITY_CHANGED' || reason === 'HOST_SUBMITTED' || reason === 'PLAN_STALE') return 'PAGE_CHANGED';
  if (reason === 'WRITE_REVERTED' || reason === 'VALUE_COERCED' || reason === 'VERIFY_TIMEOUT' || reason === 'NO_OPTION_MATCH' || reason === 'AMBIGUOUS_OPTION' || reason === 'OPTIONS_INCOMPLETE') return 'VALIDATION_FAILED';
  if (reason === 'ABORTED' || reason === 'GESTURE_EXPIRED') return 'USER_CANCELLED';
  if (reason === 'POLICY_DISABLED' || reason === 'CAPABILITY_DISABLED' || reason === 'LOW_CONFIDENCE' || reason === 'USER_ONLY' || reason === 'HONEYPOT' || reason === 'MANUAL_ONLY') return 'POLICY_BLOCKED';
  return 'UNKNOWN_SAFE_FAILURE';
}
