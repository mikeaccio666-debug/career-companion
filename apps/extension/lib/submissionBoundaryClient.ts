import {
  AGENT_ERROR_DEFINITIONS,
  APPLICATION_SUBMISSION_STATES,
  CANONICAL_JOB_STATUSES,
  enterSubmissionBoundaryErrors,
  parseIsoDateTime,
  parseUuid,
  recordSubmissionEventErrors,
  type AgentErrorCode,
  type AgentErrorDetails,
  type EnterSubmissionBoundaryRequest,
  type EnterSubmissionBoundaryResponse,
  type RecordSubmissionEventRequest,
  type RecordSubmissionEventResponse,
} from '@edaix/contracts';

export const SUBMISSION_BOUNDARY_CLIENT_DIAG_CODES = [
  'BOUNDARY_AUTH_UNAVAILABLE',
  'BOUNDARY_INSTALL_UNAVAILABLE',
  'BOUNDARY_HTTP_FAILED',
  'BOUNDARY_RESPONSE_MALFORMED',
] as const;
export type SubmissionBoundaryClientDiagCode =
  (typeof SUBMISSION_BOUNDARY_CLIENT_DIAG_CODES)[number];

type ClientFailureCode = AgentErrorCode | SubmissionBoundaryClientDiagCode;
type ClientResult<T> =
  | Readonly<{ ok: true; created: boolean; value: T }>
  | Readonly<{ ok: false; code: ClientFailureCode }>;

type BoundaryInput = Omit<EnterSubmissionBoundaryRequest, 'extensionInstallId'>;
type TriggeredInput = Omit<
  Extract<RecordSubmissionEventRequest, { eventType: 'SUBMISSION_TRIGGERED' }>,
  'extensionInstallId'
>;
type UserReportedInput = Extract<
  RecordSubmissionEventRequest,
  { eventType: 'USER_REPORTED_SUBMISSION' }
>;

export interface SubmissionBoundaryClientDeps {
  readonly apiBase: string;
  readonly getAccessToken: () => Promise<string | null>;
  readonly refreshAccessToken?: () => Promise<string | null>;
  readonly getInstallId: () => Promise<string | null>;
  readonly fetchFn?: typeof fetch;
  readonly onDiagnostic?: (code: SubmissionBoundaryClientDiagCode) => void;
}

export interface SubmissionBoundaryClient {
  enterBoundary(
    missionId: string,
    request: BoundaryInput,
  ): Promise<ClientResult<EnterSubmissionBoundaryResponse>>;
  recordTriggered(
    missionId: string,
    request: TriggeredInput,
  ): Promise<ClientResult<RecordSubmissionEventResponse>>;
  recordUserReported(
    missionId: string,
    request: UserReportedInput,
  ): Promise<ClientResult<RecordSubmissionEventResponse>>;
}

