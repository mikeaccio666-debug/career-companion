import { describe, expect, it } from 'vitest';

import {
  ACTION_ENDPOINT_IDS,
  AGENT_ENDPOINTS,
  AGENT_ENDPOINT_ERROR_CODES,
  AGENT_ERROR_DEFINITIONS,
  AUTH_SESSION_ENDPOINTS,
  AUTH_SESSION_ENDPOINT_ERROR_CODES,
  BEARER_SUBJECT_OWNER_ADMISSION_ERROR_CODES,
  COMMON_PRIVATE_ERROR_CODES,
  GENERATION_LOCALES,
  MISSION_STATUS_TRANSITIONS,
  MISSION_TERMINAL_STATUSES,
  MESSAGE_SSE_ERROR_CODES,
  type AgentEndpointId,
  type AgentErrorEnvelope,
  type ActionCardView,
  type CreateConversationRequest,
  type ConversationDetailView,
  type ConversationSummaryView,
  type DecideConversationActionRequest,
  type ListConversationsQuery,
  type UpdateConversationRequest,
  type CreateMissionRequest,
  type ExecutionIntentClaims,
  type IssueExecutionIntentRequest,
  type MessageSseFrame,
  type JobCardView,
  type PersistedMessagePart,
  type SendConversationMessageRequest,
  type TextMessagePart,
  type SubmitApplicationReceiptRequest,
  parseBase64Url43,
  parseIsoDateTime,
  parseIsoCountryCode,
  parseCanonicalBcp47Locale,
  parseLocalDate,
  parseSha256Digest,
  parseUuid,
  isMessageSseFrameIdConsistent,
} from '../src/index.ts';

const uuid = parseUuid('70f57443-ebd2-44ea-b08b-d20fab20aa41')!;
const digest = parseSha256Digest(`sha256:${'a'.repeat(64)}`)!;
const executionJti = parseBase64Url43('A'.repeat(43))!;
const time = parseIsoDateTime('2026-08-13T00:00:00Z')!;

