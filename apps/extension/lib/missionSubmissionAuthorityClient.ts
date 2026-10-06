import {
  AGENT_ERROR_DEFINITIONS,
  ATS_PROVIDER_CODES,
  SOURCE_PLATFORM_CODES,
  parseIsoDateTime,
  parseUuid,
} from '@edaix/contracts';
import type { ExecutionGrant } from '@edaix/agent-channel';
import type { SubmissionAuthority } from './submissionBoundaryProtocol';

export interface MissionSubmissionAuthorityClient {
  resolve(grant: ExecutionGrant): Promise<SubmissionAuthority | null>;
}

export function createMissionSubmissionAuthorityClient(input: Readonly<{
  apiBase: string;
  getAccessToken: () => Promise<string | null>;
  refreshAccessToken?: () => Promise<string | null>;
  fetchFn?: typeof fetch;
}>): MissionSubmissionAuthorityClient {
  const fetchFn = input.fetchFn ?? fetch;

  async function request(token: string, missionId: string): Promise<Response> {
    return fetchFn(
      new URL(`/api/v1/agent/missions/${encodeURIComponent(missionId)}`, input.apiBase).toString(),
      { method: 'GET', headers: { accept: 'application/json', authorization: `Bearer ${token}` } },
    );
  }

  return Object.freeze({
    async resolve(grant: ExecutionGrant): Promise<SubmissionAuthority | null> {
      if (!grant.allowedActions.includes('SUBMIT')) return null;
      if (!parseUuid(grant.missionId) || !parseUuid(grant.missionStepId)) return null;
      try {
        let token = await input.getAccessToken();
        if (!token) return null;
        let response = await request(token, grant.missionId);
        if (response.status === 401 && input.refreshAccessToken) {
          const body = await safeJson(response);
          if (!isLoginRequired(body)) return null;
          token = await input.refreshAccessToken();
          if (!token) return null;
          response = await request(token, grant.missionId);
        }
        if (!response.ok || response.status !== 200) return null;
        return decodeAuthority(await safeJson(response), grant);
      } catch {
        return null;
      }
    },
  });
}

function decodeAuthority(value: unknown, grant: ExecutionGrant): SubmissionAuthority | null {
  if (!exactRecord(value, ['schemaVersion', 'mission']) || value['schemaVersion'] !== 1) return null;
  const mission = value['mission'];
  if (!exactRecord(mission, [
    'id', 'conversationId', 'revision', 'status', 'job', 'application',
    'automationLevel', 'progress', 'createdAt', 'updatedAt', 'steps', 'approvalPlan',
  ])) return null;
  if (
    mission['id'] !== grant.missionId ||
    !parseUuid(mission['id']) ||
    !parseUuid(mission['conversationId']) ||
    !positiveDecimal(mission['revision']) ||
    mission['status'] !== 'EXECUTING' ||
    !parseIsoDateTime(mission['createdAt']) ||
    !parseIsoDateTime(mission['updatedAt']) ||
    mission['approvalPlan'] !== null ||
    !decodeJob(mission['job']) ||
    !decodeProgress(mission['progress']) ||
    !Array.isArray(mission['steps']) ||
    !mission['steps'].every(decodeStep)
  ) return null;
  const application = mission['application'];
  if (!decodeArmedApplication(application)) return null;
  const step = mission['steps'].find(
    (candidate) => isRecord(candidate) && candidate['id'] === grant.missionStepId,
  );
  if (
    !isRecord(step) ||
    step['type'] !== 'EXECUTE_FILL' ||
    step['status'] !== 'RUNNING' ||
    !Number.isInteger(step['attempt']) ||
    Number(step['attempt']) < 1
  ) return null;
  return Object.freeze({
    missionId: grant.missionId,
    expectedMissionRevision: mission['revision'],
    missionStepId: grant.missionStepId,
    stepAttempt: Number(step['attempt']),
    applicationId: application['applicationId'],
    expectedApplicationRevision: application['applicationRevision'],
    applicationBundleVersion: application['applicationBundleVersion'],
  });
}