export function createSubmissionBoundaryClient(
  deps: SubmissionBoundaryClientDeps,
): SubmissionBoundaryClient {
  const fetchFn = deps.fetchFn ?? fetch;
  const diagnose = (code: SubmissionBoundaryClientDiagCode) => {
    deps.onDiagnostic?.(code);
    return Object.freeze({ ok: false as const, code });
  };

  async function extensionBinding(): Promise<
    | Readonly<{ token: string; installId: string }>
    | Readonly<{ error: ClientResult<never> }>
  > {
    const token = await deps.getAccessToken().catch(() => null);
    if (!token) return { error: diagnose('BOUNDARY_AUTH_UNAVAILABLE') };
    const installId = await deps.getInstallId().catch(() => null);
    if (!installId || !parseUuid(installId)) {
      return { error: diagnose('BOUNDARY_INSTALL_UNAVAILABLE') };
    }
    return Object.freeze({ token, installId });
  }

  async function ownerBinding(): Promise<
    | Readonly<{ token: string }>
    | Readonly<{ error: ClientResult<never> }>
  > {
    const token = await deps.getAccessToken().catch(() => null);
    return token
      ? Object.freeze({ token })
      : { error: diagnose('BOUNDARY_AUTH_UNAVAILABLE') };
  }

  async function post<T>(input: Readonly<{
    path: string;
    token: string;
    body: object;
    allowedErrors: readonly AgentErrorCode[];
    decode: (value: unknown, status: 200 | 201) => T | null;
  }>): Promise<ClientResult<T>> {
    let token = input.token;
    let response: Response;
    try {
      response = await send(token, input.path, input.body);
      if (response.status === 401 && deps.refreshAccessToken) {
        const firstBody = await safeJson(response);
        if (decodeErrorCode(firstBody, response.status, ['LOGIN_REQUIRED']) === 'LOGIN_REQUIRED') {
          const refreshed = await deps.refreshAccessToken().catch(() => null);
          if (!refreshed) return diagnose('BOUNDARY_AUTH_UNAVAILABLE');
          token = refreshed;
          response = await send(token, input.path, input.body);
        } else {
          const code = decodeErrorCode(firstBody, response.status, input.allowedErrors);
          return code ? Object.freeze({ ok: false, code }) : diagnose('BOUNDARY_HTTP_FAILED');
        }
      }
    } catch {
      return diagnose('BOUNDARY_HTTP_FAILED');
    }

    const body = await safeJson(response);
    if (!response.ok) {
      const code = decodeErrorCode(body, response.status, input.allowedErrors);
      return code ? Object.freeze({ ok: false, code }) : diagnose('BOUNDARY_HTTP_FAILED');
    }
    if (response.status !== 200 && response.status !== 201) {
      return diagnose('BOUNDARY_HTTP_FAILED');
    }
    const decoded = input.decode(body, response.status);
    if (!decoded) return diagnose('BOUNDARY_RESPONSE_MALFORMED');
    return Object.freeze({ ok: true, created: response.status === 201, value: decoded });
  }

  function send(token: string, path: string, body: object): Promise<Response> {
    return fetchFn(new URL(path, deps.apiBase).toString(), {
      method: 'POST',
      headers: {
        accept: 'application/json',
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    });
  }

  return Object.freeze({
    async enterBoundary(missionId: string, request: BoundaryInput) {
      const binding = await extensionBinding();
      if ('error' in binding) return binding.error;
      // Explicit projection is a runtime allowlist. Structurally forged never
      // fields cannot be carried through object spread into this wire.
      const body: EnterSubmissionBoundaryRequest = {
        clientRequestId: request.clientRequestId,
        expectedMissionRevision: request.expectedMissionRevision,
        missionStepId: request.missionStepId,
        stepAttempt: request.stepAttempt,
        applicationId: request.applicationId,
        expectedApplicationRevision: request.expectedApplicationRevision,
        applicationBundleVersion: request.applicationBundleVersion,
        extensionInstallId: binding.installId as EnterSubmissionBoundaryRequest['extensionInstallId'],
      };
      return post({
        path: `/api/v1/agent/missions/${encodeURIComponent(missionId)}/submission-boundaries`,
        token: binding.token,
        body,
        allowedErrors: enterSubmissionBoundaryErrors,
        decode: (value, status) => decodeBoundaryResponse(value, missionId, request, status),
      });
    },

    async recordTriggered(missionId: string, request: TriggeredInput) {
      const binding = await extensionBinding();
      if ('error' in binding) return binding.error;
      const body: RecordSubmissionEventRequest = {
        clientRequestId: request.clientRequestId,
        eventType: 'SUBMISSION_TRIGGERED',
        applicationId: request.applicationId,
        expectedApplicationRevision: request.expectedApplicationRevision,
        applicationBundleVersion: request.applicationBundleVersion,
        boundaryId: request.boundaryId,
        attemptRevision: request.attemptRevision,
        extensionInstallId: binding.installId as Extract<
          RecordSubmissionEventRequest,
          { eventType: 'SUBMISSION_TRIGGERED' }
        >['extensionInstallId'],
      };
      return post({
        path: `/api/v1/agent/missions/${encodeURIComponent(missionId)}/submission-events`,
        token: binding.token,
        body,
        allowedErrors: recordSubmissionEventErrors,
        decode: (value) => decodeEventResponse(value, request),
      });
    },

    async recordUserReported(missionId: string, request: UserReportedInput) {
      const binding = await ownerBinding();
      if ('error' in binding) return binding.error;
      const body: RecordSubmissionEventRequest = {
        clientRequestId: request.clientRequestId,
        eventType: 'USER_REPORTED_SUBMISSION',
        applicationId: request.applicationId,
        expectedApplicationRevision: request.expectedApplicationRevision,
        applicationBundleVersion: request.applicationBundleVersion,
      };
      return post({
        path: `/api/v1/agent/missions/${encodeURIComponent(missionId)}/submission-events`,
        token: binding.token,
        body,
        allowedErrors: recordSubmissionEventErrors,
        decode: (value) => decodeEventResponse(value, request),
      });
    },
  });
}

export type SubmissionBoundaryCoordinatorState =
  | 'ARMED'
  | 'BOUNDARY_PENDING'
  | 'WAIT_FOR_USER_RETRY'
  | 'TRIGGERED_LOCKED'
  | 'OUTCOME_UNKNOWN'
  | 'BLOCKED';

/**
 * Pure authority coordinator. It intentionally has no DOM target/callback and
 * therefore cannot click, submit, requestSubmit, or synthesize a user gesture.
 */
export class SubmissionBoundaryCoordinator {
  state: SubmissionBoundaryCoordinatorState = 'ARMED';

  constructor(private readonly client: SubmissionBoundaryClient) {}

  async enterBeforeNativeSubmission(
    missionId: string,
    request: BoundaryInput,
  ): Promise<Readonly<{
    ok: boolean;
    next:
      | 'WAIT_FOR_USER_RETRY'
      | 'OUTCOME_UNKNOWN'
      | 'TRIGGERED_LOCKED'
      | 'BLOCK_NATIVE_SUBMISSION';
  }>> {
    if (this.state !== 'ARMED') {
      return Object.freeze({ ok: false, next: 'BLOCK_NATIVE_SUBMISSION' });
    }
    this.state = 'BOUNDARY_PENDING';
    const result = await this.client.enterBoundary(missionId, request);
    if (!result.ok) {
      this.state = 'BLOCKED';
      return Object.freeze({ ok: false, next: 'BLOCK_NATIVE_SUBMISSION' });
    }
    const next = boundaryRuntimeState(result.value.application.submissionState);
    if (!next) {
      this.state = 'BLOCKED';
      return Object.freeze({ ok: false, next: 'BLOCK_NATIVE_SUBMISSION' });
    }
    this.state = next;
    return Object.freeze({ ok: true, next });
  }

  async recordObservedNativeSubmission(
    missionId: string,
    request: TriggeredInput,
  ): Promise<Readonly<{ ok: boolean; next: 'TRIGGERED_LOCKED' | 'BLOCK_NATIVE_SUBMISSION' }>> {
    if (this.state !== 'WAIT_FOR_USER_RETRY') {
      return Object.freeze({ ok: false, next: 'BLOCK_NATIVE_SUBMISSION' });
    }
    const result = await this.client.recordTriggered(missionId, request);
    if (!result.ok) {
      // The host boundary may already have occurred. Never restore eligibility
      // or offer a blind retry merely because the reporting network failed.
      this.state = 'OUTCOME_UNKNOWN';
      return Object.freeze({ ok: false, next: 'BLOCK_NATIVE_SUBMISSION' });
    }
    this.state = 'TRIGGERED_LOCKED';
    return Object.freeze({ ok: true, next: 'TRIGGERED_LOCKED' });
  }
}

async function safeJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function decodeErrorCode(
  value: unknown,
  status: number,
  allowed: readonly AgentErrorCode[],
): AgentErrorCode | null {
  if (!closedRecord(
    value,
    [
      'schemaVersion',
      'statusCode',
      'code',
      'message',
      'retryable',
      'requiresUserAction',
      'recommendedAction',
      'requestId',
    ],
    ['details'],
  )) return null;
  if (
    value['schemaVersion'] !== 1 ||
    value['statusCode'] !== status ||
    typeof value['code'] !== 'string' ||
    !Object.hasOwn(AGENT_ERROR_DEFINITIONS, value['code']) ||
    !allowed.includes(value['code'] as AgentErrorCode) ||
    typeof value['message'] !== 'string' ||
    typeof value['requestId'] !== 'string' ||
    value['requestId'].length === 0
  ) return null;
  const code = value['code'] as AgentErrorCode;
  const definition = AGENT_ERROR_DEFINITIONS[code];
  if (
    status !== definition.statusCode ||
    value['retryable'] !== definition.retryable ||
    value['requiresUserAction'] !== definition.requiresUserAction ||
    value['recommendedAction'] !== definition.recommendedAction
  ) return null;
  if (
    value['details'] !== undefined &&
    !decodeAgentErrorDetails(value['details'])
  ) return null;
  return code;
}

function decodeAgentErrorDetails(value: unknown): AgentErrorDetails | null {
  if (!closedRecord(value, [], [
    'currentRevision',
    'conversationId',
    'resourceId',
    'fieldKeys',
    'retryAfterSeconds',
    'resetAt',
  ])) return null;
  if (value['currentRevision'] !== undefined && !positiveDecimal(value['currentRevision'])) {
    return null;
  }
  if (value['conversationId'] !== undefined && !parseUuid(value['conversationId'])) return null;
  if (value['resourceId'] !== undefined && !parseUuid(value['resourceId'])) return null;
  if (
    value['fieldKeys'] !== undefined &&
    (!Array.isArray(value['fieldKeys']) ||
      !value['fieldKeys'].every((fieldKey) => typeof fieldKey === 'string'))
  ) return null;
  if (
    value['retryAfterSeconds'] !== undefined &&
    (!Number.isInteger(value['retryAfterSeconds']) ||
      Number(value['retryAfterSeconds']) < 1 ||
      Number(value['retryAfterSeconds']) > 2_678_400)
  ) return null;
  if (value['resetAt'] !== undefined && !parseIsoDateTime(value['resetAt'])) return null;
  return value as AgentErrorDetails;
}

function decodeBoundaryResponse(
  value: unknown,
  missionId: string,
  request: BoundaryInput,
  status: 200 | 201,
): EnterSubmissionBoundaryResponse | null {
  if (!exactRecord(value, ['schemaVersion', 'boundary', 'application']) || value['schemaVersion'] !== 1) {
    return null;
  }
  const boundary = value['boundary'];
  if (!exactRecord(boundary, [
    'id',
    'missionId',
    'missionRevision',
    'missionStepId',
    'stepAttempt',
    'applicationId',
    'applicationBundleVersion',
    'attemptRevision',
    'acceptedAt',
  ])) return null;
  const expectedMissionRevision = incrementPositiveDecimal(request.expectedMissionRevision);
  const boundaryApplicationRevision = incrementPositiveDecimal(
    request.expectedApplicationRevision,
  );
  if (
    !parseUuid(boundary['id']) ||
    !parseUuid(boundary['missionId']) ||
    !positiveDecimal(boundary['missionRevision']) ||
    !parseUuid(boundary['missionStepId']) ||
    !positiveInteger(boundary['stepAttempt']) ||
    !parseUuid(boundary['applicationId']) ||
    !positiveDecimal(boundary['applicationBundleVersion']) ||
    !positiveDecimal(boundary['attemptRevision']) ||
    !parseIsoDateTime(boundary['acceptedAt']) ||
    !decodeApplicationBinding(value['application'])
  ) return null;
  const application = value['application'];
  if (
    boundary['missionId'] !== missionId ||
    boundary['missionRevision'] !== expectedMissionRevision ||
    boundary['missionStepId'] !== request.missionStepId ||
    boundary['stepAttempt'] !== request.stepAttempt ||
    boundary['applicationId'] !== request.applicationId ||
    boundary['applicationBundleVersion'] !== request.applicationBundleVersion ||
    application['applicationId'] !== request.applicationId ||
    application['applicationBundleVersion'] !== request.applicationBundleVersion ||
    !legalBoundaryProjection(
      status,
      application['submissionState'],
      application['applicationRevision'],
      boundaryApplicationRevision,
    )
  ) return null;
  return value as unknown as EnterSubmissionBoundaryResponse;
}

function legalBoundaryProjection(
  status: 200 | 201,
  submissionState: unknown,
  applicationRevision: unknown,
  boundaryApplicationRevision: string | null,
): boolean {
  if (!boundaryApplicationRevision || !positiveDecimal(applicationRevision)) return false;
  if (status === 201) {
    return submissionState === 'TRIGGERING_RISK' &&
      applicationRevision === boundaryApplicationRevision;
  }
  if (!['TRIGGERING_RISK', 'OUTCOME_UNKNOWN', 'TRIGGERED_LOCKED'].includes(
    String(submissionState),
  )) return false;
  return BigInt(applicationRevision) >= BigInt(boundaryApplicationRevision);
}

function boundaryRuntimeState(
  submissionState: string,
): 'WAIT_FOR_USER_RETRY' | 'OUTCOME_UNKNOWN' | 'TRIGGERED_LOCKED' | null {
  switch (submissionState) {
    case 'TRIGGERING_RISK':
      return 'WAIT_FOR_USER_RETRY';
    case 'OUTCOME_UNKNOWN':
    case 'TRIGGERED_LOCKED':
      return submissionState;
    default:
      return null;
  }
}

function decodeEventResponse(
  value: unknown,
  request: TriggeredInput | UserReportedInput,
): RecordSubmissionEventResponse | null {
  if (!exactRecord(value, ['schemaVersion', 'event', 'application']) || value['schemaVersion'] !== 1) {
    return null;
  }
  const event = value['event'];
  if (!exactRecord(event, [
    'id',
    'eventType',
    'applicationId',
    'applicationBundleVersion',
    'applicationRevision',
    'recordedAt',
  ])) return null;
  const expectedApplicationRevision = incrementPositiveDecimal(
    request.expectedApplicationRevision,
  );
  const lateTriggerApplicationRevision = request.eventType === 'SUBMISSION_TRIGGERED'
    ? incrementPositiveDecimal(expectedApplicationRevision)
    : null;
  if (
    !parseUuid(event['id']) ||
    !['SUBMISSION_TRIGGERED', 'USER_REPORTED_SUBMISSION'].includes(String(event['eventType'])) ||
    !parseUuid(event['applicationId']) ||
    !positiveDecimal(event['applicationBundleVersion']) ||
    !positiveDecimal(event['applicationRevision']) ||
    !parseIsoDateTime(event['recordedAt']) ||
    !decodeApplicationBinding(value['application'])
  ) return null;
  const application = value['application'];
  if (
    event['id'] !== request.clientRequestId ||
    event['eventType'] !== request.eventType ||
    event['applicationId'] !== request.applicationId ||
    event['applicationBundleVersion'] !== request.applicationBundleVersion ||
    (
      event['applicationRevision'] !== expectedApplicationRevision &&
      event['applicationRevision'] !== lateTriggerApplicationRevision
    ) ||
    application['applicationId'] !== event['applicationId'] ||
    application['applicationBundleVersion'] !== event['applicationBundleVersion'] ||
    application['applicationRevision'] !== event['applicationRevision'] ||
    application['submissionState'] !== 'TRIGGERED_LOCKED'
  ) return null;
  return value as unknown as RecordSubmissionEventResponse;
}

function decodeApplicationBinding(value: unknown): value is Record<string, unknown> {
  if (!exactRecord(value, [
    'canonicalJobId',
    'canonicalJobStatus',
    'lastVerifiedAt',
    'applicationId',
    'applicationBundleVersion',
    'applicationRevision',
    'submissionState',
  ])) return false;
  if (
    !parseUuid(value['canonicalJobId']) ||
    !CANONICAL_JOB_STATUSES.includes(value['canonicalJobStatus'] as never) ||
    !parseUuid(value['applicationId']) ||
    !positiveDecimal(value['applicationBundleVersion']) ||
    !positiveDecimal(value['applicationRevision']) ||
    !APPLICATION_SUBMISSION_STATES.includes(value['submissionState'] as never)
  ) return false;
  if (value['lastVerifiedAt'] === null) {
    return value['canonicalJobStatus'] === 'UNKNOWN';
  }
  return Boolean(parseIsoDateTime(value['lastVerifiedAt']));
}

function incrementPositiveDecimal(value: unknown): string | null {
  return positiveDecimal(value) ? (BigInt(value) + 1n).toString() : null;
}

function positiveDecimal(value: unknown): value is string {
  return typeof value === 'string' && /^[1-9][0-9]*$/.test(value);
}

function positiveInteger(value: unknown): boolean {
  return Number.isInteger(value) && Number(value) > 0;
}

function exactRecord(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return isRecord(value) &&
    Object.keys(value).sort().join(',') === [...keys].sort().join(',');
}

function closedRecord(
  value: unknown,
  required: readonly string[],
  optional: readonly string[],
): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  const keys = Object.keys(value);
  const allowed = new Set([...required, ...optional]);
  return required.every((key) => keys.includes(key)) && keys.every((key) => allowed.has(key));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
