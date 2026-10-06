import { describe, expect, it, vi } from 'vitest';
import {
  AGENT_ERROR_DEFINITIONS,
  type EnterSubmissionBoundaryRequest,
  type RecordSubmissionEventRequest,
} from '@edaix/contracts';
import {
  createSubmissionBoundaryClient,
  SubmissionBoundaryCoordinator,
} from '../lib/submissionBoundaryClient';

const MISSION_ID = '10000000-0000-4000-8000-000000000001';
const STEP_ID = '10000000-0000-4000-8000-000000000002';
const APPLICATION_ID = '10000000-0000-4000-8000-000000000003';
const INSTALL_ID = '10000000-0000-4000-8000-000000000004';
const BOUNDARY_ID = '10000000-0000-4000-8000-000000000005';
const EVENT_ID = '10000000-0000-4000-8000-000000000009';
const OTHER_ID = '10000000-0000-4000-8000-000000000099';

const boundaryRequest = {
  clientRequestId: '10000000-0000-4000-8000-000000000007',
  expectedMissionRevision: '9',
  missionStepId: STEP_ID,
  stepAttempt: 1,
  applicationId: APPLICATION_ID,
  expectedApplicationRevision: '7',
  applicationBundleVersion: '3',
} as unknown as Omit<EnterSubmissionBoundaryRequest, 'extensionInstallId'>;

const boundaryBody = {
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
} as const;

const triggeredRequest = {
  clientRequestId: '10000000-0000-4000-8000-000000000009',
  eventType: 'SUBMISSION_TRIGGERED',
  applicationId: APPLICATION_ID,
  expectedApplicationRevision: '8',
  applicationBundleVersion: '3',
  boundaryId: BOUNDARY_ID,
  attemptRevision: '1',
} as unknown as Omit<
  Extract<RecordSubmissionEventRequest, { eventType: 'SUBMISSION_TRIGGERED' }>,
  'extensionInstallId'
>;

const triggeredBody = {
  schemaVersion: 1,
  event: {
    id: EVENT_ID,
    eventType: 'SUBMISSION_TRIGGERED',
    applicationId: APPLICATION_ID,
    applicationBundleVersion: '3',
    applicationRevision: '9',
    recordedAt: '2026-08-23T12:00:01.000Z',
  },
  application: {
    ...boundaryBody.application,
    applicationRevision: '9',
    submissionState: 'TRIGGERED_LOCKED',
  },
} as const;

function boundaryReplayBody(
  submissionState: 'TRIGGERING_RISK' | 'OUTCOME_UNKNOWN' | 'TRIGGERED_LOCKED' | 'ELIGIBLE',
  applicationRevision: string,
) {
  return {
    ...boundaryBody,
    application: {
      ...boundaryBody.application,
      applicationRevision,
      submissionState,
    },
  } as const;
}

function response(status: number, body: unknown): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

function errorEnvelope(
  code:
    | 'LOGIN_REQUIRED'
    | 'APPLICATION_ALREADY_SUBMITTED'
    | 'EXECUTION_LEASE_EXPIRED',
  details?: unknown,
) {
  const definition = AGENT_ERROR_DEFINITIONS[code];
  return {
    schemaVersion: 1,
    statusCode: definition.statusCode,
    code,
    message: 'localized copy is not authority',
    retryable: definition.retryable,
    requiresUserAction: definition.requiresUserAction,
    recommendedAction: definition.recommendedAction,
    requestId: 'req-1',
    ...(details === undefined ? {} : { details }),
  };
}

function harness(responses: readonly Response[]) {
  const calls: Array<{ url: string; body: Record<string, unknown>; authorization: string }> = [];
  const queue = [...responses];
  const client = createSubmissionBoundaryClient({
    apiBase: 'https://api.test.invalid',
    getAccessToken: async () => 'token-1',
    getInstallId: async () => INSTALL_ID,
    fetchFn: (async (input: string | URL, init?: RequestInit) => {
      calls.push({
        url: String(input),
        body: JSON.parse(String(init?.body)) as Record<string, unknown>,
        authorization: ((init?.headers ?? {}) as Record<string, string>).authorization,
      });
      return queue.shift() ?? response(500, {});
    }) as typeof fetch,
  });
  return { client, calls };
}

