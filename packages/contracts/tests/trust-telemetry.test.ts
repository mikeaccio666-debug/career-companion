import { describe, expect, it } from 'vitest';
import {
  parseTrustTelemetryDeletionRequest,
  parseTrustTelemetryEvent,
  TRUST_TELEMETRY_FORBIDDEN_KEYS,
} from '../src/trustTelemetry.ts';

const NOW = Date.parse('2026-08-23T12:00:00.000Z');
const ID = '123e4567-e89b-42d3-a456-426614174000';
const PSEUDO = '223e4567-e89b-42d3-a456-426614174000';

const execution = () => ({
  schemaVersion: 1,
  eventType: 'AUTOFILL_EXECUTION',
  eventId: ID,
  pseudonymousId: PSEUDO,
  occurredAt: '2026-08-23T11:59:00.000Z',
  vendor: 'greenhouse',
  result: 'PARTIAL',
  reasonCode: 'NO_VALUE',
  counts: { fieldCount: 5, mappedCount: 4, filledCount: 3, skippedCount: 1, manualCount: 1 },
});

describe('trust telemetry hostile-boundary parser', () => {
  it('accepts only the exact execution aggregate and preserves no arbitrary properties', () => {
    expect(parseTrustTelemetryEvent(execution(), NOW)).toEqual(execution());
    expect(parseTrustTelemetryEvent({ ...execution(), boardKey: 'tenant-a' }, NOW)).toBeNull();
    expect(parseTrustTelemetryEvent({ ...execution(), label: 'Email' }, NOW)).toBeNull();
    expect(parseTrustTelemetryEvent({ ...execution(), counts: { ...execution().counts, value: 'secret' } }, NOW)).toBeNull();
  });

  it('rejects impossible counts, stale events, and unknown closed-set values', () => {
    expect(parseTrustTelemetryEvent({ ...execution(), counts: { ...execution().counts, fieldCount: 6 } }, NOW)).toBeNull();
    expect(parseTrustTelemetryEvent({ ...execution(), occurredAt: '2026-08-21T11:59:00.000Z' }, NOW)).toBeNull();
    expect(parseTrustTelemetryEvent({ ...execution(), vendor: 'unknown' }, NOW)).toBeNull();
    expect(parseTrustTelemetryEvent({ ...execution(), reasonCode: 'raw provider message' }, NOW)).toBeNull();
  });

  it('accepts a bounded aggregated structure report and rejects L1-bearing or duplicate shapes', () => {
    const report = {
      schemaVersion: 1,
      eventType: 'FORM_STRUCTURE_REPORT',
      eventId: ID,
      pseudonymousId: PSEUDO,
      occurredAt: '2026-08-23T11:59:00.000Z',
      vendor: 'lever',
      rulePackVersion: '2026.08.23-1',
      frameDepthBucket: 'ZERO',
      reasonCode: 'USER_REPORTED',
      counts: { fieldCount: 2, mappedCount: 1, filledCount: 1, skippedCount: 0, manualCount: 1 },
      shapes: [
        { tag: 'INPUT', type: 'EMAIL', kind: 'TEXT', confidenceBucket: 'HIGH', count: 1 },
        { tag: 'SELECT', type: 'SELECT_ONE', kind: 'UNSUPPORTED', confidenceBucket: 'ZERO', count: 1 },
      ],
    };
    expect(parseTrustTelemetryEvent(report, NOW)).toEqual(report);
    expect(parseTrustTelemetryEvent({ ...report, shapes: [...report.shapes, report.shapes[0]] }, NOW)).toBeNull();
    expect(parseTrustTelemetryEvent({ ...report, shapes: [{ ...report.shapes[0], selector: '#email' }, report.shapes[1]] }, NOW)).toBeNull();
  });

  it('keeps the deletion wire exact and publishes the recursive denylist', () => {
    expect(parseTrustTelemetryDeletionRequest({ schemaVersion: 1, pseudonymousId: PSEUDO })).toEqual({ schemaVersion: 1, pseudonymousId: PSEUDO });
    expect(parseTrustTelemetryDeletionRequest({ schemaVersion: 1, pseudonymousId: PSEUDO, userId: ID })).toBeNull();
    expect(TRUST_TELEMETRY_FORBIDDEN_KEYS).toContain('boardkey');
    expect(TRUST_TELEMETRY_FORBIDDEN_KEYS).toContain('fieldkey');
    expect(TRUST_TELEMETRY_FORBIDDEN_KEYS).toContain('value');
  });
});