function decodeArmedApplication(value: unknown): value is Record<string, string> {
  if (!exactRecord(value, [
    'canonicalJobId', 'canonicalJobStatus', 'lastVerifiedAt', 'applicationId',
    'applicationBundleVersion', 'applicationRevision', 'submissionState',
  ])) return false;
  return Boolean(
    parseUuid(value['canonicalJobId']) &&
    value['canonicalJobStatus'] === 'OPEN' &&
    parseIsoDateTime(value['lastVerifiedAt']) &&
    parseUuid(value['applicationId']) &&
    positiveDecimal(value['applicationBundleVersion']) &&
    positiveDecimal(value['applicationRevision']) &&
    value['submissionState'] === 'ARMED',
  );
}

function decodeJob(value: unknown): boolean {
  if (!exactRecord(value, [
    'jobId', 'sourcePlatform', 'atsProvider', 'canonicalOrigin', 'pathRuleId',
    'postingFingerprint',
  ])) return false;
  return typeof value['jobId'] === 'string' && value['jobId'] !== '' &&
    SOURCE_PLATFORM_CODES.includes(value['sourcePlatform'] as never) &&
    ATS_PROVIDER_CODES.includes(value['atsProvider'] as never) &&
    typeof value['canonicalOrigin'] === 'string' &&
    /^https:\/\/[a-z0-9.-]+(?::\d+)?$/i.test(value['canonicalOrigin']) &&
    typeof value['pathRuleId'] === 'string' && value['pathRuleId'] !== '' &&
    sha256(value['postingFingerprint']);
}

function decodeProgress(value: unknown): boolean {
  return exactRecord(value, ['progressCode', 'completed', 'total', 'currentStepId']) &&
    typeof value['progressCode'] === 'string' &&
    Number.isInteger(value['completed']) &&
    Number.isInteger(value['total']) &&
    (value['currentStepId'] === null || Boolean(parseUuid(value['currentStepId'])));
}

function decodeStep(value: unknown): boolean {
  if (!exactRecord(value, [
    'id', 'sequence', 'attempt', 'type', 'status', 'progressCode', 'errorCode',
    'startedAt', 'finishedAt',
  ])) return false;
  return Boolean(
    parseUuid(value['id']) &&
    Number.isInteger(value['sequence']) && Number(value['sequence']) > 0 &&
    Number.isInteger(value['attempt']) && Number(value['attempt']) > 0 &&
    typeof value['type'] === 'string' && typeof value['status'] === 'string' &&
    typeof value['progressCode'] === 'string' &&
    (value['errorCode'] === null || typeof value['errorCode'] === 'string') &&
    (value['startedAt'] === null || parseIsoDateTime(value['startedAt'])) &&
    (value['finishedAt'] === null || parseIsoDateTime(value['finishedAt'])),
  );
}

async function safeJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function positiveDecimal(value: unknown): value is string {
  return typeof value === 'string' && /^[1-9][0-9]*$/.test(value);
}

function sha256(value: unknown): boolean {
  return typeof value === 'string' && /^sha256:[0-9a-f]{64}$/.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function exactRecord(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return isRecord(value) && Object.keys(value).sort().join(',') === [...keys].sort().join(',');
}

function isLoginRequired(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const required = [
    'schemaVersion', 'statusCode', 'code', 'message', 'retryable',
    'requiresUserAction', 'recommendedAction', 'requestId',
  ];
  const allowed = new Set([...required, 'details']);
  if (!required.every((key) => key in value) || Object.keys(value).some((key) => !allowed.has(key))) {
    return false;
  }
  const definition = AGENT_ERROR_DEFINITIONS.LOGIN_REQUIRED;
  return value['schemaVersion'] === 1 &&
    value['statusCode'] === definition.statusCode &&
    value['code'] === 'LOGIN_REQUIRED' &&
    typeof value['message'] === 'string' &&
    value['retryable'] === definition.retryable &&
    value['requiresUserAction'] === definition.requiresUserAction &&
    value['recommendedAction'] === definition.recommendedAction &&
    typeof value['requestId'] === 'string' && value['requestId'] !== '' &&
    value['details'] === undefined;
}
