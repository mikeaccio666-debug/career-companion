import { describe, expect, it, vi } from 'vitest';
import type { EnterSubmissionBoundaryResponse, RecordSubmissionEventResponse } from '@edaix/contracts';
import type { SubmissionBoundaryClient } from '../lib/submissionBoundaryClient';
import {
  createSubmissionBoundaryRuntime,
  type SubmissionBoundaryPersistence,
} from '../lib/submissionBoundaryRuntime';
import type { SubmissionAuthority } from '../lib/submissionBoundaryProtocol';
import { createSubmissionGestureGate } from '../lib/submissionGestureGate';

const MISSION_ID = '10000000-0000-4000-8000-000000000001';
const STEP_ID = '10000000-0000-4000-8000-000000000002';
const APPLICATION_ID = '10000000-0000-4000-8000-000000000003';
const BOUNDARY_ID = '10000000-0000-4000-8000-000000000004';
const LEASE_EXPIRES_AT_MS = Date.parse('2099-01-01T00:00:00.000Z');

const AUTHORITY: SubmissionAuthority = {
  missionId: MISSION_ID,
  expectedMissionRevision: '9',
  missionStepId: STEP_ID,
  stepAttempt: 1,
  applicationId: APPLICATION_ID,
  expectedApplicationRevision: '7',
  applicationBundleVersion: '3',
};

const BOUNDARY_RESPONSE = {
  schemaVersion: 1,
  boundary: {
    id: BOUNDARY_ID,
    missionId: MISSION_ID,
    missionRevision: '10',
    missionStepId: STEP_ID,
    stepAttempt: 1,
    applicationId: APPLICATION_ID,
    applicationBundleVersion: '3',
    attemptRevision: '1',
    acceptedAt: '2026-08-23T12:00:00.000Z',
  },
  application: {
    canonicalJobId: '10000000-0000-4000-8000-000000000008',
    canonicalJobStatus: 'OPEN',
    lastVerifiedAt: '2026-08-23T11:58:00.000Z',
    applicationId: APPLICATION_ID,
    applicationBundleVersion: '3',
    applicationRevision: '8',
    submissionState: 'TRIGGERING_RISK',
  },
} as unknown as EnterSubmissionBoundaryResponse;

const TRIGGER_RESPONSE = {
  schemaVersion: 1,
  event: {
    id: '10000000-0000-4000-8000-000000000012',
    eventType: 'SUBMISSION_TRIGGERED',
    applicationId: APPLICATION_ID,
    applicationBundleVersion: '3',
    applicationRevision: '9',
    recordedAt: '2026-08-23T12:00:01.000Z',
  },
  application: {
    ...BOUNDARY_RESPONSE.application,
    applicationRevision: '9',
    submissionState: 'TRIGGERED_LOCKED',
  },
} as unknown as RecordSubmissionEventResponse;

function memoryPersistence(): SubmissionBoundaryPersistence & { raw: unknown } {
  return {
    raw: undefined,
    async load() {
      return this.raw;
    },
    async save(value) {
      this.raw = structuredClone(value);
    },
  };
}

function ids() {
  const values = [
    '10000000-0000-4000-8000-000000000010',
    '10000000-0000-4000-8000-000000000011',
    '10000000-0000-4000-8000-000000000012',
    '10000000-0000-4000-8000-000000000013',
  ];
  return () => values.shift()!;
}

function client(input?: {
  boundaryFails?: boolean;
  triggerFails?: boolean;
  boundaryResponse?: EnterSubmissionBoundaryResponse;
  boundaryCreated?: boolean;
}) {
  const enterBoundary = vi.fn(async (_missionId: string, _request: Record<string, unknown>) =>
    input?.boundaryFails
      ? ({ ok: false, code: 'BOUNDARY_HTTP_FAILED' } as const)
      : ({
          ok: true,
          created: input?.boundaryCreated ?? true,
          value: input?.boundaryResponse ?? BOUNDARY_RESPONSE,
        } as const),
  );
  const recordTriggered = vi.fn(async (_missionId: string, request: { clientRequestId: string }) =>
    input?.triggerFails
      ? ({ ok: false, code: 'BOUNDARY_HTTP_FAILED' } as const)
      : ({
          ok: true,
          created: true,
          value: {
            ...TRIGGER_RESPONSE,
            event: { ...TRIGGER_RESPONSE.event, id: request.clientRequestId },
          },
        } as const),
  );
  return {
    value: { enterBoundary, recordTriggered, recordUserReported: vi.fn() } as unknown as SubmissionBoundaryClient,
    enterBoundary,
    recordTriggered,
  };
}

