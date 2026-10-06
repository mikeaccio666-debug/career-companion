// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import type { ApplyFormDescriptor } from '@edaix/apply-kernel/contracts';
import { parseTrustTelemetryEvent } from '@edaix/contracts';
import { buildExecutionTelemetryDraft, buildStructureReportDraft } from '../lib/trustTelemetryPayload';

describe('trust telemetry payload projection', () => {
  it('fails closed for a vendor outside the approved telemetry contract', () => {
    const descriptor = { vendor: 'workday', root: {}, fields: [] } as unknown as ApplyFormDescriptor;

    expect(buildExecutionTelemetryDraft(descriptor, [])).toBeNull();
    expect(buildStructureReportDraft(descriptor, [], 'bundled-v1', 'ZERO')).toBeNull();
  });

  it('does not report an empty descriptor as a successful autofill', () => {
    const descriptor = { vendor: 'lever', root: {}, fields: [] } as unknown as ApplyFormDescriptor;

    expect(buildExecutionTelemetryDraft(descriptor, [])).toMatchObject({
      result: 'FAILED',
      reasonCode: 'UNKNOWN_SAFE_FAILURE',
      counts: { fieldCount: 0, filledCount: 0 },
    });
  });

  it('projects live descriptors into bounded shapes without labels, values, keys, URL, or DOM', () => {
    const email = document.createElement('input');
    email.type = 'email';
    email.value = 'data-l1-value-canary@example.test';
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    const descriptor = {
      vendor: 'greenhouse',
      root: {},
      fields: [
        { key: 'email', label: 'Data-L1 label canary', required: true, confidence: 1, signature: { core: 'x', labelHint: 'secret' }, kind: 'text', element: email },
        { key: null, label: 'Sensitive custom question', required: false, confidence: 0, signature: { core: 'y', labelHint: 'secret' }, kind: 'unsupported', unsupportedReason: 'CHOICE_NO_DATA', element: checkbox },
      ],
    } as unknown as ApplyFormDescriptor;
    const outcomes = [{ key: 'email', ok: true }] as const;
    const execution = buildExecutionTelemetryDraft(descriptor, outcomes);
    const report = buildStructureReportDraft(descriptor, outcomes, 'bundled-v1', 'ZERO');
    expect(execution).not.toBeNull();
    expect(report).not.toBeNull();
    if (!execution || !report) throw new Error('approved vendor must produce telemetry drafts');
    const wire = {
      schemaVersion: 1,
      eventType: 'FORM_STRUCTURE_REPORT',
      eventId: '123e4567-e89b-42d3-a456-426614174000',
      pseudonymousId: '223e4567-e89b-42d3-a456-426614174000',
      occurredAt: '2026-08-23T12:00:00.000Z',
      ...report,
    };

    expect(execution.counts).toEqual({ fieldCount: 2, mappedCount: 1, filledCount: 1, skippedCount: 0, manualCount: 1 });
    expect(report.shapes).toEqual([
      { tag: 'INPUT', type: 'EMAIL', kind: 'TEXT', confidenceBucket: 'HIGH', count: 1 },
      { tag: 'INPUT', type: 'CHECKBOX', kind: 'UNSUPPORTED', confidenceBucket: 'ZERO', count: 1 },
    ]);
    expect(parseTrustTelemetryEvent(wire, Date.parse('2026-08-23T12:01:00.000Z'))).toEqual(wire);
    const json = JSON.stringify({ execution, report });
    expect(json).not.toContain('Data-L1 label canary');
    expect(json).not.toContain('data-l1-value-canary');
    expect(json).not.toContain('Sensitive custom question');
    expect(json).not.toContain('labelHint');
    expect(json).not.toContain('fieldKey');
  });
});