describe('T11 submission boundary client', () => {
  it('durably enters the boundary without CAP-AF-064 evidence fields', async () => {
    const h = harness([response(201, boundaryBody)]);
    const result = await h.client.enterBoundary(MISSION_ID, boundaryRequest);

    expect(result).toEqual({ ok: true, created: true, value: boundaryBody });
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]).toMatchObject({
      url: `https://api.test.invalid/api/v1/agent/missions/${MISSION_ID}/submission-boundaries`,
      authorization: 'Bearer token-1',
      body: { ...boundaryRequest, extensionInstallId: INSTALL_ID },
    });
    expect(JSON.stringify(h.calls[0]!.body)).not.toMatch(
      /confirmation|screenshot|providerEvidence|metadata|pageUrl|html/i,
    );
  });

  it.each([
    ['TRIGGERING_RISK', '8'],
    ['TRIGGERING_RISK', '11'],
    ['OUTCOME_UNKNOWN', '8'],
    ['OUTCOME_UNKNOWN', '9'],
    ['OUTCOME_UNKNOWN', '100000000000000000000'],
    ['TRIGGERED_LOCKED', '8'],
    ['TRIGGERED_LOCKED', '9'],
    ['TRIGGERED_LOCKED', '11'],
    ['TRIGGERED_LOCKED', '100000000000000000000'],
  ] as const)(
    'accepts a correlated 200 replay with live %s revision %s',
    async (submissionState, applicationRevision) => {
      const body = boundaryReplayBody(submissionState, applicationRevision);
      const h = harness([response(200, body)]);

      await expect(h.client.enterBoundary(MISSION_ID, boundaryRequest)).resolves.toEqual({
        ok: true,
        created: false,
        value: body,
      });
    },
  );

  it.each([
    ['TRIGGERING_RISK', '7'],
    ['OUTCOME_UNKNOWN', '7'],
    ['TRIGGERED_LOCKED', '7'],
    ['ELIGIBLE', '8'],
  ] as const)(
    'rejects a malicious 200 replay state/revision pair: %s at %s',
    async (submissionState, applicationRevision) => {
      const h = harness([
        response(200, boundaryReplayBody(submissionState, applicationRevision)),
      ]);

      await expect(h.client.enterBoundary(MISSION_ID, boundaryRequest)).resolves.toEqual({
        ok: false,
        code: 'BOUNDARY_RESPONSE_MALFORMED',
      });
    },
  );

  it('compares replay revisions without Number precision loss', async () => {
    const request = {
      ...boundaryRequest,
      expectedApplicationRevision: '99999999999999999999',
    } as unknown as Omit<EnterSubmissionBoundaryRequest, 'extensionInstallId'>;
    const atBoundary = boundaryReplayBody(
      'TRIGGERED_LOCKED',
      '100000000000000000000',
    );
    const accepted = harness([response(200, atBoundary)]);
    await expect(accepted.client.enterBoundary(MISSION_ID, request)).resolves.toEqual({
      ok: true,
      created: false,
      value: atBoundary,
    });

    const belowBoundary = harness([
      response(200, boundaryReplayBody('TRIGGERED_LOCKED', '99999999999999999999')),
    ]);
    await expect(belowBoundary.client.enterBoundary(MISSION_ID, request)).resolves.toEqual({
      ok: false,
      code: 'BOUNDARY_RESPONSE_MALFORMED',
    });
  });

  it.each([
    ['TRIGGERING_RISK', '9'],
    ['OUTCOME_UNKNOWN', '8'],
    ['OUTCOME_UNKNOWN', '9'],
    ['TRIGGERED_LOCKED', '8'],
    ['TRIGGERED_LOCKED', '9'],
  ] as const)(
    'keeps 201 strict and rejects %s revision %s',
    async (submissionState, applicationRevision) => {
      const h = harness([
        response(201, boundaryReplayBody(submissionState, applicationRevision)),
      ]);

      await expect(h.client.enterBoundary(MISSION_ID, boundaryRequest)).resolves.toEqual({
        ok: false,
        code: 'BOUNDARY_RESPONSE_MALFORMED',
      });
    },
  );

  it('rejects a 200 replay whose immutable boundary binding drifted', async () => {
    const h = harness([
      response(200, {
        ...boundaryReplayBody('OUTCOME_UNKNOWN', '9'),
        boundary: { ...boundaryBody.boundary, missionStepId: OTHER_ID },
      }),
    ]);

    await expect(h.client.enterBoundary(MISSION_ID, boundaryRequest)).resolves.toEqual({
      ok: false,
      code: 'BOUNDARY_RESPONSE_MALFORMED',
    });
  });

  it('records an observed native trigger with the exact accepted binding', async () => {
    const h = harness([response(201, triggeredBody)]);
    const result = await h.client.recordTriggered(MISSION_ID, triggeredRequest);

    expect(result).toEqual({ ok: true, created: true, value: triggeredBody });
    expect(h.calls[0]!.body).toEqual({ ...triggeredRequest, extensionInstallId: INSTALL_ID });
  });

  it('preserves the stable lease-expired result on the submission-event endpoint', async () => {
    const h = harness([
      response(410, errorEnvelope('EXECUTION_LEASE_EXPIRED')),
    ]);

    await expect(
      h.client.recordTriggered(MISSION_ID, triggeredRequest),
    ).resolves.toEqual({ ok: false, code: 'EXECUTION_LEASE_EXPIRED' });
  });

  it('accepts only the legal +2 late-trigger revision after OUTCOME_UNKNOWN reaping', async () => {
    const late = {
      ...triggeredBody,
      event: { ...triggeredBody.event, applicationRevision: '10' },
      application: { ...triggeredBody.application, applicationRevision: '10' },
    } as const;
    const accepted = harness([response(200, late)]);
    await expect(accepted.client.recordTriggered(MISSION_ID, triggeredRequest)).resolves.toEqual({
      ok: true,
      created: false,
      value: late,
    });

    const tooFar = {
      ...late,
      event: { ...late.event, applicationRevision: '11' },
      application: { ...late.application, applicationRevision: '11' },
    } as const;
    const rejected = harness([response(200, tooFar)]);
    await expect(rejected.client.recordTriggered(MISSION_ID, triggeredRequest)).resolves.toEqual({
      ok: false,
      code: 'BOUNDARY_RESPONSE_MALFORMED',
    });
  });

  it('supports explicit user-reported submission without inventing a boundary/install', async () => {
    const clientRequestId = '10000000-0000-4000-8000-000000000010';
    const h = harness([
      response(200, {
        ...triggeredBody,
        event: {
          ...triggeredBody.event,
          id: clientRequestId,
          eventType: 'USER_REPORTED_SUBMISSION',
        },
      }),
    ]);
    const request = {
      clientRequestId,
      eventType: 'USER_REPORTED_SUBMISSION',
      applicationId: APPLICATION_ID,
      expectedApplicationRevision: '8',
      applicationBundleVersion: '3',
    } as unknown as Extract<
      RecordSubmissionEventRequest,
      { eventType: 'USER_REPORTED_SUBMISSION' }
    >;
    const result = await h.client.recordUserReported(MISSION_ID, request);

    expect(result.ok).toBe(true);
    expect(h.calls[0]!.body).toEqual(request);
    expect(h.calls[0]!.body).not.toHaveProperty('boundaryId');
    expect(h.calls[0]!.body).not.toHaveProperty('extensionInstallId');
  });

  it('rejects malformed or unknown response fields and preserves stable server errors', async () => {
    const malformed = harness([
      response(201, { ...boundaryBody, confirmationUrl: 'https://secret.invalid' }),
    ]);
    await expect(malformed.client.enterBoundary(MISSION_ID, boundaryRequest)).resolves.toEqual({
      ok: false,
      code: 'BOUNDARY_RESPONSE_MALFORMED',
    });

    const rejected = harness([
      response(409, errorEnvelope('APPLICATION_ALREADY_SUBMITTED', {})),
    ]);
    await expect(rejected.client.enterBoundary(MISSION_ID, boundaryRequest)).resolves.toEqual({
      ok: false,
      code: 'APPLICATION_ALREADY_SUBMITTED',
    });
  });

  it('refreshes a 401 only after validating the complete LOGIN_REQUIRED envelope', async () => {
    const malformedRefresh = vi.fn(async () => 'token-2');
    const malformedFetch = vi.fn<typeof fetch>(async () =>
      response(401, { code: 'LOGIN_REQUIRED' }),
    );
    const malformedClient = createSubmissionBoundaryClient({
      apiBase: 'https://api.test.invalid',
      getAccessToken: async () => 'token-1',
      refreshAccessToken: malformedRefresh,
      getInstallId: async () => INSTALL_ID,
      fetchFn: malformedFetch,
    });

    await expect(
      malformedClient.enterBoundary(MISSION_ID, boundaryRequest),
    ).resolves.toEqual({ ok: false, code: 'BOUNDARY_HTTP_FAILED' });
    expect(malformedRefresh).not.toHaveBeenCalled();
    expect(malformedFetch).toHaveBeenCalledTimes(1);

    const queue = [
      response(401, errorEnvelope('LOGIN_REQUIRED')),
      response(201, boundaryBody),
    ];
    const validRefresh = vi.fn(async () => 'token-2');
    const validFetch = vi.fn<typeof fetch>(async () => queue.shift()!);
    const validClient = createSubmissionBoundaryClient({
      apiBase: 'https://api.test.invalid',
      getAccessToken: async () => 'token-1',
      refreshAccessToken: validRefresh,
      getInstallId: async () => INSTALL_ID,
      fetchFn: validFetch,
    });

    await expect(validClient.enterBoundary(MISSION_ID, boundaryRequest)).resolves.toEqual({
      ok: true,
      created: true,
      value: boundaryBody,
    });
    expect(validRefresh).toHaveBeenCalledTimes(1);
    expect(validFetch).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['unknown key', { providerRawError: 'must not cross the boundary' }],
    ['non-decimal revision', { currentRevision: 7 }],
    ['invalid conversation id', { conversationId: 'conversation-1' }],
    ['invalid resource id', { resourceId: 'resource-1' }],
    ['non-string field key', { fieldKeys: ['email', 7] }],
    ['zero retry delay', { retryAfterSeconds: 0 }],
    ['oversized retry delay', { retryAfterSeconds: 2_678_401 }],
    ['invalid reset time', { resetAt: 'tomorrow' }],
  ])('rejects malformed AgentErrorDetails: %s', async (_label, details) => {
    const h = harness([
      response(409, errorEnvelope('APPLICATION_ALREADY_SUBMITTED', details)),
    ]);

    await expect(h.client.enterBoundary(MISSION_ID, boundaryRequest)).resolves.toEqual({
      ok: false,
      code: 'BOUNDARY_HTTP_FAILED',
    });
  });

  it('accepts only the closed, typed AgentErrorDetails control metadata', async () => {
    const h = harness([
      response(409, errorEnvelope('APPLICATION_ALREADY_SUBMITTED', {
        currentRevision: '8',
        conversationId: OTHER_ID,
        resourceId: APPLICATION_ID,
        fieldKeys: ['email', 'firstName'],
        retryAfterSeconds: 1,
        resetAt: '2026-08-24T12:00:00.000Z',
      })),
    ]);

    await expect(h.client.enterBoundary(MISSION_ID, boundaryRequest)).resolves.toEqual({
      ok: false,
      code: 'APPLICATION_ALREADY_SUBMITTED',
    });
  });

  it.each([
    ['mission id', { boundary: { ...boundaryBody.boundary, missionId: OTHER_ID } }],
    ['mission revision', { boundary: { ...boundaryBody.boundary, missionRevision: '11' } }],
    ['mission step id', { boundary: { ...boundaryBody.boundary, missionStepId: OTHER_ID } }],
    ['step attempt', { boundary: { ...boundaryBody.boundary, stepAttempt: 2 } }],
    ['boundary application id', { boundary: { ...boundaryBody.boundary, applicationId: OTHER_ID } }],
    ['boundary bundle', { boundary: { ...boundaryBody.boundary, applicationBundleVersion: '4' } }],
    ['projection application id', { application: { ...boundaryBody.application, applicationId: OTHER_ID } }],
    ['projection bundle', { application: { ...boundaryBody.application, applicationBundleVersion: '4' } }],
    ['projection revision', { application: { ...boundaryBody.application, applicationRevision: '9' } }],
  ])('rejects an uncorrelated boundary response: %s', async (_label, fragment) => {
    const h = harness([response(201, { ...boundaryBody, ...fragment })]);

    await expect(h.client.enterBoundary(MISSION_ID, boundaryRequest)).resolves.toEqual({
      ok: false,
      code: 'BOUNDARY_RESPONSE_MALFORMED',
    });
  });

  it.each([
    ['client request id', { event: { ...triggeredBody.event, id: OTHER_ID } }],
    ['event type', { event: { ...triggeredBody.event, eventType: 'USER_REPORTED_SUBMISSION' } }],
    ['event application id', { event: { ...triggeredBody.event, applicationId: OTHER_ID } }],
    ['event bundle', { event: { ...triggeredBody.event, applicationBundleVersion: '4' } }],
    ['event revision', { event: { ...triggeredBody.event, applicationRevision: '11' } }],
    ['projection application id', { application: { ...triggeredBody.application, applicationId: OTHER_ID } }],
    ['projection bundle', { application: { ...triggeredBody.application, applicationBundleVersion: '4' } }],
    ['projection revision', { application: { ...triggeredBody.application, applicationRevision: '10' } }],
    ['projection state', { application: { ...triggeredBody.application, submissionState: 'OUTCOME_UNKNOWN' } }],
  ])('rejects an uncorrelated submission event response: %s', async (_label, fragment) => {
    const h = harness([response(201, { ...triggeredBody, ...fragment })]);

    await expect(h.client.recordTriggered(MISSION_ID, triggeredRequest)).resolves.toEqual({
      ok: false,
      code: 'BOUNDARY_RESPONSE_MALFORMED',
    });
  });

  it.each(['OPEN', 'CLOSED'] as const)(
    'rejects %s canonical status without lastVerifiedAt',
    async (canonicalJobStatus) => {
      const h = harness([response(201, {
        ...boundaryBody,
        application: {
          ...boundaryBody.application,
          canonicalJobStatus,
          lastVerifiedAt: null,
        },
      })]);

      await expect(h.client.enterBoundary(MISSION_ID, boundaryRequest)).resolves.toEqual({
        ok: false,
        code: 'BOUNDARY_RESPONSE_MALFORMED',
      });
    },
  );

  it('allows null lastVerifiedAt only for UNKNOWN canonical status', async () => {
    const body = {
      ...boundaryBody,
      application: {
        ...boundaryBody.application,
        canonicalJobStatus: 'UNKNOWN',
        lastVerifiedAt: null,
      },
    } as const;
    const h = harness([response(201, body)]);

    await expect(h.client.enterBoundary(MISSION_ID, boundaryRequest)).resolves.toEqual({
      ok: true,
      created: true,
      value: body,
    });
  });

  it('fails closed before network I/O without auth or install binding', async () => {
    const fetchFn = vi.fn<typeof fetch>();
    const client = createSubmissionBoundaryClient({
      apiBase: 'https://api.test.invalid',
      getAccessToken: async () => null,
      getInstallId: async () => null,
      fetchFn,
    });
    await expect(client.enterBoundary(MISSION_ID, boundaryRequest)).resolves.toEqual({
      ok: false,
      code: 'BOUNDARY_AUTH_UNAVAILABLE',
    });
    expect(fetchFn).not.toHaveBeenCalled();
  });
});