describe('HTTP endpoint mirror', () => {
  it('brands only valid hostile-boundary primitives', () => {
    expect(parseUuid('uuid')).toBeNull();
    expect(parseSha256Digest('sha256:abc')).toBeNull();
    expect(parseSha256Digest(`sha256:${'A'.repeat(64)}`)).toBeNull();
    expect(parseIsoDateTime('yesterday')).toBeNull();
    expect(parseIsoDateTime('2026-08-13T00:00:00-07:00')).toBeNull();
    expect(parseIsoDateTime('2026-08-13 00:00:00Z')).toBeNull();
    expect(parseIsoDateTime('2026-02-30T00:00:00Z')).toBeNull();
    expect(parseIsoDateTime('2026-08-13T00:00:00Z')).not.toBeNull();
    expect(parseLocalDate('2026-02-29')).toBeNull();
    expect(parseLocalDate('2024-02-29')).toBe('2024-02-29');
    expect(uuid).not.toBeNull();
    expect(digest).not.toBeNull();
  });

  it('keeps SSE frame ids equal to the data event sequence', () => {
    const data = {
      schemaVersion: 1 as const, eventSequence: '4' as const, streamId: uuid, conversationId: uuid,
      turnId: uuid, occurredAt: time, messageId: uuid, partId: uuid, partIndex: 0, delta: '...',
    };
    expect(isMessageSseFrameIdConsistent({ id: '4', event: 'message.delta', data })).toBe(true);
    expect(isMessageSseFrameIdConsistent({ id: '5', event: 'message.delta', data })).toBe(false);
  });

  it('pins the reviewed endpoint set and source sections', () => {
    // 125：2026-09-18 加了 §4.3 `missions/page-context`。「生成申请卡片」原来打的
    // `jobs/from-url` 在 argoland 里没有控制器、生产 404，改指这一条（见 http.ts 的头注）。
    // 127：2026-09-21 加了 §4.13 `resume-attachments/plan` 与 `resume-attachments`
    // （把简历作为附件交给雇主，argoland #514/#534）。
    // 128：2026-09-21 深夜加了 §4.18 `application-question-drafts`（AI 起草开放题，argoland #543）。
    // 129：2026-09-21 下午加了 resume-attachments/prepared（这一页有没有为它准备好的简历，argoland #552）。
    // 130：2026-09-23 加了 Full AI v1 `full-ai-autofill/plan`（「AI 代答」：规则答不了的题按用户自己的资料起草，
    // argoland 已上线的端点，本仓照抄登记）。
    // 132：2026-09-24 加了 `full-ai-autofill/revise`（用户按「生成」逐题写／改写）与 `full-ai-autofill/quota`
    // （这个月的 AI 次数），照 argoland 的 http.ts 登记。
    // 137：2026-09-24 浮层任务接线（argoland §4.15）：删掉本仓自拟、后端从没实现的 GET page-binding 与
    // GET resume-file，加上 POST page-binding、start-approvals 与任务材料的五个端点（132 − 2 + 7）。
    // 138：同日加了 `full-ai-autofill/plan/stream`（argoland #620：同一次规划按 NDJSON 一行一行回来）。
    // 142：2026-09-27 加了按页面附求职信的四条（argoland #653：lookup、prepare、text、pdf）。
    expect(Object.keys(AGENT_ENDPOINTS)).toHaveLength(142); // Includes Assistant jobs/ATS and Admin subscription refund routes (§§5.30–5.31).
    for (const [name, path, kind] of [
      ['lookupCoverLetterAttachment', 'lookup', 'json'],
      ['prepareCoverLetterAttachment', 'prepare', 'json'],
      ['releaseCoverLetterAttachmentText', 'text', 'json'],
      ['releaseCoverLetterAttachmentPdf', 'pdf', 'binary'],
    ] as const) {
      expect(AGENT_ENDPOINTS[name]).toMatchObject({
        method: 'POST', path: `/api/v1/agent/cover-letter-attachments/${path}`, sourceSection: '4.14',
        auth: 'bearer', responseKind: kind, successStatuses: [200],
      });
    }
    expect(AGENT_ENDPOINT_ERROR_CODES.releaseCoverLetterAttachmentPdf).toContain('COVER_LETTER_NOT_FOUND');
    expect(AGENT_ENDPOINT_ERROR_CODES.prepareCoverLetterAttachment).toContain('PAYWALL_REQUIRED');
    expect(AGENT_ENDPOINTS.planFullAiAutofill).toMatchObject({
      method: 'POST', path: '/api/v1/agent/full-ai-autofill/plan', sourceSection: 'Full AI v1',
      auth: 'bearer', responseKind: 'json', successStatuses: [200], responseCache: 'private,no-store',
    });
    expect(AGENT_ENDPOINTS.streamFullAiAutofillPlan).toMatchObject({
      method: 'POST', path: '/api/v1/agent/full-ai-autofill/plan/stream', sourceSection: 'Full AI v1',
      auth: 'bearer', responseKind: 'ndjson', successStatuses: [200], responseCache: 'private,no-store',
    });
    expect(AGENT_ENDPOINT_ERROR_CODES.streamFullAiAutofillPlan).toEqual(AGENT_ENDPOINT_ERROR_CODES.planFullAiAutofill);
    expect(AGENT_ENDPOINTS.reviseFullAiAutofill).toMatchObject({
      method: 'POST', path: '/api/v1/agent/full-ai-autofill/revise', sourceSection: 'Full AI v1',
      auth: 'bearer', responseKind: 'json', successStatuses: [200], responseCache: 'private,no-store',
    });
    expect(AGENT_ENDPOINTS.getFullAiAutofillQuota).toMatchObject({
      method: 'GET', path: '/api/v1/agent/full-ai-autofill/quota', sourceSection: 'Full AI v1',
      auth: 'bearer', responseKind: 'json', successStatuses: [200], responseCache: 'private,no-store',
    });
    expect(AGENT_ENDPOINTS.getRolePreferences).toMatchObject({ method: 'GET',
      path: '/api/v1/agent/conversations/:conversationId/job-preferences', sourceSection: '3.1',
      auth: 'bearer', responseKind: 'json' });
    expect(AGENT_ENDPOINTS.updateRolePreferences).toMatchObject({ method: 'PATCH',
      path: '/api/v1/agent/conversations/:conversationId/job-preferences', sourceSection: '3.1',
      auth: 'bearer', responseKind: 'json' });
    expect(AGENT_ENDPOINTS.refreshRecommendationBatch).toMatchObject({ method: 'POST',
      path: '/api/v1/agent/recommendation-batches/refresh', sourceSection: '3.4',
      auth: 'bearer', successStatuses: [202], responseCache: 'private,no-store' });
    expect(AGENT_ENDPOINTS.startApplicationPreparations).toMatchObject({ method: 'POST',
      path: '/api/v1/agent/recommendation-batches/:batchId/preparations', sourceSection: '3.4',
      auth: 'bearer', successStatuses: [202], responseCache: 'private,no-store' });
    expect(AGENT_ENDPOINTS.getLearningRecommendationsV2).toMatchObject({
      method: 'POST', path: '/api/v1/agent/learning/recommendations-v2',
      sourceSection: '5.19.1', auth: 'bearer', responseKind: 'json',
      callerConstraint: 'owner-bearer+current-v2-report-snapshot+feature-default-off',
      successStatuses: [200], responseCache: 'private,no-store',
    });
    expect(AGENT_ENDPOINTS.getCoverLetterRequirement).toMatchObject({
      method: 'POST', path: '/api/v1/agent/cover-letter/requirement',
      sourceSection: '4.14', auth: 'bearer', responseKind: 'json',
    });
    expect(AGENT_ENDPOINTS.generateCoverLetterCandidate).toMatchObject({
      method: 'POST', path: '/api/v1/agent/cover-letter/generate',
      sourceSection: '4.14', auth: 'bearer', responseKind: 'json',
    });
    expect(AGENT_ENDPOINTS.readResumePdf).toMatchObject({
      method: 'POST', path: '/api/v1/agent/resume-versions/:resumeVersionId/pdf',
      sourceSection: '4.13', auth: 'bearer', responseKind: 'binary',
    });
    expect(AGENT_ENDPOINTS.classifyPilotUa2).toEqual({
      method: 'POST',
      path: '/api/v1/agent/pilot/ua2/classify',
      sourceSection: '5.18',
      auth: 'bearer',
      responseKind: 'json',
      callerConstraint: 'owner-bearer+website-entitlement+user-exact-page',
      successStatuses: [200],
      responseCache: 'private,no-store',
    });
    expect(AGENT_ENDPOINTS.composePilotUa5).toEqual({
      method: 'POST',
      path: '/api/v1/agent/pilot/ua5/compose',
      sourceSection: '5.23',
      auth: 'bearer',
      responseKind: 'json',
      callerConstraint: 'owner-bearer+website-entitlement+user-exact-page',
      successStatuses: [200],
      responseCache: 'private,no-store',
    });
    expect(AGENT_ENDPOINTS.checkPilotUa5ProfileCurrentness).toMatchObject({ method: 'POST',
      path: '/api/v1/agent/pilot/ua5/profile-currentness', sourceSection: '5.24', auth: 'bearer', responseCache: 'private,no-store' });
    expect(AGENT_ENDPOINTS.resolvePilotUa5ProfilePayloads).toEqual({
      method: 'POST',
      path: '/api/v1/agent/pilot/ua5/profile-payloads',
      sourceSection: '5.24',
      auth: 'bearer',
      responseKind: 'json',
      callerConstraint: 'owner-bearer+website-entitlement+user-exact-page+connected-dev-only',
      successStatuses: [200],
      responseCache: 'private,no-store',
    });
    expect(AGENT_ENDPOINTS.completeMentorReferralRequest).toMatchObject({
      method: 'PATCH',
      path: '/api/v1/agent/mentor/referral-requests/:referralRequestId/completion',
      sourceSection: '6.5',
    });
    expect(AGENT_ENDPOINTS.selectStudentReferralGuaranteeRemedy).toMatchObject({
      method: 'PATCH',
      path: '/api/v1/agent/referral-requests/:referralRequestId/guarantee-remedy',
      sourceSection: '6.5',
    });
    expect(AGENT_ENDPOINTS.executeAdminReferralRefund).toMatchObject({
      method: 'POST',
      path: '/api/v1/agent/admin/referral-requests/:referralRequestId/refund',
      sourceSection: '6.6',
    });
    expect(AGENT_ENDPOINTS.reconcileAdminReferralRefund).toMatchObject({
      method: 'POST',
      path: '/api/v1/agent/admin/referral-requests/:referralRequestId/refund/reconcile',
      sourceSection: '6.6',
    });
    expect(AGENT_ENDPOINTS.updateAdminReferralOutcome).toMatchObject({
      method: 'PATCH',
      path: '/api/v1/agent/admin/referral-requests/:referralRequestId/outcome',
      sourceSection: '6.7',
      auth: 'bearer',
    });
    // 14 existing Auth/session endpoints + 7 T20/T22 waitlist, invitation,
    // restricted-context and ADMIN operations.
    expect(Object.keys(AUTH_SESSION_ENDPOINTS)).toHaveLength(21);
    expect(Object.keys(AUTH_SESSION_ENDPOINT_ERROR_CODES)).toEqual(Object.keys(AUTH_SESSION_ENDPOINTS));
    expect(AUTH_SESSION_ENDPOINTS.csrf).toMatchObject({
      method: 'GET', path: '/auth/csrf', sourceSection: '2.1', auth: 'public',
    });
    expect(AUTH_SESSION_ENDPOINTS.refresh).toMatchObject({
      method: 'POST', path: '/auth/refresh', sourceSection: '2.1', auth: 'public',
    });
    expect(AUTH_SESSION_ENDPOINTS.logout).toMatchObject({
      method: 'POST', path: '/auth/logout', sourceSection: '2.1', auth: 'public',
    });
    expect(AUTH_SESSION_ENDPOINTS.introspectSession).toMatchObject({
      method: 'POST',
      path: '/internal/auth/sessions/introspect',
      sourceSection: '2.2',
      auth: 'service-bearer',
    });
    expect(AUTH_SESSION_ENDPOINTS.revokeSession).toMatchObject({
      method: 'POST',
      path: '/internal/auth/sessions/revoke',
      sourceSection: '2.2',
      auth: 'service-bearer',
    });
    expect(AUTH_SESSION_ENDPOINTS.attestExtensionInstall).toMatchObject({
      method: 'POST',
      path: '/api/v1/agent/extension-installs/status',
      sourceSection: '2.3',
      auth: 'bearer',
      callerConstraint: 'owner-bearer',
      successStatuses: [200],
    });
    expect(AGENT_ENDPOINTS.listConversations).toMatchObject({
      method: 'GET', path: '/api/v1/agent/conversations', sourceSection: '3.1',
    });
    expect(AGENT_ENDPOINTS.updateConversation).toMatchObject({
      method: 'PATCH', path: '/api/v1/agent/conversations/:conversationId', sourceSection: '3.1',
    });
    expect(AGENT_ENDPOINTS.decideRecommendationBatch.sourceSection).toBe('3.4');
    expect(AGENT_ENDPOINTS.getRecommendationItemDetail).toMatchObject({
      method: 'GET',
      path: '/api/v1/agent/recommendation-batches/:batchId/items/:itemId',
      sourceSection: '3.4',
      auth: 'bearer',
      responseKind: 'json',
      callerConstraint: 'owner-bearer+owned-recommendation-item+current-canonical-job',
      successStatuses: [200],
      responseCache: 'private,no-store',
    });
    expect(AGENT_ENDPOINTS.getDailyReportPreference).toMatchObject({
      method: 'GET', path: '/api/v1/agent/preferences/daily-report', sourceSection: '3.7',
    });
    expect(AGENT_ENDPOINTS.updateDailyReportPreference).toMatchObject({
      method: 'PATCH', path: '/api/v1/agent/preferences/daily-report', sourceSection: '3.7',
    });
    expect(AGENT_ENDPOINTS.getDailyReportEmailPreference).toMatchObject({
      method: 'GET', path: '/api/v1/agent/preferences/daily-report-email', sourceSection: '3.7',
      auth: 'bearer', responseKind: 'json',
    });
    expect(AGENT_ENDPOINTS.updateDailyReportEmailPreference).toMatchObject({
      method: 'PATCH', path: '/api/v1/agent/preferences/daily-report-email', sourceSection: '3.7',
      auth: 'bearer', responseKind: 'json',
    });
    expect(AGENT_ENDPOINTS.listUnreadDailyReports).toMatchObject({
      method: 'GET', path: '/api/v1/agent/daily-reports/unread', sourceSection: '3.7',
    });
    expect(AGENT_ENDPOINTS.recordDailyReportRead).toMatchObject({
      method: 'POST', path: '/api/v1/agent/daily-reports/:reportId/read', sourceSection: '3.7',
    });
    expect(AGENT_ENDPOINTS.getExecutionIntentJwks.sourceSection).toBe('5.2');
    expect(AGENT_ENDPOINTS.issueExecutionIntent).toMatchObject({
      sourceSection: '5.4',
      successStatuses: [201],
    });
    expect(AGENT_ENDPOINTS.claimExecutionIntent).toMatchObject({
      sourceSection: '5.6',
      successStatuses: [200],
    });
    expect(AGENT_ENDPOINTS.createJobResumeGeneration).toMatchObject({
      method: 'POST',
      path: '/api/v1/agent/resume-generations',
      sourceSection: '4.12',
      auth: 'bearer',
      successStatuses: [201],
    });
    expect(AGENT_ENDPOINTS.submitApplicationReceipt).toMatchObject({
      sourceSection: '5.7',
      successStatuses: [201, 200],
    });
    expect(AGENT_ENDPOINTS.enterSubmissionBoundary).toMatchObject({
      sourceSection: '4.6',
      successStatuses: [201, 200],
    });
    expect(AGENT_ENDPOINTS.recordSubmissionEvent).toMatchObject({
      sourceSection: '4.7',
      successStatuses: [201, 200],
    });
    expect(AGENT_ENDPOINTS.getApplicationProfile).toMatchObject({
      method: 'GET', path: '/api/v1/agent/application-profile', sourceSection: '5.8',
    });
    expect(AGENT_ENDPOINTS.ingestTrustTelemetryEvent).toMatchObject({
      method: 'POST', path: '/api/v1/agent/trust-telemetry/events', sourceSection: '5.15',
    });
    expect(AGENT_ENDPOINTS.deleteTrustTelemetryIdentity).toMatchObject({
      method: 'POST', path: '/api/v1/agent/trust-telemetry/deletions', sourceSection: '5.15',
    });
    expect(AGENT_ENDPOINTS.computeGapStrength).toMatchObject({
      method: 'POST',
      path: '/api/v1/agent/planner/gap-strength/compute',
      sourceSection: '5.17',
      callerConstraint: 'owner-bearer',
      successStatuses: [200],
      responseCache: 'private,no-store',
    });
    expect(AGENT_ENDPOINTS.computeGapAnalysisV2).toMatchObject({
      method: 'POST',
      path: '/api/v1/agent/planner/gap-analysis-v2/compute',
      sourceSection: '5.17.1',
      callerConstraint: 'owner-bearer',
      successStatuses: [200],
      responseCache: 'private,no-store',
    });
    expect(AGENT_ENDPOINTS.getLatestGapStrength).toMatchObject({
      method: 'POST',
      path: '/api/v1/agent/planner/gap-strength/latest',
      sourceSection: '5.17',
      callerConstraint: 'owner-bearer',
      successStatuses: [200],
      responseCache: 'private,no-store',
    });
    expect(AGENT_ENDPOINTS.getLearningRecommendations).toMatchObject({
      method: 'POST',
      path: '/api/v1/agent/learning/recommendations',
      sourceSection: '5.19',
      callerConstraint: 'owner-bearer+latest-gap-report+feature-default-off',
      successStatuses: [200],
      responseCache: 'private,no-store',
    });
    expect(AGENT_ENDPOINTS.getProfileStrengths).toMatchObject({
      method: 'GET',
      path: '/api/v1/agent/planner/profile-strengths',
      sourceSection: '5.17',
    });
    expect(AGENT_ENDPOINTS.saveProfileStrength).toMatchObject({
      method: 'POST',
      path: '/api/v1/agent/planner/profile-strengths/save',
      sourceSection: '5.17',
    });
    expect(AGENT_ENDPOINTS.removeProfileStrength).toMatchObject({
      method: 'POST',
      path: '/api/v1/agent/planner/profile-strengths/remove',
      sourceSection: '5.17',
    });
    expect(AGENT_ENDPOINTS.listApplicationLedger).toMatchObject({
      method: 'GET', path: '/api/v1/agent/application-ledger', sourceSection: '5.10',
    });
    expect(AGENT_ENDPOINTS.updatePrimaryTimeZone).toMatchObject({
      method: 'PATCH',
      path: '/api/v1/agent/account-preferences/primary-time-zone',
      sourceSection: '5.11',
    });
    expect(AGENT_ENDPOINTS.createSensitiveWriteConfirmation).toMatchObject({
      method: 'POST',
      path: '/api/v1/agent/missions/:missionId/sensitive-write-confirmations',
      sourceSection: '5.9.4',
      callerConstraint: 'owner-bearer+exact-official-extension-origin',
      successStatuses: [201, 200],
    });
    expect(AGENT_ENDPOINTS.decideSensitiveWriteConfirmation).toMatchObject({
      sourceSection: '5.9.5',
      callerConstraint: 'owner-bearer+exact-official-extension-origin+decision-token',
      successStatuses: [201, 200],
    });
    expect(AGENT_ENDPOINTS.fetchSensitiveExecutionMaterial).toMatchObject({
      path: '/api/v1/agent/execution-intents/sensitive-material',
      sourceSection: '5.9.7',
      successStatuses: [200],
      responseCache: {
        responseHeaders: {
          'Cache-Control': 'private, no-store, no-transform',
          Pragma: 'no-cache',
          Expires: '0',
        },
        etag: 'forbidden',
      },
    });
  });

  it('keeps every endpoint error allowlist inside the stable closure', () => {
    const knownCodes = new Set(Object.keys(AGENT_ERROR_DEFINITIONS));
    for (const endpointId of Object.keys(AGENT_ENDPOINTS) as AgentEndpointId[]) {
      expect(AGENT_ENDPOINT_ERROR_CODES[endpointId].length).toBeGreaterThan(0);
      expect(new Set(AGENT_ENDPOINT_ERROR_CODES[endpointId]).size).toBe(
        AGENT_ENDPOINT_ERROR_CODES[endpointId].length,
      );
      for (const code of AGENT_ENDPOINT_ERROR_CODES[endpointId]) expect(knownCodes.has(code)).toBe(true);
      if (AGENT_ENDPOINTS[endpointId].auth === 'bearer') {
        expect(AGENT_ENDPOINT_ERROR_CODES[endpointId]).toContain('AGENT_UNAVAILABLE');
      }
    }
    for (const endpointId of Object.keys(AUTH_SESSION_ENDPOINTS) as Array<
      keyof typeof AUTH_SESSION_ENDPOINTS
    >) {
      expect(new Set(AUTH_SESSION_ENDPOINT_ERROR_CODES[endpointId]).size).toBe(
        AUTH_SESSION_ENDPOINT_ERROR_CODES[endpointId].length,
      );
      for (const code of AUTH_SESSION_ENDPOINT_ERROR_CODES[endpointId]) {
        expect(knownCodes.has(code)).toBe(true);
      }
      if (AUTH_SESSION_ENDPOINTS[endpointId].auth === 'bearer') {
        expect(AUTH_SESSION_ENDPOINT_ERROR_CODES[endpointId]).toContain('AGENT_UNAVAILABLE');
      }
    }
    expect(COMMON_PRIVATE_ERROR_CODES).toEqual([
      'VALIDATION_FAILED', 'LOGIN_REQUIRED', 'ACCOUNT_UNAVAILABLE', 'RATE_LIMITED',
      'AGENT_UNAVAILABLE', 'INTERNAL_ERROR',
    ]);
    expect(BEARER_SUBJECT_OWNER_ADMISSION_ERROR_CODES).toEqual([
      'LOGIN_REQUIRED',
      'ACCOUNT_UNAVAILABLE',
      'AGENT_UNAVAILABLE',
    ]);
    expect(AGENT_ENDPOINT_ERROR_CODES.getAgentSession).toEqual(COMMON_PRIVATE_ERROR_CODES);
    expect(AUTH_SESSION_ENDPOINT_ERROR_CODES.csrf).toEqual([
      'AUTH_CSRF_INVALID', 'RATE_LIMITED', 'INTERNAL_ERROR',
    ]);
    expect(AUTH_SESSION_ENDPOINT_ERROR_CODES.refresh).toEqual([
      'VALIDATION_FAILED', 'AUTH_CSRF_INVALID', 'AUTH_REFRESH_INVALID', 'ACCOUNT_UNAVAILABLE',
      'RATE_LIMITED', 'AGENT_UNAVAILABLE', 'INTERNAL_ERROR',
    ]);
    expect(AUTH_SESSION_ENDPOINT_ERROR_CODES.introspectSession).toEqual([
      'VALIDATION_FAILED', 'LOGIN_REQUIRED', 'AUTH_REFRESH_INVALID', 'ACCOUNT_UNAVAILABLE',
      'RATE_LIMITED', 'AGENT_UNAVAILABLE', 'INTERNAL_ERROR',
    ]);
    expect(AGENT_ENDPOINT_ERROR_CODES.createConversation).toContain('CONVERSATION_ROLE_CONFLICT');
    for (const endpoint of [
      'createConversation',
      'listConversations',
      'getConversation',
      'updateConversation',
      'listConversationMessages',
      'getConversationMessage',
      'sendConversationMessage',
      'decideConversationAction',
      'listResumeSelectionOptions',
      'getResumeLibrary',
      'createReferralRequest',
      'getReferralRequest',
      'computeGapStrength',
      'getProfileStrengths',
    ] as const) {
      expect(AGENT_ENDPOINT_ERROR_CODES[endpoint]).toContain('PAYWALL_REQUIRED');
    }
    expect(AGENT_ENDPOINT_ERROR_CODES.listRecommendationBatches).toContain('CONVERSATION_NOT_FOUND');
    expect(AGENT_ENDPOINT_ERROR_CODES.listRecommendationBatches).toContain('AGENT_UNAVAILABLE');
    expect(AGENT_ENDPOINT_ERROR_CODES.getRecommendationBatch).toContain('AGENT_UNAVAILABLE');
    expect(AGENT_ENDPOINT_ERROR_CODES.getRecommendationItemDetail).toEqual([
      ...COMMON_PRIVATE_ERROR_CODES,
      'RECOMMENDATION_BATCH_NOT_FOUND',
      'JOB_UNAVAILABLE',
      'JOB_EXPIRED',
      'JOB_IDENTITY_AMBIGUOUS',
    ]);
    expect(AGENT_ENDPOINT_ERROR_CODES.getDailyReportPreference).toEqual(COMMON_PRIVATE_ERROR_CODES);
    expect(AGENT_ENDPOINT_ERROR_CODES.updateDailyReportPreference).toEqual([
      ...COMMON_PRIVATE_ERROR_CODES, 'DAILY_REPORT_PREFERENCE_CONFLICT',
    ]);
    expect(AGENT_ENDPOINT_ERROR_CODES.getDailyReportEmailPreference).toEqual(
      COMMON_PRIVATE_ERROR_CODES,
    );
    expect(AGENT_ENDPOINT_ERROR_CODES.updateDailyReportEmailPreference).toEqual(
      COMMON_PRIVATE_ERROR_CODES,
    );
    expect(AGENT_ENDPOINT_ERROR_CODES.listUnreadDailyReports).toEqual(COMMON_PRIVATE_ERROR_CODES);
    expect(AGENT_ENDPOINT_ERROR_CODES.recordDailyReportRead).toEqual([
      ...COMMON_PRIVATE_ERROR_CODES, 'DAILY_REPORT_NOT_FOUND',
    ]);
    expect(AGENT_ENDPOINT_ERROR_CODES.sendConversationMessage).toContain('JOB_UNAVAILABLE');
    expect(AGENT_ENDPOINT_ERROR_CODES.decideRecommendationBatch).not.toContain('JOB_UNAVAILABLE');
    expect(AGENT_ENDPOINT_ERROR_CODES.issueExecutionIntent).toContain('EXECUTION_CLIENT_UPGRADE_REQUIRED');
    expect(AGENT_ENDPOINT_ERROR_CODES.issueExecutionIntent).toContain('SENSITIVE_WRITE_RELEASE_EXPIRED');
    expect(AGENT_ENDPOINT_ERROR_CODES.claimExecutionIntent).toContain('SENSITIVE_WRITE_RELEASE_STALE');
    expect(AGENT_ENDPOINT_ERROR_CODES.submitApplicationReceipt).toContain(
      'SENSITIVE_WRITE_RELEASE_STATE_CONFLICT',
    );
    expect(AGENT_ENDPOINT_ERROR_CODES.fetchSensitiveExecutionMaterial).toContain(
      'SENSITIVE_EXECUTION_MATERIAL_SCOPE_MISMATCH',
    );
    expect(AGENT_ENDPOINT_ERROR_CODES.listApplicationLedger).toEqual(COMMON_PRIVATE_ERROR_CODES);
    expect(AGENT_ENDPOINT_ERROR_CODES.updatePrimaryTimeZone).toEqual(COMMON_PRIVATE_ERROR_CODES);
    expect(AGENT_ENDPOINT_ERROR_CODES.createSensitiveWriteConfirmation).toEqual([
      ...COMMON_PRIVATE_ERROR_CODES,
      'MISSION_NOT_FOUND',
      'MISSION_STEP_NOT_FOUND',
      'RECEIPT_IDEMPOTENCY_CONFLICT',
      'RECEIPT_INTENT_NOT_CLAIMED',
      'RECEIPT_SCOPE_MISMATCH',
      'RECEIPT_VERIFICATION_FAILED',
      'EXECUTION_CLIENT_UPGRADE_REQUIRED',
      'EXECUTION_POLICY_CHANGED',
      'EXECUTION_LEASE_EXPIRED',
      'EXTENSION_INSTALL_MISMATCH',
      'MISSION_STATE_CONFLICT',
    ]);
    expect(AGENT_ENDPOINT_ERROR_CODES.decideSensitiveWriteConfirmation).toEqual([
      ...COMMON_PRIVATE_ERROR_CODES,
      'MISSION_NOT_FOUND',
      'SENSITIVE_WRITE_CONFIRMATION_NOT_FOUND',
      'SENSITIVE_WRITE_RELEASE_STATE_CONFLICT',
      'SENSITIVE_WRITE_RELEASE_IDEMPOTENCY_CONFLICT',
      'SENSITIVE_WRITE_RELEASE_STALE',
      'SENSITIVE_WRITE_RELEASE_EXPIRED',
      'EXECUTION_CLIENT_UPGRADE_REQUIRED',
      'EXECUTION_POLICY_CHANGED',
      'EXTENSION_INSTALL_MISMATCH',
    ]);
    expect(AGENT_ENDPOINT_ERROR_CODES.fetchSensitiveExecutionMaterial).toEqual([
      ...COMMON_PRIVATE_ERROR_CODES,
      'EXECUTION_CLIENT_UPGRADE_REQUIRED',
      'SENSITIVE_WRITE_RELEASE_NOT_FOUND',
      'SENSITIVE_WRITE_RELEASE_STATE_CONFLICT',
      'SENSITIVE_WRITE_RELEASE_STALE',
      'SENSITIVE_WRITE_RELEASE_EXPIRED',
      'SENSITIVE_EXECUTION_MATERIAL_UNAVAILABLE',
      'SENSITIVE_EXECUTION_MATERIAL_SCOPE_MISMATCH',
      'EXECUTION_POLICY_CHANGED',
      'EXECUTION_LEASE_EXPIRED',
      'EXTENSION_INSTALL_MISMATCH',
      'MISSION_NOT_FOUND',
      'MISSION_STEP_NOT_FOUND',
    ]);
  });

  it('keeps JobCard scoreScale fixed at 100', () => {
    const fixed: JobCardView['qualification']['scoreScale'] = 100;
    // @ts-expect-error source contract fixes scoreScale at 100 even when score is null.
    const invalid: JobCardView['qualification']['scoreScale'] = null;
    expect(fixed).toBe(100);
    expect(invalid).toBeNull();
  });

  // 2026-10-03 照 argoland 同步（权威 src/career-team/contracts/common.ts，#673／#674 准备恢复、#670 职位描述变了、
  // #712 简历导入）：九个码逐项与权威相同。插件的各端点错误码白名单没加它们，所以收到时的行为不变。
  it('mirrors the authority definitions of the preparation, job-description and profile-import codes', () => {
    const definition = (statusCode: number, retryable: boolean, requiresUserAction: boolean, recommendedAction: string) =>
      ({ statusCode, retryable, requiresUserAction, recommendedAction });
    expect({
      PREPARATION_RETRY_EXHAUSTED: AGENT_ERROR_DEFINITIONS.PREPARATION_RETRY_EXHAUSTED,
      PREPARATION_RECOVERY_CONFLICT: AGENT_ERROR_DEFINITIONS.PREPARATION_RECOVERY_CONFLICT,
      PREPARATION_CHECKPOINT_EXPIRED: AGENT_ERROR_DEFINITIONS.PREPARATION_CHECKPOINT_EXPIRED,
      PREPARATION_MATERIAL_UNAVAILABLE: AGENT_ERROR_DEFINITIONS.PREPARATION_MATERIAL_UNAVAILABLE,
      JOB_DESCRIPTION_CHANGED: AGENT_ERROR_DEFINITIONS.JOB_DESCRIPTION_CHANGED,
      PROFILE_IMPORT_NOT_FOUND: AGENT_ERROR_DEFINITIONS.PROFILE_IMPORT_NOT_FOUND,
      PROFILE_IMPORT_STATE_CONFLICT: AGENT_ERROR_DEFINITIONS.PROFILE_IMPORT_STATE_CONFLICT,
      PROFILE_IMPORT_UNSUPPORTED_RESUME: AGENT_ERROR_DEFINITIONS.PROFILE_IMPORT_UNSUPPORTED_RESUME,
      PROFILE_IMPORT_ISSUE_STALE: AGENT_ERROR_DEFINITIONS.PROFILE_IMPORT_ISSUE_STALE,
    }).toEqual({
      PREPARATION_RETRY_EXHAUSTED: definition(409, false, true, 'REFRESH_RESOURCE'),
      PREPARATION_RECOVERY_CONFLICT: definition(409, true, true, 'REFRESH_RESOURCE'),
      PREPARATION_CHECKPOINT_EXPIRED: definition(409, false, true, 'REFRESH_RESOURCE'),
      PREPARATION_MATERIAL_UNAVAILABLE: definition(409, false, true, 'REFRESH_RESOURCE'),
      JOB_DESCRIPTION_CHANGED: definition(409, false, true, 'REFRESH_RESOURCE'),
      PROFILE_IMPORT_NOT_FOUND: definition(404, false, false, 'NONE'),
      PROFILE_IMPORT_STATE_CONFLICT: definition(409, true, true, 'REFRESH_RESOURCE'),
      PROFILE_IMPORT_UNSUPPORTED_RESUME: definition(422, false, true, 'NONE'),
      PROFILE_IMPORT_ISSUE_STALE: definition(409, false, true, 'REFRESH_RESOURCE'),
    });
  });

  it('binds each stable error code to status, retry, and recovery metadata', () => {
    expect(AGENT_ERROR_DEFINITIONS.AUTH_CSRF_INVALID).toEqual({
      statusCode: 403,
      retryable: false,
      requiresUserAction: false,
      recommendedAction: 'REFRESH_SESSION',
    });
    expect(AGENT_ERROR_DEFINITIONS.CONVERSATION_STATE_CONFLICT).toEqual({
      statusCode: 409,
      retryable: true,
      requiresUserAction: true,
      recommendedAction: 'REFRESH_RESOURCE',
    });
    expect(AGENT_ERROR_DEFINITIONS.DAILY_REPORT_PREFERENCE_CONFLICT).toEqual({
      statusCode: 409,
      retryable: true,
      requiresUserAction: true,
      recommendedAction: 'REFRESH_RESOURCE',
    });
    expect(AGENT_ERROR_DEFINITIONS.DAILY_REPORT_NOT_FOUND).toEqual({
      statusCode: 404,
      retryable: false,
      requiresUserAction: false,
      recommendedAction: 'NONE',
    });
    expect({
      EXECUTION_CLIENT_UPGRADE_REQUIRED:
        AGENT_ERROR_DEFINITIONS.EXECUTION_CLIENT_UPGRADE_REQUIRED,
      SENSITIVE_WRITE_CONFIRMATION_NOT_FOUND:
        AGENT_ERROR_DEFINITIONS.SENSITIVE_WRITE_CONFIRMATION_NOT_FOUND,
      SENSITIVE_WRITE_RELEASE_NOT_FOUND:
        AGENT_ERROR_DEFINITIONS.SENSITIVE_WRITE_RELEASE_NOT_FOUND,
      SENSITIVE_WRITE_RELEASE_STATE_CONFLICT:
        AGENT_ERROR_DEFINITIONS.SENSITIVE_WRITE_RELEASE_STATE_CONFLICT,
      SENSITIVE_WRITE_RELEASE_IDEMPOTENCY_CONFLICT:
        AGENT_ERROR_DEFINITIONS.SENSITIVE_WRITE_RELEASE_IDEMPOTENCY_CONFLICT,
      SENSITIVE_WRITE_RELEASE_STALE:
        AGENT_ERROR_DEFINITIONS.SENSITIVE_WRITE_RELEASE_STALE,
      SENSITIVE_WRITE_RELEASE_EXPIRED:
        AGENT_ERROR_DEFINITIONS.SENSITIVE_WRITE_RELEASE_EXPIRED,
      SENSITIVE_EXECUTION_MATERIAL_UNAVAILABLE:
        AGENT_ERROR_DEFINITIONS.SENSITIVE_EXECUTION_MATERIAL_UNAVAILABLE,
      SENSITIVE_EXECUTION_MATERIAL_SCOPE_MISMATCH:
        AGENT_ERROR_DEFINITIONS.SENSITIVE_EXECUTION_MATERIAL_SCOPE_MISMATCH,
    }).toEqual({
      EXECUTION_CLIENT_UPGRADE_REQUIRED: {
        statusCode: 426,
        retryable: false,
        requiresUserAction: true,
        recommendedAction: 'UPGRADE_EXTENSION',
      },
      SENSITIVE_WRITE_CONFIRMATION_NOT_FOUND: {
        statusCode: 404,
        retryable: false,
        requiresUserAction: true,
        recommendedAction: 'REFRESH_RESOURCE',
      },
      SENSITIVE_WRITE_RELEASE_NOT_FOUND: {
        statusCode: 404,
        retryable: false,
        requiresUserAction: true,
        recommendedAction: 'REFRESH_RESOURCE',
      },
      SENSITIVE_WRITE_RELEASE_STATE_CONFLICT: {
        statusCode: 409,
        retryable: true,
        requiresUserAction: true,
        recommendedAction: 'REFRESH_RESOURCE',
      },
      SENSITIVE_WRITE_RELEASE_IDEMPOTENCY_CONFLICT: {
        statusCode: 409,
        retryable: false,
        requiresUserAction: true,
        recommendedAction: 'REFRESH_RESOURCE',
      },
      SENSITIVE_WRITE_RELEASE_STALE: {
        statusCode: 412,
        retryable: true,
        requiresUserAction: true,
        recommendedAction: 'REVIEW_SENSITIVE_WRITE',
      },
      SENSITIVE_WRITE_RELEASE_EXPIRED: {
        statusCode: 410,
        retryable: true,
        requiresUserAction: true,
        recommendedAction: 'REVIEW_SENSITIVE_WRITE',
      },
      SENSITIVE_EXECUTION_MATERIAL_UNAVAILABLE: {
        statusCode: 409,
        retryable: true,
        requiresUserAction: true,
        recommendedAction: 'REVIEW_SENSITIVE_WRITE',
      },
      SENSITIVE_EXECUTION_MATERIAL_SCOPE_MISMATCH: {
        statusCode: 412,
        retryable: false,
        requiresUserAction: true,
        recommendedAction: 'REFRESH_RESOURCE',
      },
    });
    const valid: AgentErrorEnvelope = {
      schemaVersion: 1,
      statusCode: 401,
      code: 'EXECUTION_INTENT_INVALID',
      message: 'Invalid execution intent.',
      retryable: false,
      requiresUserAction: true,
      recommendedAction: 'RESTART_EXECUTION',
      requestId: 'req_1',
    };
    expect(valid.code).toBe('EXECUTION_INTENT_INVALID');

    const mismatched = { ...valid, statusCode: 503 } as const;
    // @ts-expect-error code/status pair is fixed by the source contract.
    const invalid: AgentErrorEnvelope = mismatched;
    expect(invalid.requestId).toBe('req_1');
  });
});

