import { describe, expect, it } from 'vitest';

import {
  AGENT_ENDPOINTS,
  AGENT_ENDPOINT_ERROR_CODES,
  AGENT_ERROR_DEFINITIONS,
  APPLICATION_SUBMISSION_EVENT_TYPES,
  APPLICATION_SUBMISSION_STATES,
  CANONICAL_JOB_STATUSES,
  MISSION_STEP_ERROR_CODES,
  MISSION_STATUS_TRANSITIONS,
  VALIDATE_JOB_FIRST_MATCH_RESULT_CODES,
  type CanonicalApplicationBinding,
  type EnterSubmissionBoundaryRequest,
  type MissionSummary,
  type RecordSubmissionEventRequest,
  parseIsoDateTime,
  parseSha256Digest,
  parseUuid,
} from '../src/index.ts';

const canonicalJobId = parseUuid('10000000-0000-4000-8000-000000000001')!;
const applicationId = parseUuid('10000000-0000-4000-8000-000000000002')!;
const boundaryRequestId = parseUuid('10000000-0000-4000-8000-000000000003')!;
const missionStepId = parseUuid('10000000-0000-4000-8000-000000000004')!;
const extensionInstallId = parseUuid('10000000-0000-4000-8000-000000000005')!;
const triggerRequestId = parseUuid('10000000-0000-4000-8000-000000000006')!;
const boundaryId = parseUuid('10000000-0000-4000-8000-000000000007')!;
const manualRequestId = parseUuid('10000000-0000-4000-8000-000000000008')!;
const missionId = parseUuid('10000000-0000-4000-8000-000000000009')!;
const conversationId = parseUuid('10000000-0000-4000-8000-000000000010')!;
const verifiedAt = parseIsoDateTime('2026-08-12T10:01:20.000Z')!;
const timestamp = parseIsoDateTime('2026-08-12T10:02:00.000Z')!;
const postingFingerprint = parseSha256Digest(`sha256:${'a'.repeat(64)}`)!;