describe('T11 durable submission boundary runtime', () => {
  it('persists the exact pending boundary before network and only then exposes WAIT_FOR_USER_RETRY', async () => {
    const persistence = memoryPersistence();
    const h = client();
    const runtime = createSubmissionBoundaryRuntime({
      client: h.value,
      persistence,
      newUuid: ids(),
    });
    const armed = await runtime.arm(7, AUTHORITY, LEASE_EXPIRES_AT_MS);
    const result = await runtime.enter(7, {
      kind: 'submission-boundary/enter',
      bindingId: armed.bindingId,
      authority: AUTHORITY,
    });

    if (result.mode !== 'ACTIVE') throw new Error('expected active binding');
    expect(result.state).toBe('WAIT_FOR_USER_RETRY');
    expect(result).toHaveProperty('triggerClientRequestId');
    expect(h.enterBoundary).toHaveBeenCalledWith(MISSION_ID, expect.objectContaining({
      clientRequestId: '10000000-0000-4000-8000-000000000011',
      missionStepId: STEP_ID,
      applicationId: APPLICATION_ID,
      applicationBundleVersion: '3',
    }));
    expect(JSON.stringify(persistence.raw)).not.toMatch(
      /confirmation|screenshot|providerEvidence|metadata|pageUrl|html|resumeText|jobDescription/i,
    );
  });

  it('recovers a response-lost boundary after an MV3 service-worker restart with the same id', async () => {
    const persistence = memoryPersistence();
    const failed = client({ boundaryFails: true });
    const first = createSubmissionBoundaryRuntime({
      client: failed.value,
      persistence,
      newUuid: ids(),
    });
    const armed = await first.arm(7, AUTHORITY, LEASE_EXPIRES_AT_MS);
    const blocked = await first.enter(7, {
      kind: 'submission-boundary/enter',
      bindingId: armed.bindingId,
      authority: AUTHORITY,
    });
    if (blocked.mode !== 'ACTIVE') throw new Error('expected active binding');
    expect(blocked.state).toBe('BOUNDARY_PENDING');

    const healthy = client();
    const restarted = createSubmissionBoundaryRuntime({
      client: healthy.value,
      persistence,
      newUuid: ids(),
    });
    await restarted.recover();
    const restored = await restarted.arm(7, AUTHORITY, LEASE_EXPIRES_AT_MS);

    expect(restored.state).toBe('WAIT_FOR_USER_RETRY');
    expect(healthy.enterBoundary).toHaveBeenCalledTimes(1);
    expect(healthy.enterBoundary.mock.calls[0]?.[1]).toMatchObject(
      failed.enterBoundary.mock.calls[0]?.[1] as object,
    );
  });

  it.each([
    ['TRIGGERING_RISK', '8', 'WAIT_FOR_USER_RETRY'],
    ['OUTCOME_UNKNOWN', '9', 'OUTCOME_UNKNOWN'],
    ['TRIGGERED_LOCKED', '9', 'TRIGGERED_LOCKED'],
    ['TRIGGERED_LOCKED', '100000000000000000000', 'TRIGGERED_LOCKED'],
  ] as const)(
    'maps a 200 live %s revision %s replay to %s',
    async (submissionState, applicationRevision, expectedState) => {
      const persistence = memoryPersistence();
      const boundaryResponse = {
        ...BOUNDARY_RESPONSE,
        application: {
          ...BOUNDARY_RESPONSE.application,
          applicationRevision,
          submissionState,
        },
      } as unknown as EnterSubmissionBoundaryResponse;
      const h = client({ boundaryResponse, boundaryCreated: false });
      const runtime = createSubmissionBoundaryRuntime({
        client: h.value,
        persistence,
        newUuid: ids(),
      });
      const armed = await runtime.arm(7, AUTHORITY, LEASE_EXPIRES_AT_MS);
      const result = await runtime.enter(7, {
        kind: 'submission-boundary/enter',
        bindingId: armed.bindingId,
        authority: AUTHORITY,
      });

      expect(result).toMatchObject({ mode: 'ACTIVE', state: expectedState });
      if (expectedState === 'WAIT_FOR_USER_RETRY') {
        expect(result).toHaveProperty('triggerClientRequestId');
      } else {
        expect(result).not.toHaveProperty('triggerClientRequestId');
        expect(JSON.stringify(persistence.raw)).not.toMatch(
          /READY_FOR_USER_GESTURE|TRIGGER_CONFIRMED|FINAL_RETRY_PREPARED/,
        );
        const restarted = createSubmissionBoundaryRuntime({
          client: h.value,
          persistence,
          newUuid: ids(),
        });
        await restarted.recover();
        expect((await restarted.arm(7, AUTHORITY, LEASE_EXPIRES_AT_MS)).state).toBe(expectedState);
      }
    },
  );

  it('keeps a replayed OUTCOME_UNKNOWN monotonic without forging a trigger outbox', async () => {
    const persistence = memoryPersistence();
    const boundaryResponse = {
      ...BOUNDARY_RESPONSE,
      application: {
        ...BOUNDARY_RESPONSE.application,
        applicationRevision: '9',
        submissionState: 'OUTCOME_UNKNOWN',
      },
    } as unknown as EnterSubmissionBoundaryResponse;
    const h = client({ boundaryResponse, boundaryCreated: false });
    const runtime = createSubmissionBoundaryRuntime({
      client: h.value,
      persistence,
      newUuid: ids(),
    });
    const armed = await runtime.arm(7, AUTHORITY, LEASE_EXPIRES_AT_MS);
    const unknown = await runtime.enter(7, {
      kind: 'submission-boundary/enter',
      bindingId: armed.bindingId,
      authority: AUTHORITY,
    });
    if (unknown.mode !== 'ACTIVE') throw new Error('expected active binding');
    expect(unknown.state).toBe('OUTCOME_UNKNOWN');
    expect(JSON.stringify(persistence.raw)).not.toMatch(
      /READY_FOR_USER_GESTURE|TRIGGER_CONFIRMED|FINAL_RETRY_PREPARED/,
    );

    await expect(runtime.confirmTrigger(7, {
      kind: 'submission-boundary/trigger-confirmed',
      bindingId: unknown.bindingId,
      authority: AUTHORITY,
      triggerClientRequestId: '10000000-0000-4000-8000-000000000012',
    })).resolves.toEqual({ mode: 'BLOCKED' });
    expect(h.recordTriggered).not.toHaveBeenCalled();

    const restarted = createSubmissionBoundaryRuntime({
      client: h.value,
      persistence,
      newUuid: ids(),
    });
    await restarted.recover();
    expect((await restarted.arm(7, AUTHORITY, LEASE_EXPIRES_AT_MS)).state).toBe('OUTCOME_UNKNOWN');
    expect(h.recordTriggered).not.toHaveBeenCalled();
  });

  it('persists a known-blocked preparation without POST and only a later native retry confirms', async () => {
    const persistence = memoryPersistence();
    const h = client();
    const runtime = createSubmissionBoundaryRuntime({ client: h.value, persistence, newUuid: ids() });
    const armed = await runtime.arm(7, AUTHORITY, LEASE_EXPIRES_AT_MS);
    const waiting = await runtime.enter(7, {
      kind: 'submission-boundary/enter',
      bindingId: armed.bindingId,
      authority: AUTHORITY,
    });
    if (waiting.mode !== 'ACTIVE' || waiting.state !== 'WAIT_FOR_USER_RETRY') throw new Error('expected waiting');

    const prepared = await runtime.observeTrigger(7, {
      kind: 'submission-boundary/trigger-observed',
      bindingId: waiting.bindingId,
      authority: AUTHORITY,
      triggerClientRequestId: waiting.triggerClientRequestId,
    });
    if (prepared.mode !== 'ACTIVE') throw new Error('expected active binding');
    expect(prepared.state).toBe('WAIT_FOR_FINAL_RETRY');
    expect(JSON.stringify(persistence.raw)).toContain('FINAL_RETRY_PREPARED');
    expect(h.recordTriggered).not.toHaveBeenCalled();

    const restarted = createSubmissionBoundaryRuntime({ client: h.value, persistence, newUuid: ids() });
    await restarted.recover();
    expect(h.recordTriggered).not.toHaveBeenCalled();

    const restored = await restarted.confirmTrigger(7, {
      kind: 'submission-boundary/trigger-confirmed',
      bindingId: waiting.bindingId,
      authority: AUTHORITY,
      triggerClientRequestId: waiting.triggerClientRequestId,
    });
    if (restored.mode !== 'ACTIVE') throw new Error('expected active binding');
    expect(restored.state).toBe('TRIGGERED_LOCKED');
    expect(h.recordTriggered).toHaveBeenCalledTimes(1);
    expect(h.recordTriggered.mock.calls[0]?.[1]).toMatchObject({
      clientRequestId: waiting.triggerClientRequestId,
      boundaryId: BOUNDARY_ID,
      attemptRevision: '1',
      expectedApplicationRevision: '8',
    });
  });

  it('turns a prepared retry into outcome-unknown when a new content generation arms it', async () => {
    const persistence = memoryPersistence();
    const h = client();
    const runtime = createSubmissionBoundaryRuntime({ client: h.value, persistence, newUuid: ids() });
    const armed = await runtime.arm(7, AUTHORITY, LEASE_EXPIRES_AT_MS);
    const waiting = await runtime.enter(7, {
      kind: 'submission-boundary/enter', bindingId: armed.bindingId, authority: AUTHORITY,
    });
    if (waiting.mode !== 'ACTIVE' || waiting.state !== 'WAIT_FOR_USER_RETRY') throw new Error('expected waiting');
    await runtime.observeTrigger(7, {
      kind: 'submission-boundary/trigger-observed', bindingId: waiting.bindingId,
      authority: AUTHORITY, triggerClientRequestId: waiting.triggerClientRequestId,
    });

    const restarted = createSubmissionBoundaryRuntime({ client: h.value, persistence, newUuid: ids() });
    const recovered = await restarted.arm(7, AUTHORITY, LEASE_EXPIRES_AT_MS);

    expect(recovered.state).toBe('OUTCOME_UNKNOWN');
    expect(JSON.stringify(persistence.raw)).toContain('OUTCOME_UNKNOWN');
    expect(JSON.stringify(persistence.raw)).not.toContain('FINAL_RETRY_PREPARED');
    expect(h.recordTriggered).not.toHaveBeenCalled();
  });

  it('idempotently cancels a prepared retry when the known-blocked local path is invalidated', async () => {
    const persistence = memoryPersistence();
    const h = client();
    const runtime = createSubmissionBoundaryRuntime({ client: h.value, persistence, newUuid: ids() });
    const armed = await runtime.arm(7, AUTHORITY, LEASE_EXPIRES_AT_MS);
    const waiting = await runtime.enter(7, {
      kind: 'submission-boundary/enter', bindingId: armed.bindingId, authority: AUTHORITY,
    });
    if (waiting.mode !== 'ACTIVE' || waiting.state !== 'WAIT_FOR_USER_RETRY') throw new Error('expected waiting');
    await runtime.observeTrigger(7, {
      kind: 'submission-boundary/trigger-observed', bindingId: waiting.bindingId,
      authority: AUTHORITY, triggerClientRequestId: waiting.triggerClientRequestId,
    });

    const message = {
      kind: 'submission-boundary/trigger-cancelled' as const,
      bindingId: waiting.bindingId,
      authority: AUTHORITY,
      triggerClientRequestId: waiting.triggerClientRequestId,
    };
    const cancelled = await runtime.cancelTrigger(7, message);
    const repeated = await runtime.cancelTrigger(7, message);

    expect(cancelled).toMatchObject({ mode: 'ACTIVE', state: 'WAIT_FOR_USER_RETRY' });
    expect(repeated).toMatchObject({ mode: 'ACTIVE', state: 'WAIT_FOR_USER_RETRY' });
    expect(JSON.stringify(persistence.raw)).toContain('READY_FOR_USER_GESTURE');
    expect(JSON.stringify(persistence.raw)).not.toMatch(/FINAL_RETRY_PREPARED|OUTCOME_UNKNOWN/);
    expect(h.recordTriggered).not.toHaveBeenCalled();
  });

  it('migrates a risky V1 snapshot to a durable local block instead of failing open or bricking parsing', async () => {
    const persistence = memoryPersistence();
    persistence.raw = {
      schemaVersion: 1,
      bindings: {
        '10000000-0000-4000-8000-000000000010': {
          bindingId: '10000000-0000-4000-8000-000000000010',
          tabId: 7,
          authority: AUTHORITY,
          state: 'OUTCOME_UNKNOWN',
          boundaryClientRequestId: '10000000-0000-4000-8000-000000000011',
          boundaryId: BOUNDARY_ID,
          attemptRevision: '1',
          acceptedApplicationRevision: '8',
          triggerClientRequestId: '10000000-0000-4000-8000-000000000012',
          triggerOutboxState: 'TRIGGER_CHECK_PENDING',
        },
      },
    };
    const h = client();
    const runtime = createSubmissionBoundaryRuntime({ client: h.value, persistence, newUuid: ids() });

    await expect(runtime.arm(7, AUTHORITY, LEASE_EXPIRES_AT_MS))
      .rejects.toThrow('SUBMISSION_BOUNDARY_LEGACY_STATE_UNRESOLVED');
    expect(persistence.raw).toMatchObject({
      schemaVersion: 2,
      bindings: {},
      legacyAuthorityBlocks: [{ tabId: 7, authority: AUTHORITY }],
    });
    expect(h.enterBoundary).not.toHaveBeenCalled();
    expect(h.recordTriggered).not.toHaveBeenCalled();
  });

  it('recovers only a confirmed POST outbox after network loss', async () => {
    const persistence = memoryPersistence();
    const lossy = client({ triggerFails: true });
    const runtime = createSubmissionBoundaryRuntime({ client: lossy.value, persistence, newUuid: ids() });
    const armed = await runtime.arm(7, AUTHORITY, LEASE_EXPIRES_AT_MS);
    const waiting = await runtime.enter(7, {
      kind: 'submission-boundary/enter', bindingId: armed.bindingId, authority: AUTHORITY,
    });
    if (waiting.mode !== 'ACTIVE' || waiting.state !== 'WAIT_FOR_USER_RETRY') throw new Error('expected waiting');
    await runtime.observeTrigger(7, {
      kind: 'submission-boundary/trigger-observed', bindingId: waiting.bindingId,
      authority: AUTHORITY, triggerClientRequestId: waiting.triggerClientRequestId,
    });
    await runtime.confirmTrigger(7, {
      kind: 'submission-boundary/trigger-confirmed', bindingId: waiting.bindingId,
      authority: AUTHORITY, triggerClientRequestId: waiting.triggerClientRequestId,
    });
    expect(JSON.stringify(persistence.raw)).toContain('TRIGGER_CONFIRMED');

    const healthy = client();
    const restarted = createSubmissionBoundaryRuntime({ client: healthy.value, persistence, newUuid: ids() });
    await restarted.recover();
    expect((await restarted.arm(7, AUTHORITY, LEASE_EXPIRES_AT_MS)).state).toBe('TRIGGERED_LOCKED');
    expect(healthy.recordTriggered).toHaveBeenCalledTimes(1);
  });

  it('deduplicates repeated confirmed gestures and never creates a second event id', async () => {
    const persistence = memoryPersistence();
    const h = client();
    const runtime = createSubmissionBoundaryRuntime({ client: h.value, persistence, newUuid: ids() });
    const armed = await runtime.arm(7, AUTHORITY, LEASE_EXPIRES_AT_MS);
    const waiting = await runtime.enter(7, {
      kind: 'submission-boundary/enter', bindingId: armed.bindingId, authority: AUTHORITY,
    });
    if (waiting.mode !== 'ACTIVE' || waiting.state !== 'WAIT_FOR_USER_RETRY') throw new Error('expected waiting');
    const message = {
      kind: 'submission-boundary/trigger-confirmed' as const,
      bindingId: waiting.bindingId,
      authority: AUTHORITY,
      triggerClientRequestId: waiting.triggerClientRequestId,
    };

    await runtime.observeTrigger(7, { ...message, kind: 'submission-boundary/trigger-observed' });
    await Promise.all([runtime.confirmTrigger(7, message), runtime.confirmTrigger(7, message)]);

    expect(h.recordTriggered).toHaveBeenCalledTimes(1);
  });

  it('an accepted exact final click locks even when a SPA later prevents its native default', async () => {
    const persistence = memoryPersistence();
    const h = client();
    const runtime = createSubmissionBoundaryRuntime({ client: h.value, persistence, newUuid: ids() });
    const armed = await runtime.arm(7, AUTHORITY, LEASE_EXPIRES_AT_MS);
    const waiting = await runtime.enter(7, {
      kind: 'submission-boundary/enter', bindingId: armed.bindingId, authority: AUTHORITY,
    });
    if (waiting.mode !== 'ACTIVE' || waiting.state !== 'WAIT_FOR_USER_RETRY') throw new Error('expected waiting');
    const form = Object.freeze({}) as HTMLFormElement;
    const element = Object.freeze({}) as HTMLButtonElement;
    const gate = createSubmissionGestureGate({
      descriptor: waiting,
      target: {
        activation: 'native-submit',
        form,
        element,
        isCurrent: () => true,
      },
      sendMessage: (message) => runtime.handleMessage(7, message),
      isStillAuthorized: () => true,
      captureReviewValueSeal: () => ({ isCurrent: () => true }),
    });
    const shadow = Object.freeze({}) as ShadowRoot;
    const reviewEvent = Object.freeze({
      isTrusted: true,
      composedPath: () => [shadow],
    }) as unknown as Event;
    await expect(gate.confirmFinalReview(reviewEvent, shadow)).resolves.toBe(true);
    const activation = () => ({
      kind: 'activation' as const,
      trusted: true,
      activeUserGesture: true,
      targetMatches: true,
      exactControlMatches: true,
      submitterMatches: false,
      markAuthorityBlocked: () => undefined,
      preventDefault: () => undefined,
      stopImmediatePropagation: () => undefined,
    });
    gate.handle(activation());
    await vi.waitFor(() => expect(gate.state).toBe('WAIT_FOR_FINAL_RETRY'));
    gate.handle(activation());
    await vi.waitFor(() => expect(h.recordTriggered).toHaveBeenCalledTimes(1));
    await runtime.recover();

    expect(h.recordTriggered).toHaveBeenCalledTimes(1);
    expect((await runtime.arm(7, AUTHORITY, LEASE_EXPIRES_AT_MS)).state).toBe('TRIGGERED_LOCKED');
  });

  it('rejects a different tab or drifted Application binding before network I/O', async () => {
    const persistence = memoryPersistence();
    const h = client();
    const runtime = createSubmissionBoundaryRuntime({ client: h.value, persistence, newUuid: ids() });
    const armed = await runtime.arm(7, AUTHORITY, LEASE_EXPIRES_AT_MS);

    await expect(runtime.enter(8, {
      kind: 'submission-boundary/enter', bindingId: armed.bindingId, authority: AUTHORITY,
    })).resolves.toEqual({ mode: 'BLOCKED' });
    await expect(runtime.enter(7, {
      kind: 'submission-boundary/enter',
      bindingId: armed.bindingId,
      authority: { ...AUTHORITY, applicationBundleVersion: '4' },
    })).resolves.toEqual({ mode: 'BLOCKED' });
    expect(h.enterBoundary).not.toHaveBeenCalled();
  });
});