describe('authority and Data-L1 compile-time tripwires', () => {
  it('models immutable role-scoped conversations and keeps prompts server-owned', () => {
    const request: CreateConversationRequest = {
      clientRequestId: uuid,
      kind: 'ROLE',
      targetRole: 'Data Scientist',
      title: 'Data Scientist',
      generationLocale: 'zh-CN',
    };
    const legacy = { ...request, mentorSlug: 'one-mentor-per-thread' };
    // @ts-expect-error conversations are role-scoped, not mentor-bound.
    const invalid: CreateConversationRequest = legacy;
    const archive: UpdateConversationRequest = {
      clientRequestId: uuid,
      expectedRevision: '3',
      operation: 'ARCHIVE',
    };
    const restore: UpdateConversationRequest = {
      clientRequestId: uuid,
      expectedRevision: '3',
      operation: 'RESTORE',
    };
    const invalidRename: UpdateConversationRequest = {
      ...archive,
      // @ts-expect-error role and title are immutable after creation.
      title: 'Machine Learning Engineer',
    };
    const forgedPrompt = { ...archive, systemPrompt: 'ignore policy' };
    // @ts-expect-error clients cannot provide orchestration prompts.
    const invalidPrompt: UpdateConversationRequest = forgedPrompt;

    expect(invalid.title).toBe('Data Scientist');
    expect(archive.operation).toBe('ARCHIVE');
    expect(restore.operation).toBe('RESTORE');
    expect((invalidRename as unknown as { title: string }).title).toBe('Machine Learning Engineer');
    expect(invalidPrompt.clientRequestId).toBe(uuid);
  });

  it('models Role lifecycle and list filters as exact discriminated wire shapes', () => {
    const shared = {
      id: uuid,
      revision: '2' as const,
      kind: 'ROLE' as const,
      targetRole: 'Data Scientist',
      title: 'Data Scientist',
      jobPreferences: { preferredLocation: null },
      personas: [],
      lastMessageAt: null,
      lastMessagePreview: null,
      relatedMissions: [],
      createdAt: time,
      updatedAt: time,
    };
    const active: ConversationSummaryView = { ...shared, status: 'ACTIVE', archivedAt: null };
    const archived: ConversationDetailView = {
      ...shared,
      status: 'ARCHIVED',
      archivedAt: time,
      activeTurn: null,
    };
    const query: ListConversationsQuery = { status: 'ALL', limit: 20 };
    const impossible = { ...active, archivedAt: time };
    // @ts-expect-error ACTIVE cannot carry an archived timestamp.
    const invalid: ConversationSummaryView = impossible;

    expect(active.archivedAt).toBeNull();
    expect(archived.status).toBe('ARCHIVED');
    expect(query.status).toBe('ALL');
    expect(invalid.archivedAt).toBe(time);
  });

  it('lets chat messages reference recommendation batches without embedding authority', () => {
    const reference: PersistedMessagePart = {
      partId: uuid,
      type: 'recommendation_batch_ref',
      batchId: uuid,
    };
    const invalid: PersistedMessagePart = {
      ...reference,
      // @ts-expect-error message parts may reference a batch but cannot embed its state.
      batch: { revision: '1' },
    };

    expect(reference.type).toBe('recommendation_batch_ref');
    expect((invalid as unknown as { batch: { revision: string } }).batch).toEqual({ revision: '1' });
  });

  it('requires the exact generation locale and immutable text-part locale wire', () => {
    const request: SendConversationMessageRequest = {
      clientMessageId: uuid,
      generationLocale: 'zh-CN',
      parts: [{ type: 'text', text: '你好' }],
    };
    const missingLocale = { clientMessageId: uuid, parts: [{ type: 'text', text: 'hello' }] };
    // @ts-expect-error generationLocale is required for every send.
    const invalidRequest: SendConversationMessageRequest = missingLocale;
    const text: TextMessagePart = { partId: uuid, type: 'text', text: 'hello', locale: 'en-US' };
    const unsupportedText = { ...text, locale: 'und' };
    // @ts-expect-error persisted text locale is the reviewed two-value union or null.
    const invalidText: TextMessagePart = unsupportedText;

    expect(GENERATION_LOCALES).toEqual(['en-US', 'zh-CN']);
    expect(request.generationLocale).toBe('zh-CN');
    expect(invalidRequest.parts).toHaveLength(1);
    expect(invalidText.locale).toBe('und');
  });

  it('does not let mission creation or intent issuance self-assert authority', () => {
    const mission: CreateMissionRequest = {
      clientRequestId: uuid, conversationId: uuid, jobId: 'selector',
      requestedAutomationLevel: 'L1_FILL_STOP_BEFORE_SUBMIT',
    };
    const forgedMission = { ...mission, fieldKeys: ['applicant.email'] };
    // @ts-expect-error fields are reconstructed and approved server-side.
    const invalidMission: CreateMissionRequest = forgedMission;
    expect(invalidMission.jobId).toBe('selector');

    const issue: IssueExecutionIntentRequest = {
      missionRevision: '8', missionStepId: uuid, extensionInstallId: uuid,
    };
    const forgedIssue = { ...issue, allowedActions: ['SUBMIT'] };
    // @ts-expect-error the client cannot choose signed actions.
    const invalidIssue: IssueExecutionIntentRequest = forgedIssue;
    expect(invalidIssue.missionRevision).toBe('8');
  });

  it('keeps signed claims and receipts value-free', () => {
    const claims = {
      ver: 1, iss: 'https://api.example.invalid', aud: 'edaix-job-agent-extension', sub: uuid, jti: executionJti,
      iat: 1, nbf: 1, exp: 121, missionId: uuid, missionRevision: '8', missionStepId: uuid,
      stepAttempt: 1, intentVersion: 1, extensionInstallId: uuid,
      target: { jobId: 'job', sourcePlatform: 'GREENHOUSE', atsProvider: 'GREENHOUSE', canonicalOrigin: 'https://boards.example.invalid', pathRuleId: 'v1', postingFingerprint: digest },
      fieldKeys: ['applicant.email'], fieldSchemaVersion: 1,
      automationLevel: 'L1_FILL_STOP_BEFORE_SUBMIT', allowedActions: ['FILL'], planDigest: digest,
      approvalMessageId: uuid, profile: { revision: '1', deletionEpoch: '0', snapshotDigest: digest },
      resume: { versionId: uuid, contentHash: digest, contentRevision: '1', libraryRevision: '1' },
      policyVersion: 'v1', killSwitchVersion: '1', consentVersion: 'v1',
    } as const satisfies ExecutionIntentClaims;
    const withValues = { ...claims, values: { 'applicant.email': 'secret' } };
    // @ts-expect-error signed payloads contain keys/hashes, never values.
    const invalidClaims: ExecutionIntentClaims = withValues;
    const invalidCanonicalClaims: ExecutionIntentClaims = {
      ...claims,
      // @ts-expect-error T11 binding stays server-side in Mission/planDigest; v1 JWS exact keys do not change.
      applicationId: uuid,
    };
    expect(invalidClaims.ver).toBe(1);
    expect(invalidCanonicalClaims.planDigest).toBe(digest);

    const receipt: SubmitApplicationReceiptRequest = {
      clientReceiptId: uuid, executionLease: 'secret', missionStepId: uuid, intentVersion: 1,
      jobIdentityHash: digest, planDigest: digest, outcome: 'FILL_SUCCEEDED',
      fieldResults: [{ fieldKey: 'applicant.email', outcomeCode: 'FILLED' }],
      executionStartedAt: time, executionFinishedAt: parseIsoDateTime('2026-08-13T00:00:01Z')!,
    };
    const withScreenshot = { ...receipt, screenshot: 'data:image/png;base64,secret' };
    // @ts-expect-error receipts cannot carry page content.
    const invalidReceipt: SubmitApplicationReceiptRequest = withScreenshot;
    expect(invalidReceipt.outcome).toBe('FILL_SUCCEEDED');

    const providerOnlyOutcome = { ...receipt, outcome: 'SUBMISSION_CONFIRMED' } as const;
    // @ts-expect-error only the server may upgrade a stored receipt to provider-confirmed.
    const forgedConfirmation: SubmitApplicationReceiptRequest = providerOnlyOutcome;
    expect(forgedConfirmation.outcome).toBe('SUBMISSION_CONFIRMED');
  });
});

