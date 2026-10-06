import { describe, expect, it, vi } from 'vitest';
import type { ExecutionGrant } from '@edaix/agent-channel';
import { createMissionSubmissionAuthorityClient } from '../lib/missionSubmissionAuthorityClient';

const MISSION_ID = '10000000-0000-4000-8000-000000000001';
const STEP_ID = '10000000-0000-4000-8000-000000000002';
const APPLICATION_ID = '10000000-0000-4000-8000-000000000003';
const GRANT: ExecutionGrant = {
  missionId: MISSION_ID,
  missionStepId: STEP_ID,
  fieldKeys: ['email'],
  allowedActions: ['FILL', 'SUBMIT'],
  executionLease: 'lease-1',
  leaseExpiresAt: 9_999_999_999,
  intentVersion: 1,
  planDigest: `sha256:${'a'.repeat(64)}`,
  jobIdentityHash: `sha256:${'b'.repeat(64)}`,
  fieldSchemaVersion: 1,
  profileSnapshot: {
    revision: '1', deletionEpoch: '1', snapshotDigest: `sha256:${'c'.repeat(64)}`,
  },
};

function mission(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    mission: {
      id: MISSION_ID,
      conversationId: '10000000-0000-4000-8000-000000000020',
      revision: '9',
      status: 'EXECUTING',
      job: {
        jobId: 'source-1',
        sourcePlatform: 'GREENHOUSE',
        atsProvider: 'GREENHOUSE',
        canonicalOrigin: 'https://job-boards.greenhouse.io',
        pathRuleId: 'greenhouse-v1',
        postingFingerprint: `sha256:${'d'.repeat(64)}`,
      },
      application: {
        canonicalJobId: '10000000-0000-4000-8000-000000000021',
        canonicalJobStatus: 'OPEN',
        lastVerifiedAt: '2026-08-23T11:58:00.000Z',
        applicationId: APPLICATION_ID,
        applicationBundleVersion: '3',
        applicationRevision: '7',
        submissionState: 'ARMED',
      },
      automationLevel: 'L2_CONFIRM_EACH_SUBMISSION',
      progress: {
        progressCode: 'EXECUTION_STARTED', completed: 4, total: 6, currentStepId: STEP_ID,
      },
      createdAt: '2026-08-23T11:50:00.000Z',
      updatedAt: '2026-08-23T12:00:00.000Z',
      steps: [{
        id: STEP_ID,
        sequence: 5,
        attempt: 2,
        type: 'EXECUTE_FILL',
        status: 'RUNNING',
        progressCode: 'EXECUTION_STARTED',
        errorCode: null,
        startedAt: '2026-08-23T12:00:00.000Z',
        finishedAt: null,
      }],
      approvalPlan: null,
      ...overrides,
    },
  };
}

function client(body: unknown) {
  const fetchFn = vi.fn<typeof fetch>(async () => ({
    ok: true, status: 200, json: async () => body,
  }) as Response);
  return {
    value: createMissionSubmissionAuthorityClient({
      apiBase: 'https://api.test.invalid',
      getAccessToken: async () => 'token-1',
      fetchFn,
    }),
    fetchFn,
  };
}

describe('T11 Mission submission authority resolver', () => {
  it('projects exact owner-scoped Mission/step/Application/bundle authority after claim', async () => {
    const h = client(mission());
    await expect(h.value.resolve(GRANT)).resolves.toEqual({
      missionId: MISSION_ID,
      expectedMissionRevision: '9',
      missionStepId: STEP_ID,
      stepAttempt: 2,
      applicationId: APPLICATION_ID,
      expectedApplicationRevision: '7',
      applicationBundleVersion: '3',
    });
    expect(h.fetchFn).toHaveBeenCalledWith(
      `https://api.test.invalid/api/v1/agent/missions/${MISSION_ID}`,
      expect.objectContaining({ headers: expect.objectContaining({ authorization: 'Bearer token-1' }) }),
    );
  });

  it.each([
    ['legacy null application', mission({ application: null })],
    ['wrong mission state', mission({ status: 'READY_TO_EXECUTE' })],
    ['wrong execution step', mission({ steps: [] })],
    ['non-armed application', mission({ application: { ...mission().mission.application, submissionState: 'ELIGIBLE' } })],
    ['response extra evidence', { ...mission(), confirmationUrl: 'https://secret.invalid' }],
  ])('fails closed for %s', async (_label, body) => {
    await expect(client(body).value.resolve(GRANT)).resolves.toBeNull();
  });

  it('does not fetch or arm a FILL-only grant', async () => {
    const h = client(mission());
    await expect(h.value.resolve({ ...GRANT, allowedActions: ['FILL'] })).resolves.toBeNull();
    expect(h.fetchFn).not.toHaveBeenCalled();
  });
});