describe('T11 canonical Job and Application contract', () => {
  it('publishes closed identity and submission-state sets', () => {
    expect(CANONICAL_JOB_STATUSES).toEqual(['OPEN', 'CLOSED', 'UNKNOWN']);
    expect(APPLICATION_SUBMISSION_STATES).toEqual([
      'ELIGIBLE',
      'ARMED',
      'TRIGGERING_RISK',
      'TRIGGERED_LOCKED',
      'OUTCOME_UNKNOWN',
    ]);
    expect(APPLICATION_SUBMISSION_EVENT_TYPES).toEqual([
      'SUBMISSION_TRIGGERED',
      'USER_REPORTED_SUBMISSION',
    ]);
  });

  it('keeps the exact canonical Application and immutable bundle on every Mission', () => {
    const binding: CanonicalApplicationBinding = {
      canonicalJobId,
      canonicalJobStatus: 'OPEN',
      lastVerifiedAt: verifiedAt,
      applicationId,
      applicationBundleVersion: '3',
      applicationRevision: '7',
      submissionState: 'ELIGIBLE',
    };
    const mission: MissionSummary = {
      id: missionId,
      conversationId,
      revision: '9',
      status: 'EXECUTING',
      job: {
        jobId: 'source-listing-id',
        sourcePlatform: 'GREENHOUSE',
        atsProvider: 'GREENHOUSE',
        canonicalOrigin: 'https://boards.example.invalid',
        pathRuleId: 'greenhouse-application-v3',
        postingFingerprint,
      },
      application: binding,
      automationLevel: 'L2_CONFIRM_EACH_SUBMISSION',
      progress: { progressCode: 'EXECUTION_STARTED', completed: 3, total: 4, currentStepId: missionStepId },
      createdAt: timestamp,
      updatedAt: timestamp,
    };

    expect(binding).toMatchObject({
      applicationBundleVersion: '3',
      submissionState: 'ELIGIBLE',
    });
    expect(mission.job.jobId).toBe('source-listing-id');
    expect(mission.application).toBe(binding);
  });

  it('keeps boundary and event inputs opaque and separates extension trigger from user report', () => {
    const boundary: EnterSubmissionBoundaryRequest = {
      clientRequestId: boundaryRequestId,
      expectedMissionRevision: '9',
      missionStepId,
      stepAttempt: 1,
      applicationId,
      expectedApplicationRevision: '7',
      applicationBundleVersion: '3',
      extensionInstallId,
    };
    const triggered: RecordSubmissionEventRequest = {
      clientRequestId: triggerRequestId,
      eventType: 'SUBMISSION_TRIGGERED',
      applicationId: boundary.applicationId,
      expectedApplicationRevision: '8',
      applicationBundleVersion: boundary.applicationBundleVersion,
      boundaryId,
      attemptRevision: '1',
      extensionInstallId: boundary.extensionInstallId,
    };
    const manual: RecordSubmissionEventRequest = {
      clientRequestId: manualRequestId,
      eventType: 'USER_REPORTED_SUBMISSION',
      applicationId: boundary.applicationId,
      expectedApplicationRevision: '7',
      applicationBundleVersion: boundary.applicationBundleVersion,
    };
    const manualWithBoundary = { ...manual, boundaryId };
    // @ts-expect-error manual reports cannot forge an extension boundary.
    const invalidManual: RecordSubmissionEventRequest = manualWithBoundary;
    const boundaryWithEvidence = { ...boundary, confirmationUrl: 'https://provider.invalid/success' };
    // @ts-expect-error CAP-AF-064 evidence is outside the boundary contract.
    const invalidBoundary: EnterSubmissionBoundaryRequest = boundaryWithEvidence;

    expect(triggered.eventType).toBe('SUBMISSION_TRIGGERED');
    expect(manual.eventType).toBe('USER_REPORTED_SUBMISSION');
    expect('boundaryId' in manual).toBe(false);
    expect(invalidManual.eventType).toBe('USER_REPORTED_SUBMISSION');
    expect(invalidBoundary.confirmationUrl).toContain('provider.invalid');
  });

  it('publishes the four mutually exclusive VALIDATE_JOB errors everywhere', () => {
    const codes = [
      'JOB_EXPIRED',
      'JOB_IDENTITY_AMBIGUOUS',
      'APPLICATION_ALREADY_SUBMITTED',
      'APPLICATION_SUBMISSION_OUTCOME_UNKNOWN',
    ] as const;

    for (const code of codes) {
      expect(AGENT_ERROR_DEFINITIONS).toHaveProperty(code);
      expect(MISSION_STEP_ERROR_CODES).toContain(code);
      expect(AGENT_ENDPOINT_ERROR_CODES.createMission).toContain(code);
      expect(AGENT_ENDPOINT_ERROR_CODES.issueExecutionIntent).toContain(code);
      expect(AGENT_ENDPOINT_ERROR_CODES.claimExecutionIntent).toContain(code);
    }
    expect(VALIDATE_JOB_FIRST_MATCH_RESULT_CODES).toEqual([
      'JOB_IDENTITY_AMBIGUOUS',
      'JOB_UNAVAILABLE',
      'APPLICATION_SUBMISSION_OUTCOME_UNKNOWN',
      'APPLICATION_ALREADY_SUBMITTED',
      'JOB_EXPIRED',
      'JOB_UNAVAILABLE',
    ]);
    expect(AGENT_ERROR_DEFINITIONS.JOB_EXPIRED).toMatchObject({
      statusCode: 410,
      retryable: false,
      recommendedAction: 'REFRESH_RESOURCE',
    });
    expect(AGENT_ERROR_DEFINITIONS.APPLICATION_SUBMISSION_OUTCOME_UNKNOWN).toMatchObject({
      statusCode: 409,
      retryable: false,
      recommendedAction: 'REVIEW_MISSION',
    });
  });

  it('publishes every durable Mission-create failure on the create endpoint', () => {
    const codes = [
      'MISSION_IDEMPOTENCY_CONFLICT',
      'MISSION_STATE_CONFLICT',
      'RESUME_VERSION_STALE',
      'PROFILE_REVISION_MISMATCH',
      'PROFILE_DELETION_EPOCH_MISMATCH',
    ] as const;

    for (const code of codes) {
      expect(AGENT_ENDPOINT_ERROR_CODES.createMission).toContain(code);
    }
  });

  it('publishes canonical issue-time plan drift on the issue endpoint', () => {
    expect(AGENT_ENDPOINT_ERROR_CODES.issueExecutionIntent).toContain(
      'EXECUTION_PLAN_MISMATCH',
    );
  });

  it('keeps the approved sensitive-release continuation edge in the mirror', () => {
    expect(MISSION_STATUS_TRANSITIONS.WAITING_FOR_USER).toContain('READY_TO_EXECUTE');
  });

  it('registers durable boundary and submission-event endpoints', () => {
    expect(AGENT_ENDPOINTS.createMission).toMatchObject({
      method: 'POST',
      path: '/api/v1/agent/missions',
      sourceSection: '4.3',
      successStatuses: [201, 200],
    });
    expect(AGENT_ENDPOINTS.enterSubmissionBoundary).toMatchObject({
      method: 'POST',
      path: '/api/v1/agent/missions/:missionId/submission-boundaries',
      sourceSection: '4.6',
      callerConstraint: 'owner-bearer+exact-official-extension-origin',
      successStatuses: [201, 200],
    });
    expect(AGENT_ENDPOINTS.recordSubmissionEvent).toMatchObject({
      method: 'POST',
      path: '/api/v1/agent/missions/:missionId/submission-events',
      sourceSection: '4.7',
      successStatuses: [201, 200],
    });
    expect(AGENT_ENDPOINT_ERROR_CODES.enterSubmissionBoundary).toContain(
      'APPLICATION_SUBMISSION_OUTCOME_UNKNOWN',
    );
    expect(AGENT_ENDPOINT_ERROR_CODES.recordSubmissionEvent).toContain(
      'APPLICATION_ALREADY_SUBMITTED',
    );
    expect(AGENT_ENDPOINT_ERROR_CODES.recordSubmissionEvent).toContain(
      'EXECUTION_LEASE_EXPIRED',
    );
    expect(AGENT_ENDPOINT_ERROR_CODES.recordMissionApproval).toEqual(
      expect.arrayContaining([
        'PROFILE_REVISION_MISMATCH',
        'PROFILE_DELETION_EPOCH_MISMATCH',
      ]),
    );
  });
});