describe('closed UI and orchestration unions', () => {
  it('requires CHAT_ANSWER to carry the durable question body and typed submit operation', () => {
    const card: ActionCardView = {
      actionId: uuid,
      revision: '3',
      cardType: 'CHAT_ANSWER',
      title: { code: 'USER_INPUT_REQUIRED', defaultText: 'Answer required', safeParams: {} },
      body: { code: 'ANSWER_IN_CHAT', defaultText: 'Answer in chat', safeParams: {} },
      risk: 'LOW',
      resource: { type: 'APPLICATION_INPUT_REQUEST', id: uuid, revision: '3' },
      payloadDigest: digest,
      blocks: [
        { type: 'QUESTION_BODY', body: 'Are you available next month?', locale: parseCanonicalBcp47Locale('en-US')! },
        { type: 'JOB_CONTEXT', canonicalJobId: 'job-1', jobTitle: 'Engineer', companyName: 'Example' },
        { type: 'ANSWER_INPUT', answerSchemaVersion: 1, answerKind: 'BOOLEAN', required: true },
        { type: 'MEMORY_SCOPE', options: [{ scopeRef: { scope: 'APPLICATION', companyId: 'company-1', canonicalJobId: 'job-1', applicationId: uuid }, labelCode: 'APPLICATION' }], defaultScope: 'APPLICATION' },
      ],
      actions: [{ code: 'SUBMIT_ANSWER', labelCode: 'SUBMIT_ANSWER', style: 'PRIMARY', endpointId: 'ACTION_DECISION' }],
      expiresAt: time,
      status: 'PENDING',
      outcome: null,
    };
    const submit: DecideConversationActionRequest = {
      clientRequestId: uuid,
      actionCode: 'SUBMIT_ANSWER',
      expectedRevision: card.revision,
      answerSchemaVersion: 1,
      answer: { kind: 'BOOLEAN', value: true },
      scopeRef: card.blocks[3].options[0]!.scopeRef,
    };
    expect(submit.actionCode).toBe('SUBMIT_ANSWER');
    expect(parseIsoCountryCode('US')).toBe('US');
    expect(parseIsoCountryCode('ZZ')).toBeNull();
    expect(parseIsoCountryCode('XK')).toBeNull();
    expect(parseIsoCountryCode('us')).toBeNull();
    expect(parseCanonicalBcp47Locale('en-US')).toBe('en-US');
    expect(parseCanonicalBcp47Locale('en-us')).toBeNull();

    const genericReply = { clientRequestId: uuid, actionCode: 'SUBMIT_ANSWER', actionRevision: '3', payloadDigest: digest, reply: { type: 'text', text: 'yes' } } as const;
    // @ts-expect-error CHAT_ANSWER cannot fall back to generic SEND_REPLY.
    const invalidSubmit: DecideConversationActionRequest = genericReply;
    expect(invalidSubmit.actionCode).toBe('SUBMIT_ANSWER');
  });

  it('keeps terminal mission states terminal', () => {
    for (const status of MISSION_TERMINAL_STATUSES) expect(MISSION_STATUS_TRANSITIONS[status]).toEqual([]);
  });

  it('never exposes an arbitrary action-card endpoint', () => {
    expect(ACTION_ENDPOINT_IDS).toEqual([
      'MISSION_APPROVAL', 'ACTION_DECISION', 'OPEN_EXTENSION', 'AUTH_LOGIN',
    ]);
  });

  it('discriminates SSE event names from exact payload shapes', () => {
    expect(MESSAGE_SSE_ERROR_CODES.slice(0, 3)).toEqual([
      'LOGIN_REQUIRED',
      'ACCOUNT_UNAVAILABLE',
      'AGENT_UNAVAILABLE',
    ]);
    expect(new Set(MESSAGE_SSE_ERROR_CODES).size).toBe(MESSAGE_SSE_ERROR_CODES.length);

    const frame: MessageSseFrame = {
      id: '4', event: 'message.delta', data: {
        schemaVersion: 1, eventSequence: '4', streamId: uuid, conversationId: uuid, turnId: uuid,
        occurredAt: time, messageId: uuid, partId: uuid, partIndex: 0, delta: '...',
      },
    };
    expect(frame.event).toBe('message.delta');

    const wrong = { schemaVersion: 1, eventSequence: '5', streamId: uuid, conversationId: uuid, turnId: uuid, occurredAt: time, messageId: uuid, terminalStatus: 'FAILED' } as const;
    // @ts-expect-error a delta frame cannot carry the done payload.
    const invalidFrame: MessageSseFrame = {
      id: '5', event: 'message.delta',
      data: wrong,
    };
    expect(invalidFrame.id).toBe('5');
  });
});