describe('T11 two-gesture coordinator', () => {
  it('never exposes a programmatic submit callback and requires durable boundary first', async () => {
    const h = harness([response(201, boundaryBody), response(201, triggeredBody)]);
    const coordinator = new SubmissionBoundaryCoordinator(h.client);

    expect(coordinator.state).toBe('ARMED');
    await expect(coordinator.enterBeforeNativeSubmission(MISSION_ID, boundaryRequest)).resolves.toEqual({
      ok: true,
      next: 'WAIT_FOR_USER_RETRY',
    });
    expect(coordinator.state).toBe('WAIT_FOR_USER_RETRY');

    await expect(
      coordinator.recordObservedNativeSubmission(MISSION_ID, triggeredRequest),
    ).resolves.toEqual({ ok: true, next: 'TRIGGERED_LOCKED' });
    expect(coordinator.state).toBe('TRIGGERED_LOCKED');
    expect(h.calls).toHaveLength(2);
  });

  it.each([
    ['OUTCOME_UNKNOWN', '8'],
    ['TRIGGERED_LOCKED', '100000000000000000000'],
  ] as const)(
    'keeps a 200 live %s replay monotonic in the coordinator',
    async (submissionState, applicationRevision) => {
      const h = harness([
        response(200, boundaryReplayBody(submissionState, applicationRevision)),
      ]);
      const coordinator = new SubmissionBoundaryCoordinator(h.client);

      await expect(
        coordinator.enterBeforeNativeSubmission(MISSION_ID, boundaryRequest),
      ).resolves.toEqual({ ok: true, next: submissionState });
      expect(coordinator.state).toBe(submissionState);
      await expect(
        coordinator.recordObservedNativeSubmission(MISSION_ID, triggeredRequest),
      ).resolves.toEqual({ ok: false, next: 'BLOCK_NATIVE_SUBMISSION' });
      expect(h.calls).toHaveLength(1);
    },
  );

  it('blocks the native path when boundary acceptance is uncertain', async () => {
    const h = harness([response(503, {})]);
    const coordinator = new SubmissionBoundaryCoordinator(h.client);

    await expect(coordinator.enterBeforeNativeSubmission(MISSION_ID, boundaryRequest)).resolves.toEqual({
      ok: false,
      next: 'BLOCK_NATIVE_SUBMISSION',
    });
    expect(coordinator.state).toBe('BLOCKED');
    await expect(
      coordinator.recordObservedNativeSubmission(MISSION_ID, triggeredRequest),
    ).resolves.toEqual({ ok: false, next: 'BLOCK_NATIVE_SUBMISSION' });
    expect(h.calls).toHaveLength(1);
  });
});

// Compile-time source-contract checks: the consumer cannot add evidence arms.
const _boundaryContract: Omit<EnterSubmissionBoundaryRequest, 'extensionInstallId'> =
  boundaryRequest;
const _eventContract: Omit<
  Extract<RecordSubmissionEventRequest, { eventType: 'SUBMISSION_TRIGGERED' }>,
  'extensionInstallId'
> = triggeredRequest;
void _boundaryContract;
void _eventContract;
