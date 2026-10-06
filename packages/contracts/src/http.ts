import type * as AssistantCover from './assistantCoverDraft.ts';
import type * as AssistantJobs from './assistant-jobs.ts';
import type * as AtsReports from './ats-reports.ts';
import type * as SubscriptionLifecycle from './subscription-lifecycle.ts';
import type { RolePreferencesPatch, RolePreferencesSnapshot } from './rolePreferences.ts';
import type { PilotUa5ProfileCurrentnessRequest, PilotUa5ProfileCurrentnessResponse } from './draft/pilotUa5ProfileCurrentness.ts';
import type { AuthServerRefreshRequest, AuthServerLogoutRequest, ExtensionTokenPair } from './auth.ts';
import type { ApplicationQuestionBatchV1, ApplicationQuestionResultV1 } from './applicationQuestionCandidates.ts';
import type { EeoSelfIdentificationDeleteV1, EeoSelfIdentificationUpdateV1, EeoSelfIdentificationV1 } from './eeoSelfIdentification.ts';
import type { GetApplicationSigningConsentResponse } from './applicationSigningConsent.ts';
import type {
  FullAiQuota,
  FullAiRequest,
  FullAiResponse,
  FullAiReviseRequest,
  FullAiReviseResponse,
  FullAiStreamEvent,
} from './fullAiAutofill.ts';
import type {
  ProfileDirectoryPersonalUpdateV1, ProfileDirectoryPersonalV1,
  ProfileDirectoryPreferencesUpdateV1, ProfileDirectoryPreferencesV1,
  ProfileDirectoryWorkAuthorizationUpdateV1, ProfileDirectoryWorkAuthorizationV1,
} from './profileDirectory.ts';
import type {
  ApplicationQuestionMemoryListV1,
  ApplicationQuestionMemoryRecordV1,
  ApplicationQuestionSettingsUpdateV1,
  ApplicationQuestionSettingsV1,
  ForgetApplicationQuestionAnswerParams,
  RememberApplicationQuestionAnswerV1,
} from './applicationQuestionMemory.ts';
import type {
  GetMissionApplicationQuestionsParams,
  GetMissionApplicationQuestionsResponse,
} from './applicationQuestionSchema.ts';
import type {
  MissionAutofillConsentV1,
  RecordMissionAutofillConsentV1,
} from './missionAutofillConsent.ts';
/** Endpoint registries mirrored from AGENT-API-CONTRACT.md §§2–6. */

import { COMMON_PRIVATE_ERROR_CODES, type AgentErrorCode } from './common.ts';
import type {
  CreateConversationRequest,
  CreateConversationResponse,
  DecideConversationActionParams,
  DecideConversationActionRequest,
  DecideConversationActionResponse,
  GetConversationMessageParams,
  GetConversationMessageResponse,
  GetConversationParams,
  GetConversationResponse,
  ListConversationMessagesParams,
  ListConversationMessagesQuery,
  ListConversationMessagesResponse,
  ListConversationsQuery,
  ListConversationsResponse,
  MessageSseFrame,
  SendConversationMessageParams,
  SendConversationMessageRequest,
  UpdateConversationParams,
  UpdateConversationRequest,
  UpdateConversationResponse,
} from './conversations.ts';
import type {
  CancelMissionParams,
  CancelMissionRequest,
  CancelMissionResponse,
  CreateMissionRequest,
  CreateMissionResponse,
  EnterSubmissionBoundaryParams,
  EnterSubmissionBoundaryRequest,
  EnterSubmissionBoundaryResponse,
  GetMissionApplicationTargetParams,
  GetMissionApplicationTargetResponse,
  GetMissionParams,
  GetMissionResponse,
  ListMissionsQuery,
  ListMissionsResponse,
  RecordMissionApprovalParams,
  RecordMissionApprovalRequest,
  RecordMissionApprovalResponse,
  RecordSubmissionEventParams,
  RecordSubmissionEventRequest,
  RecordSubmissionEventResponse,
} from './missions.ts';
import type {
  EnsureMissionStartApprovalRequestV1,
  EnsureMissionStartApprovalResponseV1,
  MissionMaterialsV1,
  ReleaseMissionCoverLetterRequestV1,
  ReleaseMissionCoverLetterTextV1,
  ReleaseMissionResumeRequestV1,
  RequestMissionCoverLetterRequestV1,
  RequestMissionCoverLetterResultV1,
  ResolveMissionPageBindingRequestV1,
  ResolveMissionPageBindingResponseV1,
} from './missionDock.ts';
import type {
  CreateApplicationPageContextRequest,
  CreateApplicationPageContextResponse,
} from './applicationPage.ts';
import type {
  CreateJobFromUrlRequest,
  CreateJobFromUrlResponse,
} from './jobIntake.ts';
import type { JobIngestionRunListResponse } from './jobIngestion.ts';
import type {
  DecideRecommendationBatchParams,
  DecideRecommendationBatchRequest,
  DecideRecommendationBatchResponse,
  GetRecommendationBatchParams,
  GetRecommendationBatchResponse,
  GetRecommendationItemDetailParams,
  GetRecommendationItemDetailResponse,
  ListRecommendationBatchesQuery,
  ListRecommendationBatchesResponse,
  RefreshRecommendationBatchRequest,
  RefreshRecommendationBatchResponse,
  ConfirmRecommendationItemParams,
  ConfirmRecommendationItemRequest,
  ConfirmRecommendationItemResponse,
} from './recommendations.ts';
import type {
  AdminPolicyModuleParams,
  AdminPolicyResponse,
  AdminPolicyVersionParams,
  CreateAdminPolicyDraftRequest,
  ListAdminPoliciesResponse,
} from './adminPolicies.ts';
import type { ApplicationPreparationsParams, ApplicationPreparationsResponse, RetryApplicationPreparationParams,
  RetryApplicationPreparationRequest, StartApplicationPreparationsRequest } from './applicationPreparations.ts';
import type {
  ClaimExecutionIntentRequestContract,
  ClaimExecutionIntentResponseContract,
  GetApplicationProfileResponse,
  GetExecutionIntentJwksResponse,
  IssueExecutionIntentParams,
  IssueExecutionIntentRequestContract,
  IssueExecutionIntentResponseContract,
  SubmitApplicationReceiptParams,
  SubmitApplicationReceiptRequestContract,
  SubmitApplicationReceiptResponseContract,
} from './executionIntent.ts';
import {
  SENSITIVE_EXECUTION_MATERIAL_CACHE_POLICY,
  type CreateSensitiveWriteConfirmationParams,
  type CreateSensitiveWriteConfirmationRequestV2,
  type CreateSensitiveWriteConfirmationResponseV2,
  type DecideSensitiveWriteConfirmationParams,
  type DecideSensitiveWriteConfirmationRequestV2,
  type FetchSensitiveExecutionMaterialRequestV2,
  type FetchSensitiveExecutionMaterialResponseV2,
  type SensitiveWriteDecisionResponseV2,
} from './sensitiveWrite.ts';
import type {
  AttestExtensionInstallRequest,
  AttestExtensionInstallResponse,
  CreateExtensionHandoffRequest,
  CreateExtensionHandoffResponse,
  CreateRegistrationInvitationResponse,
  GetAuthCsrfResponse,
  GetRegistrationContextRequest,
  GetAgentSessionResponse,
  GoogleLoginRequest,
  GoogleLoginResponse,
  InvitationPathParams,
  LinkExtensionInstallRequest,
  LinkExtensionInstallResponse,
  ListAdminWaitlistQuery,
  ListAdminWaitlistResponse,
  LoginAuthRequest,
  LoginAuthResponse,
  LogoutAuthSessionRequest,
  LogoutAuthSessionResponse,
  IntrospectAuthSessionRequest,
  IntrospectAuthSessionResponse,
  RedeemExtensionHandoffRequest,
  RedeemExtensionHandoffResponse,
  RefreshAuthSessionRequest,
  RefreshAuthSessionResponse,
  RegisterAuthRequest,
  RegisterAuthResponse,
  ResendRegistrationInvitationResponse,
  RevokeAuthSessionRequest,
  RevokeAuthSessionResponse,
  RevokeRegistrationInvitationResponse,
  ResendEmailVerificationRequest,
  ResendEmailVerificationResponse,
  VerifyEmailRequest,
  VerifyEmailResponse,
  WaitlistEntryPathParams,
  WaitlistRequest,
  WaitlistResponse,
  ExchangeRegistrationInvitationRequest,
  ExchangeRegistrationInvitationResponse,
  RegistrationContextResponse,
} from './auth.ts';
import type {
  GetDailyReportEmailPreferenceResponse,
  GetDailyReportPreferenceResponse,
  ListUnreadDailyReportsQuery,
  ListUnreadDailyReportsResponse,
  RecordDailyReportReadParams,
  RecordDailyReportReadRequest,
  RecordDailyReportReadResponse,
  UpdateDailyReportEmailPreferenceRequest,
  UpdateDailyReportEmailPreferenceResponse,
  UpdateDailyReportPreferenceRequest,
  UpdateDailyReportPreferenceResponse,
} from './dailyReports.ts';
import type {
  ListApplicationLedgerQuery,
  ListApplicationLedgerResponse,
  UpdatePrimaryTimeZoneRequest,
  UpdatePrimaryTimeZoneResponse,
} from './applicationLedger.ts';
import type {
  AdminReferralRequestView,
  CompleteMentorReferralRequestRequest,
  CompleteMentorReferralRequestResponse,
  CreateReferralRequestRequest,
  CreateReferralRequestResponse,
  DecideMentorReferralRequestRequest,
  DecideMentorReferralRequestResponse,
  ListAdminReferralMentorBindingsResponse,
  ListAdminReferralRequestsQuery,
  ListAdminReferralRequestsResponse,
  ListMentorReferralRequestsResponse,
  ListStudentReferralCoffeeChatsResponse,
  ListStudentReferralCoffeeChatsQuery,
  ListStudentReferralCoffeeChatsPageResponse,
  ReferralRequestPathParams,
  ReferralRequestParams,
  ReferralRequestView,
  ReplaceMentorCoffeeChatSlotsRequest,
  ReplaceMentorCoffeeChatSlotsResponse,
  SelectStudentCoffeeChatSlotRequest,
  SelectStudentCoffeeChatSlotResponse,
  SelectReferralGuaranteeRemedyRequest,
  SelectReferralGuaranteeRemedyResponse,
  SetMentorCoffeeChatMeetingUrlRequest,
  SetMentorCoffeeChatMeetingUrlResponse,
  UpdateAdminReferralMentorBindingRequest,
  UpdateAdminReferralMentorBindingResponse,
  UpdateAdminReferralOutcomeRequest,
  UpdateAdminReferralOutcomeResponse,
  UpdateAdminReferralRequestRequest,
} from './referrals.ts';
import type {
  CreateReferralCheckoutRequest,
  CreateReferralCheckoutResponse,
  ExecuteReferralRefundResponse,
  ReconcileReferralRefundResponse,
  ReferralCommerceView,
} from './payments.ts';
import {
  PROFILE_V2_CACHE_POLICY,
  type CandidateProfileSnapshotV2,
  type PatchCandidateProfileV2,
} from './profileV2.ts';
import {
  RESUME_PROFILE_SUGGESTION_UPLOAD_MAX_BYTES,
  type ResumeProfileSuggestionSetV1,
  type ResumeProfileSuggestionUploadRequestV1,
} from './resumeProfileSuggestions.ts';
import {
  RESUME_LIBRARY_CACHE_POLICY,
  type ArchiveResumeTrackRequestV1,
  type CreateResumeTrackRequestV1,
  type RenameResumeTrackRequestV1,
  type ResumeLibraryRevisionRequestV1,
  type ResumeLibrarySnapshotV1,
  type ResumeTrackParamsV1,
  type ResumeTrackVersionParamsV1,
} from './resumeLibrary.ts';
import {
  RESUME_SELECTION_CACHE_POLICY,
  type ListResumeSelectionOptionsResponseV1,
} from './resumeSelection.ts';
import {
  JOB_RESUME_GENERATION_CACHE_POLICY,
  type CreateJobResumeGenerationRequestV1,
  type JobResumeGenerationResponseV1,
} from './jobResumeGeneration.ts';
import type { ResumePdfMetadataV1, ResumePdfParamsV1, ResumePdfReadRequestV1 } from './resumePdf.ts';
import type {
  ResumeAtsAttachmentPlanRequestV1,
  ResumeAtsAttachmentPlanV1,
  ResumeAtsAttachmentPreparedRequestV1,
  ResumeAtsAttachmentPreparedV1,
  ResumeAtsAttachmentReleaseRequestV1,
} from './resumeAtsAttachment.ts';
import type {
  ListApplicationAnswersResponseV1,
  PutApplicationAnswerRequestV1,
  PutApplicationAnswerResponseV1,
} from './applicationQuestionAnswers.ts';
import type {
  CreateApplicationQuestionDraftsRequestV1,
  CreateApplicationQuestionDraftsResponseV1,
} from './applicationQuestionDrafts.ts';
import type {
  CoverLetterProductRequestV1,
  CoverLetterProductResultV1,
  CoverLetterRequirementRequestV1,
  CoverLetterRequirementResultV1,
} from './coverLetterProduct.ts';
import type {
  CoverLetterAttachmentLookupRequestV1,
  CoverLetterAttachmentLookupV1,
  CoverLetterAttachmentPrepareRequestV1,
  CoverLetterAttachmentPrepareResultV1,
  CoverLetterAttachmentReleaseRequestV1,
  CoverLetterAttachmentTextV1,
} from './coverLetterAttachment.ts';
import type {
  TrustTelemetryAcceptedResponseV1,
  TrustTelemetryDeletionRequestV1,
  TrustTelemetryEventV1,
} from './trustTelemetry.ts';
import type { GapStrengthReport } from './gap-strength.ts';
import type { GapStrengthTargetRoleRequest } from './gap-strength-input.ts';
import type { GapAnalysisComputeRequestV2, GapAnalysisResponseV2 } from './gap-analysis-v2.ts';
import type { LearningRecommendationResponse } from './learning-recommendation.ts';
import type { LearningRecommendationRequestV2, LearningRecommendationResponseV2 } from './learning-recommendation-v2.ts';
import type {
  ProfileStrengthSnapshot,
  RemoveProfileStrengthRequest,
  SaveProfileStrengthRequest,
} from './profile-strength.ts';
import type {
  PilotUa2ClassificationRequest,
  PilotUa2ClassificationResponse,
} from './draft/pilotUa2Classification.ts';
import type {
  PilotUa5CompositionRequest,
  PilotUa5CompositionResponse,
} from './draft/pilotUa5Certification.ts';
import type {
  PilotUa5BoundProfilePayloadRequest,
  PilotUa5BoundProfilePayloadResponse,
} from './draft/pilotUa5ProfilePayloads.ts';

type Method = 'GET' | 'POST' | 'PATCH' | 'DELETE';
type Auth = 'bearer' | 'public' | 'service-bearer';
type ResponseKind = 'json' | 'sse' | 'ndjson' | 'binary';
type EndpointPolicy = Readonly<Record<string, unknown>>;
const endpoint = <
  const M extends Method,
  const P extends string,
  const S extends string,
  const A extends Auth,
  const R extends ResponseKind,
  const T extends EndpointPolicy | undefined = undefined,
>(method: M, path: P, sourceSection: S, auth: A, responseKind: R, policy?: T) => ({
  method,
  path,
  sourceSection,
  auth,
  responseKind,
  ...(policy ?? {}),
} as const);

/**
 * 端点逐条导出，再由下面的聚合对象组合。
 *
 * 2026-09-15 改：原来这是一个整体对象字面量，import 任何一个键都会把全部 160
 * 条拉进产物——打包器没法拆开一个对象字面量的属性。插件只用其中 22 个键，却要
 * 为另外 138 条付字节：实测 Assistant 产物的 background.js 里这张表占 41,377
 * 字节，把 410 KiB 的预算顶破了 24,142 字节。
 *
 * **wire 形状一个字没变**——每条的 method、path、sourceSection、auth、
 * responseKind 与 policy 全部原样，只是从对象属性变成顶层常量，于是消费者只
 * import 自己要的那几条、其余被摇掉。聚合对象保留：测试与需要整表的地方照旧
 * 可用，而只要没有运行时代码 import 它，它会连同未用到的条目一起被摇掉。
 */
export const getAssistantCoverDraft = /*#__PURE__*/ endpoint('GET', '/api/v1/agent/assistant/jobs/:entryId/cover-letter', '5.32', 'bearer', 'json');
export const writeAssistantCoverDraft = /*#__PURE__*/ endpoint('POST', '/api/v1/agent/assistant/jobs/:entryId/cover-letter', '5.32', 'bearer', 'json');
export const listAssistantJobs = /*#__PURE__*/ endpoint('GET', '/api/v1/agent/assistant/jobs', '5.30', 'bearer', 'json');
export const listAssistantJobBatches = /*#__PURE__*/ endpoint('GET', '/api/v1/agent/assistant/jobs/batches', '5.30', 'bearer', 'json');
export const deliverAssistantJobs = /*#__PURE__*/ endpoint('POST', '/api/v1/agent/assistant/jobs/deliver', '5.30', 'bearer', 'json');
export const decideAssistantJob = /*#__PURE__*/ endpoint('POST', '/api/v1/agent/assistant/jobs/:entryId/decision', '5.30', 'bearer', 'json');
export const lookupAtsReport = /*#__PURE__*/ endpoint('GET', '/api/v1/agent/assistant/ats-reports', '5.30', 'bearer', 'json');
export const startAtsReport = /*#__PURE__*/ endpoint('POST', '/api/v1/agent/assistant/ats-reports', '5.30', 'bearer', 'json');
export const getAtsReport = /*#__PURE__*/ endpoint('GET', '/api/v1/agent/assistant/ats-reports/:reportId', '5.30', 'bearer', 'json');
export const listAdminSubscriptionRefunds = /*#__PURE__*/ endpoint('GET', '/api/v1/agent/admin/payments/subscription-refunds', '5.31', 'bearer', 'json');
export const quoteAdminSubscriptionRefund = /*#__PURE__*/ endpoint('GET', '/api/v1/agent/admin/payments/subscription-refunds/users/:ownerId/quote/:invoiceId', '5.31', 'bearer', 'json');
export const requestAdminSubscriptionRefund = /*#__PURE__*/ endpoint('POST', '/api/v1/agent/admin/payments/subscription-refunds/users/:ownerId', '5.31', 'bearer', 'json');
export const reviewAdminSubscriptionRefund = /*#__PURE__*/ endpoint('POST', '/api/v1/agent/admin/payments/subscription-refunds/:refundId/review', '5.31', 'bearer', 'json');
export const retryAdminSubscriptionRefund = /*#__PURE__*/ endpoint('POST', '/api/v1/agent/admin/payments/subscription-refunds/retry', '5.31', 'bearer', 'json');
export const reviewAdminSubscriptionRefundAccess = /*#__PURE__*/ endpoint('POST', '/api/v1/agent/admin/payments/subscription-refunds/:refundId/access-review', '5.31', 'bearer', 'json');
export const getAgentSession = /*#__PURE__*/ endpoint('GET', '/api/v1/agent/session', '2.2', 'bearer', 'json');
export const createConversation = /*#__PURE__*/ endpoint('POST', '/api/v1/agent/conversations', '3.1', 'bearer', 'json');
export const listConversations = /*#__PURE__*/ endpoint('GET', '/api/v1/agent/conversations', '3.1', 'bearer', 'json');
export const getConversation = /*#__PURE__*/ endpoint('GET', '/api/v1/agent/conversations/:conversationId', '3.1', 'bearer', 'json');
export const getRolePreferences = /*#__PURE__*/ endpoint('GET', '/api/v1/agent/conversations/:conversationId/job-preferences', '3.1', 'bearer', 'json');
export const updateRolePreferences = /*#__PURE__*/ endpoint('PATCH', '/api/v1/agent/conversations/:conversationId/job-preferences', '3.1', 'bearer', 'json');
export const updateConversation = /*#__PURE__*/ endpoint('PATCH', '/api/v1/agent/conversations/:conversationId', '3.1', 'bearer', 'json');
export const listConversationMessages = /*#__PURE__*/ endpoint('GET', '/api/v1/agent/conversations/:conversationId/messages', '3.5', 'bearer', 'json');
export const getConversationMessage = /*#__PURE__*/ endpoint('GET', '/api/v1/agent/conversations/:conversationId/messages/:messageId', '3.5', 'bearer', 'json');
export const sendConversationMessage = /*#__PURE__*/ endpoint('POST', '/api/v1/agent/conversations/:conversationId/messages', '3.6', 'bearer', 'sse');
export const decideConversationAction = /*#__PURE__*/ endpoint('POST', '/api/v1/agent/conversations/:conversationId/actions/:actionId/decisions', '3.3', 'bearer', 'json');
export const getDailyReportPreference = /*#__PURE__*/ endpoint('GET', '/api/v1/agent/preferences/daily-report', '3.7', 'bearer', 'json');
export const updateDailyReportPreference = /*#__PURE__*/ endpoint('PATCH', '/api/v1/agent/preferences/daily-report', '3.7', 'bearer', 'json');
export const getDailyReportEmailPreference = /*#__PURE__*/ endpoint('GET', '/api/v1/agent/preferences/daily-report-email', '3.7', 'bearer', 'json');
export const updateDailyReportEmailPreference = /*#__PURE__*/ endpoint('PATCH', '/api/v1/agent/preferences/daily-report-email', '3.7', 'bearer', 'json');
export const listUnreadDailyReports = /*#__PURE__*/ endpoint('GET', '/api/v1/agent/daily-reports/unread', '3.7', 'bearer', 'json');
export const recordDailyReportRead = /*#__PURE__*/ endpoint('POST', '/api/v1/agent/daily-reports/:reportId/read', '3.7', 'bearer', 'json');
export const listRecommendationBatches = /*#__PURE__*/ endpoint('GET', '/api/v1/agent/recommendation-batches', '3.4', 'bearer', 'json');
export const getRecommendationBatch = /*#__PURE__*/ endpoint('GET', '/api/v1/agent/recommendation-batches/:batchId', '3.4', 'bearer', 'json');
export const getRecommendationItemDetail = /*#__PURE__*/ endpoint(
    'GET',
    '/api/v1/agent/recommendation-batches/:batchId/items/:itemId',
    '3.4',
    'bearer',
    'json',
    {
      callerConstraint: 'owner-bearer+owned-recommendation-item+current-canonical-job',
      successStatuses: [200],
      responseCache: 'private,no-store',
    } as const,
  );
export const decideRecommendationBatch = /*#__PURE__*/ endpoint('POST', '/api/v1/agent/recommendation-batches/:batchId/decisions', '3.4', 'bearer', 'json');
export const refreshRecommendationBatch = /*#__PURE__*/ endpoint('POST', '/api/v1/agent/recommendation-batches/refresh', '3.4', 'bearer', 'json',
    { successStatuses: [202], responseCache: 'private,no-store' } as const);
export const confirmRecommendationItem = /*#__PURE__*/ endpoint('POST', '/api/v1/agent/recommendation-batches/:batchId/items/:itemId/confirmations', '3.4', 'bearer', 'json',
    { successStatuses: [200], responseCache: 'private,no-store' } as const);
export const listAdminPolicies = /*#__PURE__*/ endpoint('GET', '/api/v1/agent/admin/policies/:moduleId', '5.29', 'bearer', 'json',
    { successStatuses: [200], responseCache: 'private,no-store' } as const);
export const createAdminPolicyDraft = /*#__PURE__*/ endpoint('POST', '/api/v1/agent/admin/policies/:moduleId', '5.29', 'bearer', 'json',
    { successStatuses: [201], responseCache: 'private,no-store' } as const);
export const publishAdminPolicy = /*#__PURE__*/ endpoint('POST', '/api/v1/agent/admin/policies/:moduleId/versions/:version/publish', '5.29', 'bearer', 'json',
    { successStatuses: [200], responseCache: 'private,no-store' } as const);
export const listApplicationPreparations = /*#__PURE__*/ endpoint('GET', '/api/v1/agent/recommendation-batches/:batchId/preparations', '3.4', 'bearer', 'json',
    { successStatuses: [200], responseCache: 'private,no-store' } as const);
export const startApplicationPreparations = /*#__PURE__*/ endpoint('POST', '/api/v1/agent/recommendation-batches/:batchId/preparations', '3.4', 'bearer', 'json',
    { successStatuses: [202], responseCache: 'private,no-store' } as const);
export const retryApplicationPreparation = /*#__PURE__*/ endpoint('POST', '/api/v1/agent/recommendation-batches/:batchId/preparations/:preparationId/retry', '3.4', 'bearer', 'json',
    { successStatuses: [202], responseCache: 'private,no-store' } as const);
export const listMissions = /*#__PURE__*/ endpoint('GET', '/api/v1/agent/missions', '4.2', 'bearer', 'json');
export const getMission = /*#__PURE__*/ endpoint('GET', '/api/v1/agent/missions/:missionId', '4.2', 'bearer', 'json');
export const getMissionApplicationTarget = /*#__PURE__*/ endpoint(
    'GET',
    '/api/v1/agent/missions/:missionId/application-target',
    '4.2',
    'bearer',
    'json',
  );
// 浮层任务接线（2026-09-24，argoland 权威 §4.15，本仓镜像）：见 missionDock.ts。
// 本仓从前自拟的 GET page-binding 与 GET resume-file 后端从没实现，一并删去。
export const resolveMissionPageBinding = /*#__PURE__*/ endpoint(
    'POST',
    '/api/v1/agent/missions/page-binding',
    '4.15',
    'bearer',
    'json',
    { callerConstraint: 'owner-bearer', successStatuses: [200], responseCache: 'private,no-store' } as const,
  );
export const ensureMissionStartApproval = /*#__PURE__*/ endpoint(
    'POST',
    '/api/v1/agent/missions/:missionId/start-approvals',
    '4.15',
    'bearer',
    'json',
    {
      callerConstraint: 'owner-bearer+exact-official-extension-origin+start-applying-mission',
      successStatuses: [201, 200],
      responseCache: 'private,no-store',
    } as const,
  );
export const getMissionMaterials = /*#__PURE__*/ endpoint(
    'GET',
    '/api/v1/agent/missions/:missionId/materials',
    '4.15',
    'bearer',
    'json',
    { callerConstraint: 'owner-bearer', successStatuses: [200], responseCache: 'private,no-store' } as const,
  );
export const releaseMissionResume = /*#__PURE__*/ endpoint(
    'POST',
    '/api/v1/agent/missions/:missionId/materials/resume',
    '4.15',
    'bearer',
    'binary',
    {
      callerConstraint: 'owner-bearer+exact-official-extension-origin+exact-artifact-revision-snapshot',
      successStatuses: [200],
      responseCache: 'private,no-store',
    } as const,
  );
export const requestMissionCoverLetter = /*#__PURE__*/ endpoint(
    'POST',
    '/api/v1/agent/missions/:missionId/materials/cover-letter',
    '4.15',
    'bearer',
    'json',
    {
      callerConstraint: 'owner-bearer+exact-official-extension-origin',
      successStatuses: [200],
      responseCache: 'private,no-store',
    } as const,
  );
export const releaseMissionCoverLetterText = /*#__PURE__*/ endpoint(
    'POST',
    '/api/v1/agent/missions/:missionId/materials/cover-letter/text',
    '4.15',
    'bearer',
    'json',
    {
      callerConstraint: 'owner-bearer+exact-official-extension-origin+exact-artifact',
      successStatuses: [200],
      responseCache: 'private,no-store',
    } as const,
  );
export const releaseMissionCoverLetterPdf = /*#__PURE__*/ endpoint(
    'POST',
    '/api/v1/agent/missions/:missionId/materials/cover-letter/pdf',
    '4.15',
    'bearer',
    'binary',
    {
      callerConstraint: 'owner-bearer+exact-official-extension-origin+exact-artifact',
      successStatuses: [200],
      responseCache: 'private,no-store',
    } as const,
  );
export const createMission = /*#__PURE__*/ endpoint(
    'POST',
    '/api/v1/agent/missions',
    '4.3',
    'bearer',
    'json',
    { successStatuses: [201, 200] } as const,
  );
/**
 * §4.3 这一页的岗位上下文：从一个申请 URL 认出／建出 canonical job。
 *
 * 2026-09-18 起「生成申请卡片」打的是这一条，不再打 `jobs/from-url`——后者在
 * argoland 里没有控制器，生产 404（实测）。这一条收同样的输入，而且一次给全
 * canonicalJobId、catalogSelector 与岗位名，三件事一起解开。
 */
export const createApplicationPageContext = /*#__PURE__*/ endpoint(
    'POST',
    '/api/v1/agent/missions/page-context',
    '4.3',
    'bearer',
    'json',
    { successStatuses: [200] } as const,
  );
/** §4.18 the catalog's second door: an identity from one application URL. */
export const createJobFromUrl = /*#__PURE__*/ endpoint(
    'POST',
    '/api/v1/agent/jobs/from-url',
    '4.18',
    'bearer',
    'json',
    { successStatuses: [201, 200] } as const,
  );
export const listResumeSelectionOptions = /*#__PURE__*/ endpoint(
    'GET',
    '/api/v1/agent/resume-selection-options',
    '4.8',
    'bearer',
    'json',
    {
      callerConstraint: 'owner-bearer',
      successStatuses: [200],
      responseCache: RESUME_SELECTION_CACHE_POLICY,
    } as const,
  );
export const getResumeLibrary = /*#__PURE__*/ endpoint(
    'GET',
    '/api/v1/agent/resume-library',
    '4.9',
    'bearer',
    'json',
    {
      callerConstraint: 'owner-bearer',
      successStatuses: [200],
      responseCache: RESUME_LIBRARY_CACHE_POLICY,
    } as const,
  );
export const createResumeTrack = /*#__PURE__*/ endpoint(
    'POST',
    '/api/v1/agent/resume-library/tracks',
    '4.9',
    'bearer',
    'json',
    {
      callerConstraint: 'owner-bearer+library-revision-CAS',
      successStatuses: [200],
      responseCache: RESUME_LIBRARY_CACHE_POLICY,
    } as const,
  );
export const renameResumeTrack = /*#__PURE__*/ endpoint(
    'PATCH',
    '/api/v1/agent/resume-library/tracks/:trackId',
    '4.9',
    'bearer',
    'json',
    {
      callerConstraint: 'owner-bearer+library-revision-CAS',
      successStatuses: [200],
      responseCache: RESUME_LIBRARY_CACHE_POLICY,
    } as const,
  );
export const archiveResumeTrack = /*#__PURE__*/ endpoint(
    'POST',
    '/api/v1/agent/resume-library/tracks/:trackId/archive',
    '4.9',
    'bearer',
    'json',
    {
      callerConstraint: 'owner-bearer+library-revision-CAS',
      successStatuses: [200],
      responseCache: RESUME_LIBRARY_CACHE_POLICY,
    } as const,
  );
export const restoreResumeTrack = /*#__PURE__*/ endpoint(
    'POST',
    '/api/v1/agent/resume-library/tracks/:trackId/restore',
    '4.9',
    'bearer',
    'json',
    {
      callerConstraint: 'owner-bearer+library-revision-CAS',
      successStatuses: [200],
      responseCache: RESUME_LIBRARY_CACHE_POLICY,
    } as const,
  );
export const setDefaultResumeTrack = /*#__PURE__*/ endpoint(
    'POST',
    '/api/v1/agent/resume-library/tracks/:trackId/default',
    '4.9',
    'bearer',
    'json',
    {
      callerConstraint: 'owner-bearer+library-revision-CAS',
      successStatuses: [200],
      responseCache: RESUME_LIBRARY_CACHE_POLICY,
    } as const,
  );
export const setResumeTrackCurrentVersion = /*#__PURE__*/ endpoint(
    'POST',
    '/api/v1/agent/resume-library/tracks/:trackId/versions/:resumeVersionId/current',
    '4.9',
    'bearer',
    'json',
    {
      callerConstraint: 'owner-bearer+library-revision-CAS',
      successStatuses: [200],
      responseCache: RESUME_LIBRARY_CACHE_POLICY,
    } as const,
  );
export const createJobResumeGeneration = /*#__PURE__*/ endpoint(
    'POST',
    '/api/v1/agent/resume-generations',
    '4.12',
    'bearer',
    'json',
    {
      callerConstraint:
        'owner-bearer+profile-revision-CAS+library-revision-CAS+canonical-job-authority',
      successStatuses: [201],
      responseCache: JOB_RESUME_GENERATION_CACHE_POLICY,
    } as const,
  );
export const getResumePdfMetadata = /*#__PURE__*/ endpoint(
    'GET', '/api/v1/agent/resume-versions/:resumeVersionId/pdf-metadata', '4.13', 'bearer', 'json',
    { callerConstraint: 'owner-bearer+exact-ready-version', successStatuses: [200], responseCache: RESUME_LIBRARY_CACHE_POLICY } as const,
  );
export const getCoverLetterRequirement = /*#__PURE__*/ endpoint(
    'POST', '/api/v1/agent/cover-letter/requirement', '4.14', 'bearer', 'json',
    { callerConstraint: 'owner-bearer+exact-canonical-job', successStatuses: [200], responseCache: RESUME_LIBRARY_CACHE_POLICY } as const,
  );
export const generateCoverLetterCandidate = /*#__PURE__*/ endpoint(
    'POST', '/api/v1/agent/cover-letter/generate', '4.14', 'bearer', 'json',
    { callerConstraint: 'owner-bearer+exact-canonical-job+server-requirement', successStatuses: [200], responseCache: RESUME_LIBRARY_CACHE_POLICY } as const,
  );
// 按页面附求职信（2026-09-27，argoland #653）：页面点名岗位，像简历附件那样。岗位库里的岗位用核实过的职位描述写，
// 别的页面用插件读到的页面职位描述写；只释出给写信的那一页。
export const lookupCoverLetterAttachment = /*#__PURE__*/ endpoint(
    'POST', '/api/v1/agent/cover-letter-attachments/lookup', '4.14', 'bearer', 'json',
    { callerConstraint: 'owner-bearer+page-target', successStatuses: [200], responseCache: RESUME_LIBRARY_CACHE_POLICY } as const,
  );
export const prepareCoverLetterAttachment = /*#__PURE__*/ endpoint(
    'POST', '/api/v1/agent/cover-letter-attachments/prepare', '4.14', 'bearer', 'json',
    { callerConstraint: 'owner-bearer+page-target+catalog-or-page-job', successStatuses: [200], responseCache: RESUME_LIBRARY_CACHE_POLICY } as const,
  );
export const releaseCoverLetterAttachmentText = /*#__PURE__*/ endpoint(
    'POST', '/api/v1/agent/cover-letter-attachments/text', '4.14', 'bearer', 'json',
    { callerConstraint: 'owner-bearer+page-target+exact-artifact', successStatuses: [200], responseCache: RESUME_LIBRARY_CACHE_POLICY } as const,
  );
export const releaseCoverLetterAttachmentPdf = /*#__PURE__*/ endpoint(
    'POST', '/api/v1/agent/cover-letter-attachments/pdf', '4.14', 'bearer', 'binary',
    { callerConstraint: 'owner-bearer+page-target+exact-artifact', successStatuses: [200], responseCache: RESUME_LIBRARY_CACHE_POLICY } as const,
  );
export const readResumePdf = /*#__PURE__*/ endpoint(
    'POST', '/api/v1/agent/resume-versions/:resumeVersionId/pdf', '4.13', 'bearer', 'binary',
    { callerConstraint: 'owner-bearer+exact-artifact-revision-snapshot', successStatuses: [200], responseCache: RESUME_LIBRARY_CACHE_POLICY } as const,
  );
// 把简历作为附件交给雇主（T9，argoland #514/#534）：问询不取字节，释出才取。
// 与 readResumePdf（本人查看）是两条路——那一条没有收件人、不留痕。
export const getResumeAtsAttachmentPlan = /*#__PURE__*/ endpoint(
    'POST', '/api/v1/agent/resume-attachments/plan', '4.13', 'bearer', 'json',
    { callerConstraint: 'owner-bearer+exact-ready-version', successStatuses: [200], responseCache: RESUME_LIBRARY_CACHE_POLICY } as const,
  );
export const getResumeAtsAttachmentPrepared = /*#__PURE__*/ endpoint(
    'POST', '/api/v1/agent/resume-attachments/prepared', '4.13', 'bearer', 'json',
    { callerConstraint: 'owner-bearer', successStatuses: [200], responseCache: RESUME_LIBRARY_CACHE_POLICY } as const,
  );
export const releaseResumeAtsAttachment = /*#__PURE__*/ endpoint(
    'POST', '/api/v1/agent/resume-attachments', '4.13', 'bearer', 'binary',
    { callerConstraint: 'owner-bearer+exact-artifact-revision-snapshot', successStatuses: [200], responseCache: RESUME_LIBRARY_CACHE_POLICY } as const,
  );
export const recordMissionApproval = /*#__PURE__*/ endpoint('POST', '/api/v1/agent/missions/:missionId/approval', '4.4', 'bearer', 'json');
export const cancelMission = /*#__PURE__*/ endpoint('POST', '/api/v1/agent/missions/:missionId/cancel', '4.5', 'bearer', 'json');
export const enterSubmissionBoundary = /*#__PURE__*/ endpoint(
    'POST',
    '/api/v1/agent/missions/:missionId/submission-boundaries',
    '4.6',
    'bearer',
    'json',
    {
      callerConstraint: 'owner-bearer+exact-official-extension-origin',
      successStatuses: [201, 200],
    } as const,
  );
export const recordSubmissionEvent = /*#__PURE__*/ endpoint(
    'POST',
    '/api/v1/agent/missions/:missionId/submission-events',
    '4.7',
    'bearer',
    'json',
    {
      callerConstraint: 'owner-bearer; SUBMISSION_TRIGGERED additionally exact-official-extension-origin',
      successStatuses: [201, 200],
    } as const,
  );
export const getExecutionIntentJwks = /*#__PURE__*/ endpoint('GET', '/.well-known/edaix-execution-intent-jwks.json', '5.2', 'public', 'json');
export const createSensitiveWriteConfirmation = /*#__PURE__*/ endpoint(
    'POST',
    '/api/v1/agent/missions/:missionId/sensitive-write-confirmations',
    '5.9.4',
    'bearer',
    'json',
    {
      callerConstraint: 'owner-bearer+exact-official-extension-origin',
      successStatuses: [201, 200],
    } as const,
  );
export const decideSensitiveWriteConfirmation = /*#__PURE__*/ endpoint(
    'POST',
    '/api/v1/agent/missions/:missionId/sensitive-write-confirmations/:confirmationId/decisions',
    '5.9.5',
    'bearer',
    'json',
    {
      callerConstraint: 'owner-bearer+exact-official-extension-origin+decision-token',
      successStatuses: [201, 200],
    } as const,
  );
export const issueExecutionIntent = /*#__PURE__*/ endpoint(
    'POST',
    '/api/v1/agent/missions/:missionId/execution-intents',
    '5.4',
    'bearer',
    'json',
    { successStatuses: [201] } as const,
  );
export const claimExecutionIntent = /*#__PURE__*/ endpoint(
    'POST',
    '/api/v1/agent/execution-intents/claim',
    '5.6',
    'bearer',
    'json',
    { successStatuses: [200] } as const,
  );
export const fetchSensitiveExecutionMaterial = /*#__PURE__*/ endpoint(
    'POST',
    '/api/v1/agent/execution-intents/sensitive-material',
    '5.9.7',
    'bearer',
    'json',
    {
      callerConstraint: 'owner-bearer+exact-official-extension-origin',
      successStatuses: [200],
      responseCache: SENSITIVE_EXECUTION_MATERIAL_CACHE_POLICY,
    } as const,
  );
export const submitApplicationReceipt = /*#__PURE__*/ endpoint(
    'POST',
    '/api/v1/agent/missions/:missionId/receipts',
    '5.7',
    'bearer',
    'json',
    { successStatuses: [201, 200] } as const,
  );
export const getApplicationProfile = /*#__PURE__*/ endpoint('GET', '/api/v1/agent/application-profile', '5.8', 'bearer', 'json');
export const listApplicationLedger = /*#__PURE__*/ endpoint('GET', '/api/v1/agent/application-ledger', '5.10', 'bearer', 'json');
export const updatePrimaryTimeZone = /*#__PURE__*/ endpoint('PATCH', '/api/v1/agent/account-preferences/primary-time-zone', '5.11', 'bearer', 'json');
export const createReferralRequest = /*#__PURE__*/ endpoint(
    'POST',
    '/api/v1/agent/referral-requests',
    '6.1',
    'bearer',
    'json',
    { successStatuses: [201, 200], responseCache: 'private,no-store' } as const,
  );
export const getReferralRequest = /*#__PURE__*/ endpoint(
    'GET',
    '/api/v1/agent/referral-requests/:referralRequestId',
    '6.2',
    'bearer',
    'json',
    { callerConstraint: 'owner-bearer', successStatuses: [200], responseCache: 'private,no-store' } as const,
  );
export const listAdminReferralRequests = /*#__PURE__*/ endpoint(
    'GET',
    '/api/v1/agent/admin/referral-requests',
    '6.3',
    'bearer',
    'json',
    { callerConstraint: 'database-role:ADMIN', successStatuses: [200], responseCache: 'private,no-store' } as const,
  );
export const getAdminReferralRequest = /*#__PURE__*/ endpoint(
    'GET',
    '/api/v1/agent/admin/referral-requests/:referralRequestId',
    '6.3',
    'bearer',
    'json',
    { callerConstraint: 'database-role:ADMIN', successStatuses: [200], responseCache: 'private,no-store' } as const,
  );
export const updateAdminReferralRequest = /*#__PURE__*/ endpoint(
    'PATCH',
    '/api/v1/agent/admin/referral-requests/:referralRequestId',
    '6.3',
    'bearer',
    'json',
    { callerConstraint: 'database-role:ADMIN+revision-CAS', successStatuses: [200], responseCache: 'private,no-store' } as const,
  );
export const updateAdminReferralOutcome = /*#__PURE__*/ endpoint(
    'PATCH', '/api/v1/agent/admin/referral-requests/:referralRequestId/outcome',
    '6.7', 'bearer', 'json',
    { callerConstraint: 'database-role:ADMIN+feature-default-off+revision-cas', successStatuses: [200], responseCache: 'private,no-store' } as const,
  );
export const listAdminJobIngestionRuns = /*#__PURE__*/ endpoint(
    'GET',
    '/api/v1/agent/admin/job-ingestion-runs',
    '5.26',
    'bearer',
    'json',
    {
      callerConstraint: 'database-role:ADMIN',
      successStatuses: [200],
      responseCache: 'private,no-store',
    } as const,
  );
export const listAdminReferralMentorBindings = /*#__PURE__*/ endpoint(
    'GET',
    '/api/v1/agent/admin/referral-mentor-bindings',
    '6.4',
    'bearer',
    'json',
    { callerConstraint: 'database-role:ADMIN+feature-default-off', successStatuses: [200], responseCache: 'private,no-store' } as const,
  );
export const updateAdminReferralMentorBinding = /*#__PURE__*/ endpoint(
    'PATCH',
    '/api/v1/agent/admin/referral-requests/:referralRequestId/mentor-binding',
    '6.4',
    'bearer',
    'json',
    { callerConstraint: 'database-role:ADMIN+revision-CAS+feature-default-off', successStatuses: [200], responseCache: 'private,no-store' } as const,
  );
export const listMentorReferralRequests = /*#__PURE__*/ endpoint(
    'GET', '/api/v1/agent/mentor/referral-requests', '6.4', 'bearer', 'json',
    { callerConstraint: 'database-role:REFERRAL_MENTOR+feature-default-off', successStatuses: [200], responseCache: 'private,no-store' } as const,
  );
export const decideMentorReferralRequest = /*#__PURE__*/ endpoint(
    'PATCH', '/api/v1/agent/mentor/referral-requests/:referralRequestId/decision',
    '6.4', 'bearer', 'json',
    { callerConstraint: 'database-role:REFERRAL_MENTOR+feature-default-off', successStatuses: [200], responseCache: 'private,no-store' } as const,
  );
export const completeMentorReferralRequest = /*#__PURE__*/ endpoint(
    'PATCH', '/api/v1/agent/mentor/referral-requests/:referralRequestId/completion',
    '6.5', 'bearer', 'json',
    { callerConstraint: 'database-role:REFERRAL_MENTOR+feature-default-off', successStatuses: [200], responseCache: 'private,no-store' } as const,
  );
export const replaceMentorCoffeeChatSlots = /*#__PURE__*/ endpoint(
    'PATCH', '/api/v1/agent/mentor/referral-requests/:referralRequestId/coffee-chat-slots',
    '6.4', 'bearer', 'json',
    { callerConstraint: 'database-role:REFERRAL_MENTOR+feature-default-off', successStatuses: [200], responseCache: 'private,no-store' } as const,
  );
export const setMentorCoffeeChatMeetingUrl = /*#__PURE__*/ endpoint(
    'PATCH', '/api/v1/agent/mentor/referral-requests/:referralRequestId/coffee-chat-meeting',
    '6.4', 'bearer', 'json',
    { callerConstraint: 'database-role:REFERRAL_MENTOR+feature-default-off', successStatuses: [200], responseCache: 'private,no-store' } as const,
  );
export const listStudentReferralCoffeeChats = /*#__PURE__*/ endpoint(
    'GET', '/api/v1/agent/referral-requests/coffee-chats', '6.4', 'bearer', 'json',
    { callerConstraint: 'database-role:STUDENT+feature-default-off', successStatuses: [200], responseCache: 'private,no-store' } as const,
  );
export const selectStudentCoffeeChatSlot = /*#__PURE__*/ endpoint(
    'PATCH', '/api/v1/agent/referral-requests/:referralRequestId/coffee-chat-selection',
    '6.4', 'bearer', 'json',
    { callerConstraint: 'database-role:STUDENT+feature-default-off', successStatuses: [200], responseCache: 'private,no-store' } as const,
  );
export const selectStudentReferralGuaranteeRemedy = /*#__PURE__*/ endpoint(
    'PATCH', '/api/v1/agent/referral-requests/:referralRequestId/guarantee-remedy',
    '6.5', 'bearer', 'json',
    { callerConstraint: 'database-role:STUDENT+feature-default-off', successStatuses: [200], responseCache: 'private,no-store' } as const,
  );
export const createReferralCheckout = /*#__PURE__*/ endpoint(
    'POST', '/api/v1/agent/referral-requests/:referralRequestId/checkout',
    '6.6', 'bearer', 'json',
    { callerConstraint: 'owner-bearer+feature-default-off', successStatuses: [201, 200], responseCache: 'private,no-store' } as const,
  );
export const getOwnerReferralCommerce = /*#__PURE__*/ endpoint(
    'GET', '/api/v1/agent/referral-requests/:referralRequestId/commerce',
    '6.6', 'bearer', 'json',
    { callerConstraint: 'exact-owner+feature-default-off', successStatuses: [200], responseCache: 'private,no-store' } as const,
  );
export const getAdminReferralCommerce = /*#__PURE__*/ endpoint(
    'GET', '/api/v1/agent/admin/referral-requests/:referralRequestId/commerce',
    '6.6', 'bearer', 'json',
    { callerConstraint: 'database-role:ADMIN+feature-default-off', successStatuses: [200], responseCache: 'private,no-store' } as const,
  );
export const executeAdminReferralRefund = /*#__PURE__*/ endpoint(
    'POST', '/api/v1/agent/admin/referral-requests/:referralRequestId/refund',
    '6.6', 'bearer', 'json',
    { callerConstraint: 'database-role:ADMIN+approved-policy+idempotent', successStatuses: [200], responseCache: 'private,no-store' } as const,
  );
export const reconcileAdminReferralRefund = /*#__PURE__*/ endpoint(
    'POST', '/api/v1/agent/admin/referral-requests/:referralRequestId/refund/reconcile',
    '6.6', 'bearer', 'json',
    { callerConstraint: 'database-role:ADMIN+provider-reconciliation', successStatuses: [200], responseCache: 'private,no-store' } as const,
  );
export const ingestTrustTelemetryEvent = /*#__PURE__*/ endpoint(
    'POST',
    '/api/v1/agent/trust-telemetry/events',
    '5.15',
    'bearer',
    'json',
    { callerConstraint: 'owner-bearer+bound-extension-install', successStatuses: [202] } as const,
  );
export const deleteTrustTelemetryIdentity = /*#__PURE__*/ endpoint(
    'POST',
    '/api/v1/agent/trust-telemetry/deletions',
    '5.15',
    'bearer',
    'json',
    { callerConstraint: 'owner-bearer+bound-extension-install', successStatuses: [202] } as const,
  );
export const computeGapStrength = /*#__PURE__*/ endpoint(
    'POST',
    '/api/v1/agent/planner/gap-strength/compute',
    '5.17',
    'bearer',
    'json',
    { callerConstraint: 'owner-bearer', successStatuses: [200], responseCache: 'private,no-store' } as const,
  );
export const computeGapAnalysisV2 = /*#__PURE__*/ endpoint(
    'POST',
    '/api/v1/agent/planner/gap-analysis-v2/compute',
    '5.17.1',
    'bearer',
    'json',
    { callerConstraint: 'owner-bearer', successStatuses: [200], responseCache: 'private,no-store' } as const,
  );
export const getLatestGapStrength = /*#__PURE__*/ endpoint(
    'POST',
    '/api/v1/agent/planner/gap-strength/latest',
    '5.17',
    'bearer',
    'json',
    { callerConstraint: 'owner-bearer', successStatuses: [200], responseCache: 'private,no-store' } as const,
  );
export const getLearningRecommendations = /*#__PURE__*/ endpoint(
    'POST',
    '/api/v1/agent/learning/recommendations',
    '5.19',
    'bearer',
    'json',
    { callerConstraint: 'owner-bearer+latest-gap-report+feature-default-off', successStatuses: [200], responseCache: 'private,no-store' } as const,
  );
export const getLearningRecommendationsV2 = /*#__PURE__*/ endpoint(
    'POST',
    '/api/v1/agent/learning/recommendations-v2',
    '5.19.1',
    'bearer',
    'json',
    { callerConstraint: 'owner-bearer+current-v2-report-snapshot+feature-default-off', successStatuses: [200], responseCache: 'private,no-store' } as const,
  );
export const getProfileStrengths = /*#__PURE__*/ endpoint(
    'GET',
    '/api/v1/agent/planner/profile-strengths',
    '5.17',
    'bearer',
    'json',
    { callerConstraint: 'owner-bearer', successStatuses: [200], responseCache: 'private,no-store' } as const,
  );
export const saveProfileStrength = /*#__PURE__*/ endpoint(
    'POST',
    '/api/v1/agent/planner/profile-strengths/save',
    '5.17',
    'bearer',
    'json',
    { callerConstraint: 'owner-bearer', successStatuses: [200], responseCache: 'private,no-store' } as const,
  );
export const removeProfileStrength = /*#__PURE__*/ endpoint(
    'POST',
    '/api/v1/agent/planner/profile-strengths/remove',
    '5.17',
    'bearer',
    'json',
    { callerConstraint: 'owner-bearer', successStatuses: [200], responseCache: 'private,no-store' } as const,
  );
export const classifyPilotUa2 = /*#__PURE__*/ endpoint(
    'POST',
    '/api/v1/agent/pilot/ua2/classify',
    '5.18',
    'bearer',
    'json',
    {
      callerConstraint: 'owner-bearer+website-entitlement+user-exact-page',
      successStatuses: [200],
      responseCache: 'private,no-store',
    } as const,
  );
// §5.23. This said 5.22 — the Answer Resolution section, which declares no
  // endpoint at all — and sourceSection is how a reader gets from a wire shape
  // to the semantics governing it; pointing at a neighbouring section is worse
  // than pointing nowhere.
export const composePilotUa5 = /*#__PURE__*/ endpoint(
    'POST',
    '/api/v1/agent/pilot/ua5/compose',
    '5.23',
    'bearer',
    'json',
    {
      callerConstraint: 'owner-bearer+website-entitlement+user-exact-page',
      successStatuses: [200],
      responseCache: 'private,no-store',
    } as const,
  );
export const checkPilotUa5ProfileCurrentness = /*#__PURE__*/ endpoint(
    'POST',
    '/api/v1/agent/pilot/ua5/profile-currentness',
    '5.24',
    'bearer',
    'json',
    {
      callerConstraint: 'owner-bearer+website-entitlement+user-exact-page+connected-dev-only',
      successStatuses: [200],
      responseCache: 'private,no-store',
    } as const,
  );
export const resolvePilotUa5ProfilePayloads = /*#__PURE__*/ endpoint(
    'POST',
    '/api/v1/agent/pilot/ua5/profile-payloads',
    '5.24',
    'bearer',
    'json',
    {
      callerConstraint: 'owner-bearer+website-entitlement+user-exact-page+connected-dev-only',
      successStatuses: [200],
      responseCache: 'private,no-store',
    } as const,
  );
export const generateApplicationQuestionCandidates = /*#__PURE__*/ endpoint(
    'POST', '/api/v1/agent/application-question-candidates', '4.15', 'bearer', 'json',
    { callerConstraint: 'owner-bearer+owned-mission', successStatuses: [200], responseCache: 'private,no-store' } as const,
  );
export const getApplicationQuestionSettings = /*#__PURE__*/ endpoint(
    'GET', '/api/v1/agent/application-question-settings', '4.16', 'bearer', 'json',
    { callerConstraint: 'owner-bearer', successStatuses: [200], responseCache: 'private,no-store' } as const,
  );
export const updateApplicationQuestionSettings = /*#__PURE__*/ endpoint(
    'PATCH', '/api/v1/agent/application-question-settings', '4.16', 'bearer', 'json',
    { callerConstraint: 'owner-bearer', successStatuses: [200], responseCache: 'private,no-store' } as const,
  );
export const listApplicationQuestionAnswers = /*#__PURE__*/ endpoint(
    'GET', '/api/v1/agent/application-question-answers', '4.16', 'bearer', 'json',
    { callerConstraint: 'owner-bearer', successStatuses: [200], responseCache: 'private,no-store' } as const,
  );
export const rememberApplicationQuestionAnswer = /*#__PURE__*/ endpoint(
    'POST', '/api/v1/agent/application-question-answers', '4.16', 'bearer', 'json',
    { callerConstraint: 'owner-bearer+owned-mission', successStatuses: [200], responseCache: 'private,no-store' } as const,
  );
/** AI 起草开放题（P3-13）：手势填写路上对着岗位起草作文题；草稿只进复核面板，用户改完回填。 */
export const createApplicationQuestionDrafts = /*#__PURE__*/ endpoint(
    'POST', '/api/v1/agent/application-question-drafts', '4.18', 'bearer', 'json',
    { callerConstraint: 'owner-bearer', successStatuses: [200], responseCache: 'private,no-store' } as const,
  );
export const forgetApplicationQuestionAnswer = /*#__PURE__*/ endpoint(
    'DELETE', '/api/v1/agent/application-question-answers/:answerId', '4.16', 'bearer', 'json',
    { callerConstraint: 'owner-bearer', successStatuses: [204], responseCache: 'private,no-store' } as const,
  );
export const clearApplicationQuestionAnswers = /*#__PURE__*/ endpoint(
    'DELETE', '/api/v1/agent/application-question-answers', '4.16', 'bearer', 'json',
    { callerConstraint: 'owner-bearer', successStatuses: [204], responseCache: 'private,no-store' } as const,
  );
export const getMissionApplicationQuestions = /*#__PURE__*/ endpoint(
    'GET', '/api/v1/agent/missions/:missionId/application-questions', '4.16', 'bearer', 'json',
    { callerConstraint: 'owner-bearer+owned-mission', successStatuses: [200], responseCache: 'private,no-store' } as const,
  );
export const getMissionAutofillConsent = /*#__PURE__*/ endpoint(
    'GET', '/api/v1/agent/mission-autofill-consent', '4.17', 'bearer', 'json',
    { callerConstraint: 'owner-bearer', successStatuses: [200], responseCache: 'private,no-store' } as const,
  );
export const recordMissionAutofillConsent = /*#__PURE__*/ endpoint(
    'POST', '/api/v1/agent/mission-autofill-consent', '4.17', 'bearer', 'json',
    { callerConstraint: 'owner-bearer', successStatuses: [200], responseCache: 'private,no-store' } as const,
  );
/**
 * Full AI 规划（argoland `contracts/http.ts` 的 `planFullAiAutofill`，逐项相同）。插件拿它做「AI 代答」：
 * 规则答不了的题交给服务端按用户自己确认过的资料起草。领域拒绝（付费墙、额度、开关）照契约放在 200 的
 * `FullAiResponse` 里；配额闸在更前面挡下时是 402 / 429。
 */
export const planFullAiAutofill = /*#__PURE__*/ endpoint(
    'POST', '/api/v1/agent/full-ai-autofill/plan', 'Full AI v1', 'bearer', 'json',
    { callerConstraint: 'owner-bearer', successStatuses: [200], responseCache: 'private,no-store' } as const,
  );
/**
 * 同一次规划的流式版（argoland `contracts/http.ts` 的 `streamFullAiAutofillPlan`，逐项相同；#620，2026-09-24）：
 * 请求与 plan 相同，应答是 `application/x-ndjson`，每行一个 `FullAiStreamEvent`——选择题与短事实先到、开放题随后，
 * 最后一行永远是 `done`。402 / 429 在第一行之前；之后的一切结局都在行里。
 */
export const streamFullAiAutofillPlan = /*#__PURE__*/ endpoint(
    'POST', '/api/v1/agent/full-ai-autofill/plan/stream', 'Full AI v1', 'bearer', 'ndjson',
    { callerConstraint: 'owner-bearer', successStatuses: [200], responseCache: 'private,no-store' } as const,
  );
/** 用户在一栏旁按「生成」：逐题写／改写一道文本题（与 plan 同一个额度）。 */
export const reviseFullAiAutofill = /*#__PURE__*/ endpoint(
    'POST', '/api/v1/agent/full-ai-autofill/revise', 'Full AI v1', 'bearer', 'json',
    { callerConstraint: 'owner-bearer', successStatuses: [200], responseCache: 'private,no-store' } as const,
  );
/** 这个月的 AI 次数（plan 与 revise 共用；会员不限）。 */
export const getFullAiAutofillQuota = /*#__PURE__*/ endpoint(
    'GET', '/api/v1/agent/full-ai-autofill/quota', 'Full AI v1', 'bearer', 'json',
    { callerConstraint: 'owner-bearer', successStatuses: [200], responseCache: 'private,no-store' } as const,
  );

export const AGENT_ENDPOINTS = {
  planFullAiAutofill,
  streamFullAiAutofillPlan,
  reviseFullAiAutofill,
  getFullAiAutofillQuota,
  getAssistantCoverDraft,
  writeAssistantCoverDraft,
  listAssistantJobs,
  listAssistantJobBatches,
  deliverAssistantJobs,
  decideAssistantJob,
  lookupAtsReport,
  startAtsReport,
  getAtsReport,
  listAdminSubscriptionRefunds,
  quoteAdminSubscriptionRefund,
  requestAdminSubscriptionRefund,
  reviewAdminSubscriptionRefund,
  retryAdminSubscriptionRefund,
  reviewAdminSubscriptionRefundAccess,
  getAgentSession,
  createConversation,
  listConversations,
  getConversation,
  getRolePreferences,
  updateRolePreferences,
  updateConversation,
  listConversationMessages,
  getConversationMessage,
  sendConversationMessage,
  decideConversationAction,
  getDailyReportPreference,
  updateDailyReportPreference,
  getDailyReportEmailPreference,
  updateDailyReportEmailPreference,
  listUnreadDailyReports,
  recordDailyReportRead,
  listRecommendationBatches,
  getRecommendationBatch,
  getRecommendationItemDetail,
  decideRecommendationBatch,
  refreshRecommendationBatch,
  confirmRecommendationItem,
  listAdminPolicies,
  createAdminPolicyDraft,
  publishAdminPolicy,
  listApplicationPreparations,
  startApplicationPreparations,
  retryApplicationPreparation,
  listMissions,
  getMission,
  getMissionApplicationTarget,
  resolveMissionPageBinding,
  ensureMissionStartApproval,
  getMissionMaterials,
  releaseMissionResume,
  requestMissionCoverLetter,
  releaseMissionCoverLetterText,
  releaseMissionCoverLetterPdf,
  createMission,
  createApplicationPageContext,
  createJobFromUrl,
  listResumeSelectionOptions,
  getResumeLibrary,
  createResumeTrack,
  renameResumeTrack,
  archiveResumeTrack,
  restoreResumeTrack,
  setDefaultResumeTrack,
  setResumeTrackCurrentVersion,
  createJobResumeGeneration,
  getResumePdfMetadata,
  getCoverLetterRequirement,
  generateCoverLetterCandidate,
  lookupCoverLetterAttachment,
  prepareCoverLetterAttachment,
  releaseCoverLetterAttachmentText,
  releaseCoverLetterAttachmentPdf,
  readResumePdf,
  getResumeAtsAttachmentPlan,
  getResumeAtsAttachmentPrepared,
  releaseResumeAtsAttachment,
  recordMissionApproval,
  cancelMission,
  enterSubmissionBoundary,
  recordSubmissionEvent,
  getExecutionIntentJwks,
  createSensitiveWriteConfirmation,
  decideSensitiveWriteConfirmation,
  issueExecutionIntent,
  claimExecutionIntent,
  fetchSensitiveExecutionMaterial,
  submitApplicationReceipt,
  getApplicationProfile,
  listApplicationLedger,
  updatePrimaryTimeZone,
  createReferralRequest,
  getReferralRequest,
  listAdminReferralRequests,
  getAdminReferralRequest,
  updateAdminReferralRequest,
  updateAdminReferralOutcome,
  listAdminJobIngestionRuns,
  listAdminReferralMentorBindings,
  updateAdminReferralMentorBinding,
  listMentorReferralRequests,
  decideMentorReferralRequest,
  completeMentorReferralRequest,
  replaceMentorCoffeeChatSlots,
  setMentorCoffeeChatMeetingUrl,
  listStudentReferralCoffeeChats,
  selectStudentCoffeeChatSlot,
  selectStudentReferralGuaranteeRemedy,
  createReferralCheckout,
  getOwnerReferralCommerce,
  getAdminReferralCommerce,
  executeAdminReferralRefund,
  reconcileAdminReferralRefund,
  ingestTrustTelemetryEvent,
  deleteTrustTelemetryIdentity,
  computeGapStrength,
  computeGapAnalysisV2,
  getLatestGapStrength,
  getLearningRecommendations,
  getLearningRecommendationsV2,
  getProfileStrengths,
  saveProfileStrength,
  removeProfileStrength,
  classifyPilotUa2,
  composePilotUa5,
  checkPilotUa5ProfileCurrentness,
  resolvePilotUa5ProfilePayloads,
  generateApplicationQuestionCandidates,
  getApplicationQuestionSettings,
  updateApplicationQuestionSettings,
  listApplicationQuestionAnswers,
  rememberApplicationQuestionAnswer,
  createApplicationQuestionDrafts,
  forgetApplicationQuestionAnswer,
  clearApplicationQuestionAnswers,
  getMissionApplicationQuestions,
  getMissionAutofillConsent,
  recordMissionAutofillConsent,
} as const;;
export type AgentEndpointId = keyof typeof AGENT_ENDPOINTS;

/** API-origin Extension credentials; the same path names on Chat retain their zero-byte BFF bodies. */
export const refresh = /*#__PURE__*/ endpoint('POST', '/auth/refresh', '2.3', 'public', 'json', {
    callerConstraint: 'allowlisted-extension-origin+refresh-secret', successStatuses: [201], responseCache: 'no-store',
  } as const);
export const logout = /*#__PURE__*/ endpoint('POST', '/auth/logout', '2.3', 'public', 'json', {
    callerConstraint: 'allowlisted-extension-origin+refresh-secret-revocation-capability', successStatuses: [201], responseCache: 'no-store',
  } as const);

export const EXTENSION_AUTH_SESSION_ENDPOINTS = {
  refresh,
  logout,
} as const;;

export const EXTENSION_AUTH_SESSION_ENDPOINT_ERROR_CODES = {
  refresh: ['VALIDATION_FAILED', 'ACCESS_DENIED', 'AUTH_REFRESH_INVALID', 'ACCOUNT_UNAVAILABLE', 'RATE_LIMITED', 'AGENT_UNAVAILABLE', 'INTERNAL_ERROR'],
  logout: ['VALIDATION_FAILED', 'ACCESS_DENIED', 'RATE_LIMITED', 'AGENT_UNAVAILABLE', 'INTERNAL_ERROR'],
} as const satisfies Record<keyof typeof EXTENSION_AUTH_SESSION_ENDPOINTS, readonly AgentErrorCode[]>;

export interface ExtensionAuthSessionEndpointContractMap {
  refresh: HttpContract<never, never, AuthServerRefreshRequest, ExtensionTokenPair>;
  logout: HttpContract<never, never, AuthServerLogoutRequest, LogoutAuthSessionResponse>;
}

export const AUTH_SESSION_ENDPOINTS = {
  joinWaitlist: endpoint('POST', '/waitlist', '2.5', 'public', 'json'),
  csrf: endpoint('GET', '/auth/csrf', '2.1', 'public', 'json'),
  register: endpoint('POST', '/auth/register', '2.1', 'public', 'json'),
  login: endpoint('POST', '/auth/login', '2.1', 'public', 'json'),
  googleLogin: endpoint('POST', '/auth/google', '2.1', 'public', 'json'),
  refresh: endpoint('POST', '/auth/refresh', '2.1', 'public', 'json'),
  logout: endpoint('POST', '/auth/logout', '2.1', 'public', 'json'),
  verifyEmail: endpoint('POST', '/auth/verify-email', '2.1', 'public', 'json'),
  resendEmailVerification: endpoint('POST', '/auth/resend-email-verification', '2.1', 'public', 'json'),
  exchangeRegistrationInvitation: endpoint('POST', '/auth/registration-invitations/exchange', '2.5', 'service-bearer', 'json'),
  getRegistrationContext: endpoint('POST', '/internal/auth/registration-context', '2.5', 'service-bearer', 'json'),
  listAdminWaitlist: endpoint('GET', '/admin/waitlist', '2.5', 'bearer', 'json'),
  createRegistrationInvitation: endpoint('POST', '/admin/waitlist/:waitlistEntryId/invitations', '2.5', 'bearer', 'json'),
  revokeRegistrationInvitation: endpoint('POST', '/admin/registration-invitations/:invitationId/revoke', '2.5', 'bearer', 'json'),
  resendRegistrationInvitation: endpoint('POST', '/admin/registration-invitations/:invitationId/resend', '2.5', 'bearer', 'json'),
  introspectSession: endpoint('POST', '/internal/auth/sessions/introspect', '2.2', 'service-bearer', 'json'),
  revokeSession: endpoint('POST', '/internal/auth/sessions/revoke', '2.2', 'service-bearer', 'json'),
  createExtensionHandoff: endpoint('POST', '/auth/extension-handoffs', '2.3', 'bearer', 'json'),
  redeemExtensionHandoff: endpoint('POST', '/auth/extension-handoffs/redeem', '2.3', 'public', 'json'),
  // 这两条在 Career Team 前缀下，不是 `/extension/installs`：服务端的
  // `src/extension` 已经占着那个路径，那是 Vibe ID 自己的安装登记（另一个产品，
  // 另一张表）。打成裸路径的后果是 link 写进了别人的表、status 直接 404，于是
  // 门户的连接自证永远拿不到 connected——实测 2026-09-16。
  linkExtensionInstall: endpoint('POST', '/api/v1/agent/extension-installs', '2.3', 'bearer', 'json'),
  attestExtensionInstall: endpoint(
    'POST',
    '/api/v1/agent/extension-installs/status',
    '2.3',
    'bearer',
    'json',
    { callerConstraint: 'owner-bearer', successStatuses: [200] } as const,
  ),
} as const;
export type AuthSessionEndpointId = keyof typeof AUTH_SESSION_ENDPOINTS;

/** 同上：逐条导出，聚合对象保留。 */
export const getOwnerApplicationProfileV2 = /*#__PURE__*/ endpoint(
    'GET',
    '/users/me/application-profile',
    '5.13',
    'bearer',
    'json',
    {
      callerConstraint: 'owner-bearer',
      successStatuses: [200],
      responseCache: PROFILE_V2_CACHE_POLICY,
    } as const,
  );
export const patchOwnerApplicationProfileV2 = /*#__PURE__*/ endpoint(
    'PATCH',
    '/users/me/application-profile',
    '5.13',
    'bearer',
    'json',
    {
      callerConstraint: 'owner-bearer',
      successStatuses: [200],
      responseCache: PROFILE_V2_CACHE_POLICY,
    } as const,
  );
export const deleteOwnerApplicationProfileV2 = /*#__PURE__*/ endpoint(
    'DELETE',
    '/users/me/application-profile',
    '5.13',
    'bearer',
    'json',
    {
      callerConstraint: 'owner-bearer',
      successStatuses: [200],
      responseCache: PROFILE_V2_CACHE_POLICY,
    } as const,
  );
export const createResumeProfileSuggestionsV1 = /*#__PURE__*/ endpoint(
    'POST',
    '/users/me/application-profile/resume-suggestions',
    '5.13.4',
    'bearer',
    'json',
    {
      callerConstraint: 'owner-bearer',
      successStatuses: [200],
      requestEncoding: 'multipart/form-data',
      fileField: 'file',
      consentField: 'consent',
      maxFileBytes: RESUME_PROFILE_SUGGESTION_UPLOAD_MAX_BYTES,
      responseCache: PROFILE_V2_CACHE_POLICY,
    } as const,
  );
/*
   * The standing profile directory: the same owner profile as the endpoints
   * above, without a fill grant, one path per section. EEO is not among them —
   * it is read and written on its own endpoints below, so a self-identification
   * answer never shares a response with the ordinary keys.
   */
export const getOwnerProfileDirectoryPersonalV1 = /*#__PURE__*/ endpoint(
    'GET', '/users/me/profile-directory/personal', '5.13.9', 'bearer', 'json',
    { callerConstraint: 'owner-bearer', successStatuses: [200], responseCache: PROFILE_V2_CACHE_POLICY } as const,
  );
export const replaceOwnerProfileDirectoryPersonalV1 = /*#__PURE__*/ endpoint(
    'PATCH', '/users/me/profile-directory/personal', '5.13.9', 'bearer', 'json',
    { callerConstraint: 'owner-bearer', successStatuses: [200], responseCache: PROFILE_V2_CACHE_POLICY } as const,
  );
export const getOwnerProfileDirectoryWorkAuthorizationV1 = /*#__PURE__*/ endpoint(
    'GET', '/users/me/profile-directory/work-authorization', '5.13.9', 'bearer', 'json',
    { callerConstraint: 'owner-bearer', successStatuses: [200], responseCache: PROFILE_V2_CACHE_POLICY } as const,
  );
export const replaceOwnerProfileDirectoryWorkAuthorizationV1 = /*#__PURE__*/ endpoint(
    'PATCH', '/users/me/profile-directory/work-authorization', '5.13.9', 'bearer', 'json',
    { callerConstraint: 'owner-bearer', successStatuses: [200], responseCache: PROFILE_V2_CACHE_POLICY } as const,
  );
export const getOwnerProfileDirectoryPreferencesV1 = /*#__PURE__*/ endpoint(
    'GET', '/users/me/profile-directory/preferences', '5.13.9', 'bearer', 'json',
    { callerConstraint: 'owner-bearer', successStatuses: [200], responseCache: PROFILE_V2_CACHE_POLICY } as const,
  );
export const replaceOwnerProfileDirectoryPreferencesV1 = /*#__PURE__*/ endpoint(
    'PATCH', '/users/me/profile-directory/preferences', '5.13.9', 'bearer', 'json',
    { callerConstraint: 'owner-bearer', successStatuses: [200], responseCache: PROFILE_V2_CACHE_POLICY } as const,
  );
export const getOwnerEeoSelfIdentificationV1 = /*#__PURE__*/ endpoint(
    'GET', '/api/v1/agent/eeo-self-identification', '5.13.8', 'bearer', 'json',
    { callerConstraint: 'owner-bearer', successStatuses: [200], responseCache: PROFILE_V2_CACHE_POLICY } as const,
  );
export const replaceOwnerEeoSelfIdentificationV1 = /*#__PURE__*/ endpoint(
    'PATCH', '/api/v1/agent/eeo-self-identification', '5.13.8', 'bearer', 'json',
    { callerConstraint: 'owner-bearer', successStatuses: [200], responseCache: PROFILE_V2_CACHE_POLICY } as const,
  );
export const deleteOwnerEeoSelfIdentificationV1 = /*#__PURE__*/ endpoint(
    'DELETE', '/api/v1/agent/eeo-self-identification', '5.13.8', 'bearer', 'json',
    { callerConstraint: 'owner-bearer', successStatuses: [204], responseCache: PROFILE_V2_CACHE_POLICY } as const,
  );
// 代填条款、声明与签名的同意（跟 argoland #600，§5.13.9）：插件只读这一条。
export const getOwnerApplicationSigningConsentV1 = /*#__PURE__*/ endpoint(
    'GET', '/api/v1/agent/consents/application-signing', '5.13.9', 'bearer', 'json',
    { callerConstraint: 'owner-bearer', successStatuses: [200], responseCache: PROFILE_V2_CACHE_POLICY } as const,
  );

// 同意与撤回（argoland `grantApplicationSigningConsent` / `revokeApplicationSigningConsent`，§5.13.9）：
// 2026-09-23 起插件的资料编辑器里也能开关这一项（负责人：资料要能直接在插件里改），与门户同一对端点。
// 2026-09-24 起同意的请求体是 `GrantApplicationSigningConsentRequest`（显示给用户的那一版文案的版本号），
// 与服务端当前版本不符一律 VALIDATION_FAILED；撤回仍然没有请求体。
export const grantOwnerApplicationSigningConsentV1 = /*#__PURE__*/ endpoint(
    'POST', '/api/v1/agent/consents/application-signing', '5.13.9', 'bearer', 'json',
    { callerConstraint: 'owner-bearer', successStatuses: [200], responseCache: PROFILE_V2_CACHE_POLICY } as const,
  );
export const revokeOwnerApplicationSigningConsentV1 = /*#__PURE__*/ endpoint(
    'DELETE', '/api/v1/agent/consents/application-signing', '5.13.9', 'bearer', 'json',
    { callerConstraint: 'owner-bearer', successStatuses: [200], responseCache: PROFILE_V2_CACHE_POLICY } as const,
  );

export const OWNER_PROFILE_V2_ENDPOINTS = {
  getOwnerApplicationProfileV2,
  patchOwnerApplicationProfileV2,
  deleteOwnerApplicationProfileV2,
  createResumeProfileSuggestionsV1,
  getOwnerProfileDirectoryPersonalV1,
  replaceOwnerProfileDirectoryPersonalV1,
  getOwnerProfileDirectoryWorkAuthorizationV1,
  replaceOwnerProfileDirectoryWorkAuthorizationV1,
  getOwnerProfileDirectoryPreferencesV1,
  replaceOwnerProfileDirectoryPreferencesV1,
  getOwnerEeoSelfIdentificationV1,
  replaceOwnerEeoSelfIdentificationV1,
  deleteOwnerEeoSelfIdentificationV1,
  getOwnerApplicationSigningConsentV1,
  grantOwnerApplicationSigningConsentV1,
  revokeOwnerApplicationSigningConsentV1,
} as const;
export type OwnerProfileV2EndpointId = keyof typeof OWNER_PROFILE_V2_ENDPOINTS;

export const joinWaitlistAuthErrors = ['VALIDATION_FAILED', 'WAITLIST_CHALLENGE_REQUIRED', 'RATE_LIMITED', 'AGENT_UNAVAILABLE', 'INTERNAL_ERROR'] as const;
export const csrfAuthErrors = ['AUTH_CSRF_INVALID', 'RATE_LIMITED', 'INTERNAL_ERROR'] as const;
export const registerAuthErrors = ['VALIDATION_FAILED', 'AUTH_CSRF_INVALID', 'AUTH_INVITATION_REQUIRED', 'AUTH_REGISTRATION_SESSION_INVALID', 'AUTH_EMAIL_ALREADY_REGISTERED', 'RATE_LIMITED', 'AGENT_UNAVAILABLE', 'INTERNAL_ERROR'] as const;
export const loginAuthErrors = ['VALIDATION_FAILED', 'AUTH_CSRF_INVALID', 'AUTH_INVALID_CREDENTIALS', 'RATE_LIMITED', 'AGENT_UNAVAILABLE', 'INTERNAL_ERROR'] as const;
export const googleLoginAuthErrors = ['VALIDATION_FAILED', 'AUTH_CSRF_INVALID', 'AUTH_INVALID_CREDENTIALS', 'AUTH_INVITATION_REQUIRED', 'AUTH_REGISTRATION_SESSION_INVALID', 'RATE_LIMITED', 'AGENT_UNAVAILABLE', 'INTERNAL_ERROR'] as const;
export const refreshAuthErrors = ['VALIDATION_FAILED', 'AUTH_CSRF_INVALID', 'AUTH_REFRESH_INVALID', 'ACCOUNT_UNAVAILABLE', 'RATE_LIMITED', 'AGENT_UNAVAILABLE', 'INTERNAL_ERROR'] as const;
export const logoutAuthErrors = ['VALIDATION_FAILED', 'AUTH_CSRF_INVALID', 'AUTH_REFRESH_INVALID', 'LOGIN_REQUIRED', 'RATE_LIMITED', 'AGENT_UNAVAILABLE', 'INTERNAL_ERROR'] as const;
export const verifyEmailAuthErrors = ['VALIDATION_FAILED', 'AUTH_CSRF_INVALID', 'AUTH_VERIFICATION_INVALID', 'RATE_LIMITED', 'AGENT_UNAVAILABLE', 'INTERNAL_ERROR'] as const;
export const resendEmailVerificationAuthErrors = ['VALIDATION_FAILED', 'AUTH_CSRF_INVALID', 'RATE_LIMITED', 'AGENT_UNAVAILABLE', 'INTERNAL_ERROR'] as const;
export const exchangeRegistrationInvitationAuthErrors = ['VALIDATION_FAILED', 'AUTH_INVITATION_INVALID', 'RATE_LIMITED', 'AGENT_UNAVAILABLE', 'INTERNAL_ERROR'] as const;
export const getRegistrationContextAuthErrors = ['VALIDATION_FAILED', 'AUTH_REGISTRATION_SESSION_INVALID', 'RATE_LIMITED', 'AGENT_UNAVAILABLE', 'INTERNAL_ERROR'] as const;
export const listAdminWaitlistAuthErrors = ['VALIDATION_FAILED', 'LOGIN_REQUIRED', 'ACCESS_DENIED', 'RATE_LIMITED', 'AGENT_UNAVAILABLE', 'INTERNAL_ERROR'] as const;
export const createRegistrationInvitationAuthErrors = ['VALIDATION_FAILED', 'LOGIN_REQUIRED', 'ACCESS_DENIED', 'AUTH_INVITATION_INVALID', 'RATE_LIMITED', 'AGENT_UNAVAILABLE', 'INTERNAL_ERROR'] as const;
export const revokeRegistrationInvitationAuthErrors = ['VALIDATION_FAILED', 'LOGIN_REQUIRED', 'ACCESS_DENIED', 'AUTH_INVITATION_INVALID', 'RATE_LIMITED', 'AGENT_UNAVAILABLE', 'INTERNAL_ERROR'] as const;
export const resendRegistrationInvitationAuthErrors = ['VALIDATION_FAILED', 'LOGIN_REQUIRED', 'ACCESS_DENIED', 'AUTH_INVITATION_INVALID', 'RATE_LIMITED', 'AGENT_UNAVAILABLE', 'INTERNAL_ERROR'] as const;
export const introspectSessionAuthErrors = ['VALIDATION_FAILED', 'LOGIN_REQUIRED', 'AUTH_REFRESH_INVALID', 'ACCOUNT_UNAVAILABLE', 'RATE_LIMITED', 'AGENT_UNAVAILABLE', 'INTERNAL_ERROR'] as const;
export const revokeSessionAuthErrors = ['VALIDATION_FAILED', 'LOGIN_REQUIRED', 'RATE_LIMITED', 'AGENT_UNAVAILABLE', 'INTERNAL_ERROR'] as const;
export const createExtensionHandoffAuthErrors = ['VALIDATION_FAILED', 'LOGIN_REQUIRED', 'ACCOUNT_UNAVAILABLE', 'RATE_LIMITED', 'AGENT_UNAVAILABLE', 'INTERNAL_ERROR'] as const;
export const redeemExtensionHandoffAuthErrors = ['VALIDATION_FAILED', 'AUTH_HANDOFF_INVALID', 'RATE_LIMITED', 'INTERNAL_ERROR'] as const;
export const linkExtensionInstallAuthErrors = ['VALIDATION_FAILED', 'LOGIN_REQUIRED', 'ACCOUNT_UNAVAILABLE', 'RATE_LIMITED', 'AGENT_UNAVAILABLE', 'INTERNAL_ERROR'] as const;
export const attestExtensionInstallAuthErrors = ['VALIDATION_FAILED', 'LOGIN_REQUIRED', 'ACCOUNT_UNAVAILABLE', 'RATE_LIMITED', 'AGENT_UNAVAILABLE', 'INTERNAL_ERROR'] as const;

export const AUTH_SESSION_ENDPOINT_ERROR_CODES = {
  joinWaitlist: joinWaitlistAuthErrors,
  csrf: csrfAuthErrors,
  register: registerAuthErrors,
  login: loginAuthErrors,
  googleLogin: googleLoginAuthErrors,
  refresh: refreshAuthErrors,
  logout: logoutAuthErrors,
  verifyEmail: verifyEmailAuthErrors,
  resendEmailVerification: resendEmailVerificationAuthErrors,
  exchangeRegistrationInvitation: exchangeRegistrationInvitationAuthErrors,
  getRegistrationContext: getRegistrationContextAuthErrors,
  listAdminWaitlist: listAdminWaitlistAuthErrors,
  createRegistrationInvitation: createRegistrationInvitationAuthErrors,
  revokeRegistrationInvitation: revokeRegistrationInvitationAuthErrors,
  resendRegistrationInvitation: resendRegistrationInvitationAuthErrors,
  introspectSession: introspectSessionAuthErrors,
  revokeSession: revokeSessionAuthErrors,
  createExtensionHandoff: createExtensionHandoffAuthErrors,
  redeemExtensionHandoff: redeemExtensionHandoffAuthErrors,
  linkExtensionInstall: linkExtensionInstallAuthErrors,
  attestExtensionInstall: attestExtensionInstallAuthErrors,
} as const satisfies Record<AuthSessionEndpointId, readonly AgentErrorCode[]>;

const common = [...COMMON_PRIVATE_ERROR_CODES] as const;
/**
 * 错误码逐条导出，再由下面的聚合对象组合。和上面的端点表同一个病：整体对象
 * 字面量无法按属性摇树，插件只用 enterSubmissionBoundary / recordSubmissionEvent
 * 两条，却要为全部条目付 17,852 字节。名字加 Errors 后缀，避开同名的端点常量。
 *
 * AUTH_SESSION_ENDPOINTS 故意没拆：它只有 2,090 字节，而它的 refresh 键和已有
 * 常量撞名，拆它的收益抵不上改名的噪音。
 */
export const listAssistantJobsErrors = [...common, 'PAYWALL_REQUIRED', 'CONVERSATION_NOT_FOUND', 'CONVERSATION_STATE_CONFLICT', 'JOB_UNAVAILABLE', 'ACTION_STATE_CONFLICT', 'USAGE_EXHAUSTED', 'RESOURCE_NOT_FOUND', 'VERSION_NOT_READY', 'RESUME_VERSION_STALE'] as const;
export const listAssistantJobBatchesErrors = [...common, 'PAYWALL_REQUIRED', 'CONVERSATION_NOT_FOUND', 'CONVERSATION_STATE_CONFLICT', 'JOB_UNAVAILABLE', 'ACTION_STATE_CONFLICT', 'USAGE_EXHAUSTED', 'RESOURCE_NOT_FOUND', 'VERSION_NOT_READY', 'RESUME_VERSION_STALE'] as const;
export const deliverAssistantJobsErrors = [...common, 'PAYWALL_REQUIRED', 'CONVERSATION_NOT_FOUND', 'CONVERSATION_STATE_CONFLICT', 'JOB_UNAVAILABLE', 'ACTION_STATE_CONFLICT', 'USAGE_EXHAUSTED', 'RESOURCE_NOT_FOUND', 'VERSION_NOT_READY', 'RESUME_VERSION_STALE'] as const;
export const decideAssistantJobErrors = [...common, 'PAYWALL_REQUIRED', 'CONVERSATION_NOT_FOUND', 'CONVERSATION_STATE_CONFLICT', 'JOB_UNAVAILABLE', 'ACTION_STATE_CONFLICT', 'USAGE_EXHAUSTED', 'RESOURCE_NOT_FOUND', 'VERSION_NOT_READY', 'RESUME_VERSION_STALE'] as const;
export const getAssistantCoverDraftErrors = [...common, 'JOB_UNAVAILABLE'] as const;
export const writeAssistantCoverDraftErrors = [...common, 'JOB_UNAVAILABLE', 'PAYWALL_REQUIRED', 'ACTION_STATE_CONFLICT', 'ACTION_IDEMPOTENCY_CONFLICT'] as const;
export const lookupAtsReportErrors = [...common, 'PAYWALL_REQUIRED', 'CONVERSATION_NOT_FOUND', 'CONVERSATION_STATE_CONFLICT', 'JOB_UNAVAILABLE', 'ACTION_STATE_CONFLICT', 'USAGE_EXHAUSTED', 'RESOURCE_NOT_FOUND', 'VERSION_NOT_READY', 'RESUME_VERSION_STALE'] as const;
export const startAtsReportErrors = [...common, 'PAYWALL_REQUIRED', 'CONVERSATION_NOT_FOUND', 'CONVERSATION_STATE_CONFLICT', 'JOB_UNAVAILABLE', 'ACTION_STATE_CONFLICT', 'USAGE_EXHAUSTED', 'RESOURCE_NOT_FOUND', 'VERSION_NOT_READY', 'RESUME_VERSION_STALE'] as const;
export const getAtsReportErrors = [...common, 'PAYWALL_REQUIRED', 'CONVERSATION_NOT_FOUND', 'CONVERSATION_STATE_CONFLICT', 'JOB_UNAVAILABLE', 'ACTION_STATE_CONFLICT', 'USAGE_EXHAUSTED', 'RESOURCE_NOT_FOUND', 'VERSION_NOT_READY', 'RESUME_VERSION_STALE'] as const;
export const listAdminSubscriptionRefundsErrors = [...common, 'ACCESS_DENIED', 'RESOURCE_NOT_FOUND', 'ACTION_STATE_CONFLICT'] as const;
export const quoteAdminSubscriptionRefundErrors = [...common, 'ACCESS_DENIED', 'RESOURCE_NOT_FOUND', 'ACTION_STATE_CONFLICT'] as const;
export const requestAdminSubscriptionRefundErrors = [...common, 'ACCESS_DENIED', 'RESOURCE_NOT_FOUND', 'ACTION_STATE_CONFLICT'] as const;
export const reviewAdminSubscriptionRefundErrors = [...common, 'ACCESS_DENIED', 'RESOURCE_NOT_FOUND', 'ACTION_STATE_CONFLICT'] as const;
export const retryAdminSubscriptionRefundErrors = [...common, 'ACCESS_DENIED', 'RESOURCE_NOT_FOUND', 'ACTION_STATE_CONFLICT'] as const;
export const reviewAdminSubscriptionRefundAccessErrors = [...common, 'ACCESS_DENIED', 'RESOURCE_NOT_FOUND', 'ACTION_STATE_CONFLICT'] as const;
export const getAgentSessionErrors = common;
export const createConversationErrors = [...common, 'PAYWALL_REQUIRED', 'CONVERSATION_IDEMPOTENCY_CONFLICT', 'CONVERSATION_ROLE_CONFLICT'] as const;
export const listConversationsErrors = [...common, 'PAYWALL_REQUIRED'] as const;
export const getConversationErrors = [...common, 'PAYWALL_REQUIRED', 'CONVERSATION_NOT_FOUND'] as const;
export const getRolePreferencesErrors = [...common, 'PAYWALL_REQUIRED', 'CONVERSATION_NOT_FOUND'] as const;
export const updateRolePreferencesErrors = [...common, 'PAYWALL_REQUIRED', 'CONVERSATION_NOT_FOUND', 'CONVERSATION_STATE_CONFLICT'] as const;
export const updateConversationErrors = [...common, 'PAYWALL_REQUIRED', 'CONVERSATION_NOT_FOUND', 'CONVERSATION_IDEMPOTENCY_CONFLICT', 'CONVERSATION_STATE_CONFLICT'] as const;
export const listConversationMessagesErrors = [...common, 'PAYWALL_REQUIRED', 'CONVERSATION_NOT_FOUND'] as const;
export const getConversationMessageErrors = [...common, 'PAYWALL_REQUIRED', 'CONVERSATION_NOT_FOUND', 'MESSAGE_NOT_FOUND'] as const;
export const sendConversationMessageErrors = [...common, 'CONVERSATION_NOT_FOUND', 'CONVERSATION_STATE_CONFLICT', 'MESSAGE_IDEMPOTENCY_CONFLICT', 'GENERATION_ALREADY_RUNNING', 'PAYWALL_REQUIRED', 'USAGE_EXHAUSTED', 'JOB_UNAVAILABLE'] as const;
export const decideConversationActionErrors = [...common, 'PAYWALL_REQUIRED', 'CONVERSATION_NOT_FOUND', 'CONVERSATION_STATE_CONFLICT', 'ACTION_NOT_FOUND', 'ACTION_STATE_CONFLICT', 'ACTION_EXPIRED', 'ACTION_IDEMPOTENCY_CONFLICT'] as const;
export const listRecommendationBatchesErrors = [...common, 'CONVERSATION_NOT_FOUND'] as const;
export const getRecommendationBatchErrors = [...common, 'RECOMMENDATION_BATCH_NOT_FOUND'] as const;
export const getRecommendationItemDetailErrors = [
    ...common,
    'RECOMMENDATION_BATCH_NOT_FOUND',
    'JOB_UNAVAILABLE',
    'JOB_EXPIRED',
    'JOB_IDENTITY_AMBIGUOUS',
  ] as const;
export const getDailyReportPreferenceErrors = common;
export const updateDailyReportPreferenceErrors = [...common, 'DAILY_REPORT_PREFERENCE_CONFLICT'] as const;
export const getDailyReportEmailPreferenceErrors = common;
export const updateDailyReportEmailPreferenceErrors = common;
export const listUnreadDailyReportsErrors = common;
export const recordDailyReportReadErrors = [...common, 'DAILY_REPORT_NOT_FOUND'] as const;
export const decideRecommendationBatchErrors = [...common, 'RECOMMENDATION_BATCH_NOT_FOUND', 'RECOMMENDATION_STATE_CONFLICT', 'RECOMMENDATION_IDEMPOTENCY_CONFLICT', 'PAYWALL_REQUIRED', 'NO_FINAL_RESUME', 'RESUME_PROCESSING', 'VERSION_NOT_READY'] as const;
export const refreshRecommendationBatchErrors = [...common, 'PAYWALL_REQUIRED', 'CONVERSATION_NOT_FOUND', 'RECOMMENDATION_REFRESH_NOT_READY', 'RECOMMENDATION_REFRESH_RATE_LIMITED'] as const;
export const confirmRecommendationItemErrors = [...common, 'PAYWALL_REQUIRED', 'RECOMMENDATION_BATCH_NOT_FOUND', 'RECOMMENDATION_STATE_CONFLICT'] as const;
export const listAdminPoliciesErrors = [...common, 'ACCESS_DENIED', 'RESOURCE_NOT_FOUND'] as const;
export const createAdminPolicyDraftErrors = [...common, 'ACCESS_DENIED', 'RESOURCE_NOT_FOUND', 'ACTION_STATE_CONFLICT'] as const;
export const publishAdminPolicyErrors = [...common, 'ACCESS_DENIED', 'RESOURCE_NOT_FOUND', 'ACTION_STATE_CONFLICT'] as const;
export const listApplicationPreparationsErrors = [...common, 'RECOMMENDATION_BATCH_NOT_FOUND', 'PAYWALL_REQUIRED'] as const;
export const startApplicationPreparationsErrors = [...common, 'RECOMMENDATION_BATCH_NOT_FOUND', 'RECOMMENDATION_STATE_CONFLICT',
    'RECOMMENDATION_IDEMPOTENCY_CONFLICT', 'PAYWALL_REQUIRED', 'PROFILE_EVIDENCE_REQUIRED', 'PROFILE_REVISION_MISMATCH',
    'CONVERSATION_STATE_CONFLICT', 'RESUME_TRACK_NOT_FOUND', 'LIBRARY_REVISION_MISMATCH', 'RESUME_VERSION_STALE'] as const;
export const retryApplicationPreparationErrors = [...common, 'RECOMMENDATION_BATCH_NOT_FOUND', 'RECOMMENDATION_STATE_CONFLICT',
    'RECOMMENDATION_IDEMPOTENCY_CONFLICT', 'PAYWALL_REQUIRED', 'CONVERSATION_STATE_CONFLICT'] as const;
export const listMissionsErrors = [...common, 'CONVERSATION_NOT_FOUND'] as const;
export const getMissionErrors = [...common, 'MISSION_NOT_FOUND'] as const;
export const getMissionApplicationTargetErrors = [
    ...common,
    'MISSION_NOT_FOUND',
    'JOB_UNAVAILABLE',
    'JOB_EXPIRED',
    'JOB_IDENTITY_AMBIGUOUS',
  ] as const;
export const resolveMissionPageBindingErrors = [...common, 'PAYWALL_REQUIRED'] as const;
export const ensureMissionStartApprovalErrors = [
    ...common,
    'PAYWALL_REQUIRED',
    'MISSION_NOT_FOUND',
    'MISSION_STATE_CONFLICT',
    'MISSION_IDEMPOTENCY_CONFLICT',
    'EXECUTION_APPROVAL_REQUIRED',
    'EXECUTION_TARGET_MISMATCH',
    'EXECUTION_INTENT_NOT_ALLOWED',
    'EXECUTION_POLICY_CHANGED',
    'EXECUTION_PLAN_MISMATCH',
    'EXTENSION_INSTALL_MISMATCH',
    'JOB_UNAVAILABLE',
    'JOB_EXPIRED',
    'JOB_IDENTITY_AMBIGUOUS',
    'APPLICATION_ALREADY_SUBMITTED',
    'APPLICATION_SUBMISSION_OUTCOME_UNKNOWN',
    'PROFILE_REVISION_MISMATCH',
    'PROFILE_DELETION_EPOCH_MISMATCH',
    'RESUME_VERSION_STALE',
    'RESUME_PROCESSING',
    'VERSION_NOT_READY',
    'CONVERSATION_NOT_FOUND',
    'CONVERSATION_STATE_CONFLICT',
  ] as const;
export const getMissionMaterialsErrors = [
    ...common,
    'PAYWALL_REQUIRED',
    'MISSION_NOT_FOUND',
    'MISSION_STATE_CONFLICT',
    'JOB_UNAVAILABLE',
    'JOB_EXPIRED',
    'JOB_IDENTITY_AMBIGUOUS',
  ] as const;
export const releaseMissionResumeErrors = [
    ...common,
    'PAYWALL_REQUIRED',
    'MISSION_NOT_FOUND',
    'MISSION_STATE_CONFLICT',
    'EXTENSION_INSTALL_MISMATCH',
    'ATTACHMENT_TARGET_NOT_ALLOWED',
    'JOB_UNAVAILABLE',
    'JOB_EXPIRED',
    'JOB_IDENTITY_AMBIGUOUS',
    'RESUME_VERSION_NOT_FOUND',
    'RESUME_VERSION_STALE',
    'LIBRARY_REVISION_MISMATCH',
    'VERSION_NOT_READY',
  ] as const;
export const requestMissionCoverLetterErrors = [
    ...common,
    'PAYWALL_REQUIRED',
    'USAGE_EXHAUSTED',
    'MISSION_NOT_FOUND',
    'MISSION_STATE_CONFLICT',
    'EXTENSION_INSTALL_MISMATCH',
    'JOB_UNAVAILABLE',
    'JOB_EXPIRED',
    'JOB_IDENTITY_AMBIGUOUS',
  ] as const;
export const releaseMissionCoverLetterErrors = [
    ...common,
    'PAYWALL_REQUIRED',
    'MISSION_NOT_FOUND',
    'MISSION_STATE_CONFLICT',
    'EXTENSION_INSTALL_MISMATCH',
    'ATTACHMENT_TARGET_NOT_ALLOWED',
    'JOB_UNAVAILABLE',
    'JOB_EXPIRED',
    'JOB_IDENTITY_AMBIGUOUS',
  ] as const;
export const createMissionErrors = [...common, 'MISSION_IDEMPOTENCY_CONFLICT', 'MISSION_STATE_CONFLICT', 'CONVERSATION_NOT_FOUND', 'CONVERSATION_STATE_CONFLICT', 'JOB_UNAVAILABLE', 'JOB_EXPIRED', 'JOB_IDENTITY_AMBIGUOUS', 'APPLICATION_ALREADY_SUBMITTED', 'APPLICATION_SUBMISSION_OUTCOME_UNKNOWN', 'NO_FINAL_RESUME', 'RESUME_PROCESSING', 'VERSION_NOT_READY', 'RESUME_VERSION_STALE', 'PROFILE_REVISION_MISMATCH', 'PROFILE_DELETION_EPOCH_MISMATCH', 'PAYWALL_REQUIRED'] as const;
export const createApplicationPageContextErrors = [...common] as const;
export const createJobFromUrlErrors = [...common, 'JOB_INTAKE_PROVIDER_UNSUPPORTED', 'JOB_INTAKE_PROVIDER_NOT_ENABLED', 'JOB_INTAKE_URL_UNPARSEABLE', 'JOB_INTAKE_POSTING_UNAVAILABLE', 'JOB_INTAKE_PROVIDER_UNAVAILABLE'] as const;
export const listResumeSelectionOptionsErrors = [...common, 'PAYWALL_REQUIRED'] as const;
export const getResumeLibraryErrors = [...common, 'PAYWALL_REQUIRED'] as const;
export const getCoverLetterRequirementErrors = common;
export const generateCoverLetterCandidateErrors = common;
// prepare 的领域失败答 200 { ok: false, code }（COVER_LETTER_ATTACHMENT_FAILURE_CODES），不在这里。
export const lookupCoverLetterAttachmentErrors = [...common, 'ATTACHMENT_TARGET_NOT_ALLOWED'] as const;
export const prepareCoverLetterAttachmentErrors = [...common, 'PAYWALL_REQUIRED', 'USAGE_EXHAUSTED', 'ATTACHMENT_TARGET_NOT_ALLOWED'] as const;
export const releaseCoverLetterAttachmentTextErrors = [...common, 'ATTACHMENT_TARGET_NOT_ALLOWED', 'COVER_LETTER_NOT_FOUND'] as const;
export const releaseCoverLetterAttachmentPdfErrors = [...common, 'ATTACHMENT_TARGET_NOT_ALLOWED', 'COVER_LETTER_NOT_FOUND'] as const;
export const generateApplicationQuestionCandidatesErrors = common;
export const getApplicationQuestionSettingsErrors = common;
export const updateApplicationQuestionSettingsErrors = common;
export const getMissionAutofillConsentErrors = common;
export const recordMissionAutofillConsentErrors = common;
export const listApplicationQuestionAnswersErrors = common;
export const rememberApplicationQuestionAnswerErrors = common;
export const createApplicationQuestionDraftsErrors = common;
export const forgetApplicationQuestionAnswerErrors = [...common, 'RESOURCE_NOT_FOUND'] as const;
export const clearApplicationQuestionAnswersErrors = common;
export const getMissionApplicationQuestionsErrors = [
    ...common,
    'MISSION_NOT_FOUND',
    'JOB_UNAVAILABLE',
    'JOB_EXPIRED',
    'JOB_IDENTITY_AMBIGUOUS',
  ] as const;
export const createResumeTrackErrors = [...common, 'PAYWALL_REQUIRED', 'LIBRARY_REVISION_MISMATCH', 'RESUME_TRACK_LIMIT_REACHED'] as const;
export const getResumePdfMetadataErrors = [...common, 'RESUME_VERSION_NOT_FOUND', 'VERSION_NOT_READY', 'RESUME_VERSION_STALE'] as const;
export const readResumePdfErrors = [...common, 'RESUME_VERSION_NOT_FOUND', 'VERSION_NOT_READY', 'RESUME_VERSION_STALE', 'LIBRARY_REVISION_MISMATCH'] as const;
// 附件释出：与本人查看同一套版本围栏，另加一条收件人被运营清单拒的路。
export const getResumeAtsAttachmentPlanErrors = [...common, 'RESUME_VERSION_NOT_FOUND', 'VERSION_NOT_READY', 'RESUME_VERSION_STALE', 'ATTACHMENT_TARGET_NOT_ALLOWED'] as const;
export const getResumeAtsAttachmentPreparedErrors = [...common, 'ATTACHMENT_TARGET_NOT_ALLOWED'] as const;
export const releaseResumeAtsAttachmentErrors = [...common, 'RESUME_VERSION_NOT_FOUND', 'VERSION_NOT_READY', 'RESUME_VERSION_STALE', 'LIBRARY_REVISION_MISMATCH', 'ATTACHMENT_TARGET_NOT_ALLOWED'] as const;
export const renameResumeTrackErrors = [...common, 'PAYWALL_REQUIRED', 'RESUME_TRACK_NOT_FOUND', 'LIBRARY_REVISION_MISMATCH'] as const;
export const archiveResumeTrackErrors = [...common, 'PAYWALL_REQUIRED', 'RESUME_TRACK_NOT_FOUND', 'RESUME_TRACK_ARCHIVED', 'RESUME_DEFAULT_REPLACEMENT_REQUIRED', 'VERSION_NOT_READY', 'LIBRARY_REVISION_MISMATCH'] as const;
export const restoreResumeTrackErrors = [...common, 'PAYWALL_REQUIRED', 'RESUME_TRACK_NOT_FOUND', 'RESUME_TRACK_NOT_ARCHIVED', 'RESUME_TRACK_LIMIT_REACHED', 'VERSION_NOT_READY', 'LIBRARY_REVISION_MISMATCH'] as const;
export const setDefaultResumeTrackErrors = [...common, 'PAYWALL_REQUIRED', 'RESUME_TRACK_NOT_FOUND', 'RESUME_TRACK_ARCHIVED', 'VERSION_NOT_READY', 'LIBRARY_REVISION_MISMATCH'] as const;
export const setResumeTrackCurrentVersionErrors = [...common, 'PAYWALL_REQUIRED', 'RESUME_TRACK_NOT_FOUND', 'RESUME_TRACK_ARCHIVED', 'RESUME_VERSION_NOT_FOUND', 'VERSION_NOT_READY', 'LIBRARY_REVISION_MISMATCH'] as const;
export const createJobResumeGenerationErrors = [
    ...common,
    'JOB_UNAVAILABLE',
    'JOB_EXPIRED',
    'JOB_IDENTITY_AMBIGUOUS',
    'PROFILE_REVISION_MISMATCH',
    'PROFILE_DELETION_EPOCH_MISMATCH',
    'PROFILE_EVIDENCE_REQUIRED',
    'RESUME_TRACK_NOT_FOUND',
    'RESUME_TRACK_ARCHIVED',
    'RESUME_VERSION_NOT_FOUND',
    'VERSION_NOT_READY',
    'LIBRARY_REVISION_MISMATCH',
    'RESUME_GENERATION_IDEMPOTENCY_CONFLICT',
  ] as const;
export const recordMissionApprovalErrors = [...common, 'MISSION_NOT_FOUND', 'MISSION_STEP_NOT_FOUND', 'MISSION_STATE_CONFLICT', 'APPROVAL_NOT_READY', 'EXECUTION_PLAN_MISMATCH', 'ACTION_NOT_FOUND', 'ACTION_STATE_CONFLICT', 'ACTION_EXPIRED', 'ACTION_IDEMPOTENCY_CONFLICT', 'PROFILE_REVISION_MISMATCH', 'PROFILE_DELETION_EPOCH_MISMATCH'] as const;
export const cancelMissionErrors = [...common, 'MISSION_NOT_FOUND', 'MISSION_STATE_CONFLICT'] as const;
export const enterSubmissionBoundaryErrors = [...common, 'MISSION_NOT_FOUND', 'MISSION_STEP_NOT_FOUND', 'MISSION_IDEMPOTENCY_CONFLICT', 'MISSION_STATE_CONFLICT', 'EXECUTION_PLAN_MISMATCH', 'EXTENSION_INSTALL_MISMATCH', 'EXECUTION_LEASE_EXPIRED', 'JOB_UNAVAILABLE', 'JOB_EXPIRED', 'JOB_IDENTITY_AMBIGUOUS', 'APPLICATION_ALREADY_SUBMITTED', 'APPLICATION_SUBMISSION_OUTCOME_UNKNOWN'] as const;
export const recordSubmissionEventErrors = [...common, 'MISSION_NOT_FOUND', 'MISSION_IDEMPOTENCY_CONFLICT', 'MISSION_STATE_CONFLICT', 'EXECUTION_PLAN_MISMATCH', 'EXTENSION_INSTALL_MISMATCH', 'EXECUTION_LEASE_EXPIRED', 'APPLICATION_ALREADY_SUBMITTED'] as const;
export const getExecutionIntentJwksErrors = ['RATE_LIMITED', 'AGENT_UNAVAILABLE', 'INTERNAL_ERROR'] as const;
export const createSensitiveWriteConfirmationErrors = [...common, 'MISSION_NOT_FOUND', 'MISSION_STEP_NOT_FOUND', 'RECEIPT_IDEMPOTENCY_CONFLICT', 'RECEIPT_INTENT_NOT_CLAIMED', 'RECEIPT_SCOPE_MISMATCH', 'RECEIPT_VERIFICATION_FAILED', 'EXECUTION_CLIENT_UPGRADE_REQUIRED', 'EXECUTION_POLICY_CHANGED', 'EXECUTION_LEASE_EXPIRED', 'EXTENSION_INSTALL_MISMATCH', 'MISSION_STATE_CONFLICT'] as const;
export const decideSensitiveWriteConfirmationErrors = [...common, 'MISSION_NOT_FOUND', 'SENSITIVE_WRITE_CONFIRMATION_NOT_FOUND', 'SENSITIVE_WRITE_RELEASE_STATE_CONFLICT', 'SENSITIVE_WRITE_RELEASE_IDEMPOTENCY_CONFLICT', 'SENSITIVE_WRITE_RELEASE_STALE', 'SENSITIVE_WRITE_RELEASE_EXPIRED', 'EXECUTION_CLIENT_UPGRADE_REQUIRED', 'EXECUTION_POLICY_CHANGED', 'EXTENSION_INSTALL_MISMATCH'] as const;
export const issueExecutionIntentErrors = [...common, 'MISSION_NOT_FOUND', 'MISSION_STEP_NOT_FOUND', 'MISSION_STATE_CONFLICT', 'EXECUTION_APPROVAL_REQUIRED', 'EXECUTION_PLAN_MISMATCH', 'EXECUTION_INTENT_NOT_ALLOWED', 'EXECUTION_CLIENT_UPGRADE_REQUIRED', 'SENSITIVE_WRITE_RELEASE_NOT_FOUND', 'SENSITIVE_WRITE_RELEASE_STATE_CONFLICT', 'SENSITIVE_WRITE_RELEASE_STALE', 'SENSITIVE_WRITE_RELEASE_EXPIRED', 'EXTENSION_INSTALL_MISMATCH', 'JOB_UNAVAILABLE', 'JOB_EXPIRED', 'JOB_IDENTITY_AMBIGUOUS', 'APPLICATION_ALREADY_SUBMITTED', 'APPLICATION_SUBMISSION_OUTCOME_UNKNOWN', 'NO_FINAL_RESUME', 'RESUME_PROCESSING', 'VERSION_NOT_READY', 'RESUME_VERSION_STALE', 'PROFILE_REVISION_MISMATCH', 'PROFILE_DELETION_EPOCH_MISMATCH', 'PAYWALL_REQUIRED', 'USAGE_EXHAUSTED'] as const;
export const claimExecutionIntentErrors = [...common, 'EXECUTION_INTENT_INVALID', 'EXECUTION_INTENT_EXPIRED', 'EXECUTION_INTENT_SUPERSEDED', 'EXECUTION_INTENT_CONSUMED', 'EXECUTION_CLIENT_UPGRADE_REQUIRED', 'EXECUTION_TARGET_MISMATCH', 'EXECUTION_FIELD_SET_MISMATCH', 'EXECUTION_PLAN_MISMATCH', 'EXECUTION_POLICY_CHANGED', 'SENSITIVE_WRITE_RELEASE_NOT_FOUND', 'SENSITIVE_WRITE_RELEASE_STATE_CONFLICT', 'SENSITIVE_WRITE_RELEASE_STALE', 'SENSITIVE_WRITE_RELEASE_EXPIRED', 'EXTENSION_INSTALL_MISMATCH', 'MISSION_NOT_FOUND', 'MISSION_STEP_NOT_FOUND', 'MISSION_STATE_CONFLICT', 'EXECUTION_APPROVAL_REQUIRED', 'JOB_UNAVAILABLE', 'JOB_EXPIRED', 'JOB_IDENTITY_AMBIGUOUS', 'APPLICATION_ALREADY_SUBMITTED', 'APPLICATION_SUBMISSION_OUTCOME_UNKNOWN', 'NO_FINAL_RESUME', 'RESUME_PROCESSING', 'VERSION_NOT_READY', 'RESUME_VERSION_STALE', 'LIBRARY_REVISION_MISMATCH', 'PROFILE_REVISION_MISMATCH', 'PROFILE_DELETION_EPOCH_MISMATCH', 'PAYWALL_REQUIRED', 'USAGE_EXHAUSTED'] as const;
export const fetchSensitiveExecutionMaterialErrors = [...common, 'EXECUTION_CLIENT_UPGRADE_REQUIRED', 'SENSITIVE_WRITE_RELEASE_NOT_FOUND', 'SENSITIVE_WRITE_RELEASE_STATE_CONFLICT', 'SENSITIVE_WRITE_RELEASE_STALE', 'SENSITIVE_WRITE_RELEASE_EXPIRED', 'SENSITIVE_EXECUTION_MATERIAL_UNAVAILABLE', 'SENSITIVE_EXECUTION_MATERIAL_SCOPE_MISMATCH', 'EXECUTION_POLICY_CHANGED', 'EXECUTION_LEASE_EXPIRED', 'EXTENSION_INSTALL_MISMATCH', 'MISSION_NOT_FOUND', 'MISSION_STEP_NOT_FOUND'] as const;
export const submitApplicationReceiptErrors = [...common, 'MISSION_NOT_FOUND', 'MISSION_STEP_NOT_FOUND', 'RECEIPT_IDEMPOTENCY_CONFLICT', 'RECEIPT_INTENT_NOT_CLAIMED', 'RECEIPT_SCOPE_MISMATCH', 'RECEIPT_VERIFICATION_FAILED', 'SENSITIVE_WRITE_RELEASE_STATE_CONFLICT', 'EXECUTION_LEASE_EXPIRED', 'EXTENSION_INSTALL_MISMATCH', 'MISSION_STATE_CONFLICT'] as const;
export const getApplicationProfileErrors = ['VALIDATION_FAILED', 'LOGIN_REQUIRED', 'ACCOUNT_UNAVAILABLE', 'RATE_LIMITED', 'AGENT_UNAVAILABLE', 'INTERNAL_ERROR'] as const;
export const listApplicationLedgerErrors = common;
export const updatePrimaryTimeZoneErrors = common;
export const createReferralRequestErrors = [...common, 'PAYWALL_REQUIRED'] as const;
export const getReferralRequestErrors = [...common, 'PAYWALL_REQUIRED', 'REFERRAL_REQUEST_NOT_FOUND'] as const;
export const listAdminReferralRequestsErrors = common;
export const getAdminReferralRequestErrors = [...common, 'REFERRAL_REQUEST_NOT_FOUND'] as const;
export const updateAdminReferralRequestErrors = [...common, 'REFERRAL_REQUEST_NOT_FOUND', 'REFERRAL_STATE_CONFLICT', 'REFERRAL_TRANSITION_INVALID'] as const;
export const updateAdminReferralOutcomeErrors = [...common, 'REFERRAL_REQUEST_NOT_FOUND', 'REFERRAL_OUTCOME_DISABLED', 'REFERRAL_OUTCOME_CONFLICT'] as const;
export const listAdminJobIngestionRunsErrors = [...common, 'ACCESS_DENIED'] as const;
export const listAdminReferralMentorBindingsErrors = [...common, 'ACCESS_DENIED', 'MENTOR_COFFEE_CHAT_DISABLED'] as const;
export const updateAdminReferralMentorBindingErrors = [...common, 'ACCESS_DENIED', 'MENTOR_COFFEE_CHAT_DISABLED', 'REFERRAL_REQUEST_NOT_FOUND', 'REFERRAL_STATE_CONFLICT', 'REFERRAL_MENTOR_NOT_AVAILABLE'] as const;
export const listMentorReferralRequestsErrors = [...common, 'ACCESS_DENIED', 'MENTOR_COFFEE_CHAT_DISABLED'] as const;
export const decideMentorReferralRequestErrors = [...common, 'ACCESS_DENIED', 'MENTOR_COFFEE_CHAT_DISABLED', 'REFERRAL_REQUEST_NOT_FOUND', 'REFERRAL_STATE_CONFLICT'] as const;
export const completeMentorReferralRequestErrors = [...common, 'ACCESS_DENIED', 'MENTOR_COFFEE_CHAT_DISABLED', 'REFERRAL_GUARANTEE_DISABLED', 'REFERRAL_REQUEST_NOT_FOUND', 'REFERRAL_STATE_CONFLICT'] as const;
export const replaceMentorCoffeeChatSlotsErrors = [...common, 'ACCESS_DENIED', 'MENTOR_COFFEE_CHAT_DISABLED', 'REFERRAL_REQUEST_NOT_FOUND', 'REFERRAL_STATE_CONFLICT'] as const;
export const setMentorCoffeeChatMeetingUrlErrors = [...common, 'ACCESS_DENIED', 'MENTOR_COFFEE_CHAT_DISABLED', 'REFERRAL_REQUEST_NOT_FOUND', 'REFERRAL_STATE_CONFLICT', 'REFERRAL_COFFEE_CHAT_SLOT_NOT_FOUND'] as const;
export const listStudentReferralCoffeeChatsErrors = [...common, 'PAYWALL_REQUIRED', 'ACCESS_DENIED', 'MENTOR_COFFEE_CHAT_DISABLED'] as const;
export const selectStudentCoffeeChatSlotErrors = [...common, 'PAYWALL_REQUIRED', 'ACCESS_DENIED', 'MENTOR_COFFEE_CHAT_DISABLED', 'REFERRAL_REQUEST_NOT_FOUND', 'REFERRAL_STATE_CONFLICT', 'REFERRAL_COFFEE_CHAT_SLOT_NOT_FOUND'] as const;
export const selectStudentReferralGuaranteeRemedyErrors = [...common, 'PAYWALL_REQUIRED', 'ACCESS_DENIED', 'MENTOR_COFFEE_CHAT_DISABLED', 'REFERRAL_GUARANTEE_DISABLED', 'REFERRAL_REQUEST_NOT_FOUND', 'REFERRAL_STATE_CONFLICT', 'REFERRAL_GUARANTEE_REMEDY_UNAVAILABLE'] as const;
export const createReferralCheckoutErrors = [...common, 'PAYWALL_REQUIRED', 'REFERRAL_COMMERCE_DISABLED', 'REFERRAL_REQUEST_NOT_FOUND', 'ACTION_STATE_CONFLICT'] as const;
export const getOwnerReferralCommerceErrors = [...common, 'PAYWALL_REQUIRED', 'REFERRAL_COMMERCE_DISABLED', 'REFERRAL_REQUEST_NOT_FOUND'] as const;
export const getAdminReferralCommerceErrors = [...common, 'ACCESS_DENIED', 'REFERRAL_COMMERCE_DISABLED', 'REFERRAL_REQUEST_NOT_FOUND'] as const;
export const executeAdminReferralRefundErrors = [...common, 'ACCESS_DENIED', 'REFERRAL_COMMERCE_DISABLED', 'REFERRAL_REQUEST_NOT_FOUND', 'REFERRAL_PAYMENT_REQUIRED', 'REFERRAL_REFUND_NOT_AVAILABLE', 'REFERRAL_REFUND_RECONCILIATION_REQUIRED'] as const;
export const reconcileAdminReferralRefundErrors = [...common, 'ACCESS_DENIED', 'REFERRAL_COMMERCE_DISABLED', 'REFERRAL_REQUEST_NOT_FOUND', 'REFERRAL_PAYMENT_REQUIRED', 'REFERRAL_REFUND_RECONCILIATION_REQUIRED'] as const;
export const ingestTrustTelemetryEventErrors = [...common, 'EXTENSION_INSTALL_MISMATCH', 'TELEMETRY_DISABLED', 'TELEMETRY_PROVIDER_UNAVAILABLE'] as const;
export const deleteTrustTelemetryIdentityErrors = [...common, 'EXTENSION_INSTALL_MISMATCH', 'TELEMETRY_DISABLED', 'TELEMETRY_PROVIDER_UNAVAILABLE'] as const;
export const computeGapStrengthErrors = [...common, 'PAYWALL_REQUIRED'] as const;
export const computeGapAnalysisV2Errors = [...common, 'PAYWALL_REQUIRED'] as const;
export const getLatestGapStrengthErrors = [...common, 'PAYWALL_REQUIRED'] as const;
export const getLearningRecommendationsErrors = [...common, 'PAYWALL_REQUIRED'] as const;
export const getLearningRecommendationsV2Errors = [...common, 'PAYWALL_REQUIRED'] as const;
export const getProfileStrengthsErrors = [...common, 'PAYWALL_REQUIRED'] as const;
export const saveProfileStrengthErrors = [...common, 'PAYWALL_REQUIRED'] as const;
export const removeProfileStrengthErrors = [...common, 'PAYWALL_REQUIRED'] as const;
export const classifyPilotUa2Errors = common;
export const composePilotUa5Errors = common;
export const checkPilotUa5ProfileCurrentnessErrors = [...common, 'PAYWALL_REQUIRED'] as const;
export const resolvePilotUa5ProfilePayloadsErrors = [...common, 'PAYWALL_REQUIRED'] as const;

export const AGENT_ENDPOINT_ERROR_CODES = {
  // Domain refusals use the closed FullAiResponse union in a 200 response.
  planFullAiAutofill: [...common, 'PAYWALL_REQUIRED', 'USAGE_EXHAUSTED'],
  // Quota refusals come before the first line; every later outcome is in-band.
  streamFullAiAutofillPlan: [...common, 'PAYWALL_REQUIRED', 'USAGE_EXHAUSTED'],
  // Same quota meter as plan; domain refusals are the closed union in a 200.
  reviseFullAiAutofill: [...common, 'PAYWALL_REQUIRED', 'USAGE_EXHAUSTED'],
  getFullAiAutofillQuota: common,
  listAssistantJobs: listAssistantJobsErrors,
  listAssistantJobBatches: listAssistantJobBatchesErrors,
  deliverAssistantJobs: deliverAssistantJobsErrors,
  decideAssistantJob: decideAssistantJobErrors,
  getAssistantCoverDraft: getAssistantCoverDraftErrors,
  writeAssistantCoverDraft: writeAssistantCoverDraftErrors,
  lookupAtsReport: lookupAtsReportErrors,
  startAtsReport: startAtsReportErrors,
  getAtsReport: getAtsReportErrors,
  listAdminSubscriptionRefunds: listAdminSubscriptionRefundsErrors,
  quoteAdminSubscriptionRefund: quoteAdminSubscriptionRefundErrors,
  requestAdminSubscriptionRefund: requestAdminSubscriptionRefundErrors,
  reviewAdminSubscriptionRefund: reviewAdminSubscriptionRefundErrors,
  retryAdminSubscriptionRefund: retryAdminSubscriptionRefundErrors,
  reviewAdminSubscriptionRefundAccess: reviewAdminSubscriptionRefundAccessErrors,
  getAgentSession: getAgentSessionErrors,
  createConversation: createConversationErrors,
  listConversations: listConversationsErrors,
  getConversation: getConversationErrors,
  getRolePreferences: getRolePreferencesErrors,
  updateRolePreferences: updateRolePreferencesErrors,
  updateConversation: updateConversationErrors,
  listConversationMessages: listConversationMessagesErrors,
  getConversationMessage: getConversationMessageErrors,
  sendConversationMessage: sendConversationMessageErrors,
  decideConversationAction: decideConversationActionErrors,
  listRecommendationBatches: listRecommendationBatchesErrors,
  getRecommendationBatch: getRecommendationBatchErrors,
  getRecommendationItemDetail: getRecommendationItemDetailErrors,
  getDailyReportPreference: getDailyReportPreferenceErrors,
  updateDailyReportPreference: updateDailyReportPreferenceErrors,
  getDailyReportEmailPreference: getDailyReportEmailPreferenceErrors,
  updateDailyReportEmailPreference: updateDailyReportEmailPreferenceErrors,
  listUnreadDailyReports: listUnreadDailyReportsErrors,
  recordDailyReportRead: recordDailyReportReadErrors,
  decideRecommendationBatch: decideRecommendationBatchErrors,
  refreshRecommendationBatch: refreshRecommendationBatchErrors,
  confirmRecommendationItem: confirmRecommendationItemErrors,
  listAdminPolicies: listAdminPoliciesErrors,
  createAdminPolicyDraft: createAdminPolicyDraftErrors,
  publishAdminPolicy: publishAdminPolicyErrors,
  listApplicationPreparations: listApplicationPreparationsErrors,
  startApplicationPreparations: startApplicationPreparationsErrors,
  retryApplicationPreparation: retryApplicationPreparationErrors,
  listMissions: listMissionsErrors,
  getMission: getMissionErrors,
  getMissionApplicationTarget: getMissionApplicationTargetErrors,
  resolveMissionPageBinding: resolveMissionPageBindingErrors,
  ensureMissionStartApproval: ensureMissionStartApprovalErrors,
  getMissionMaterials: getMissionMaterialsErrors,
  releaseMissionResume: releaseMissionResumeErrors,
  requestMissionCoverLetter: requestMissionCoverLetterErrors,
  releaseMissionCoverLetterText: releaseMissionCoverLetterErrors,
  releaseMissionCoverLetterPdf: releaseMissionCoverLetterErrors,
  createMission: createMissionErrors,
  createApplicationPageContext: createApplicationPageContextErrors,
  createJobFromUrl: createJobFromUrlErrors,
  listResumeSelectionOptions: listResumeSelectionOptionsErrors,
  getResumeLibrary: getResumeLibraryErrors,
  getCoverLetterRequirement: getCoverLetterRequirementErrors,
  generateCoverLetterCandidate: generateCoverLetterCandidateErrors,
  lookupCoverLetterAttachment: lookupCoverLetterAttachmentErrors,
  prepareCoverLetterAttachment: prepareCoverLetterAttachmentErrors,
  releaseCoverLetterAttachmentText: releaseCoverLetterAttachmentTextErrors,
  releaseCoverLetterAttachmentPdf: releaseCoverLetterAttachmentPdfErrors,
  generateApplicationQuestionCandidates: generateApplicationQuestionCandidatesErrors,
  getApplicationQuestionSettings: getApplicationQuestionSettingsErrors,
  updateApplicationQuestionSettings: updateApplicationQuestionSettingsErrors,
  getMissionAutofillConsent: getMissionAutofillConsentErrors,
  recordMissionAutofillConsent: recordMissionAutofillConsentErrors,
  listApplicationQuestionAnswers: listApplicationQuestionAnswersErrors,
  rememberApplicationQuestionAnswer: rememberApplicationQuestionAnswerErrors,
  createApplicationQuestionDrafts: createApplicationQuestionDraftsErrors,
  forgetApplicationQuestionAnswer: forgetApplicationQuestionAnswerErrors,
  clearApplicationQuestionAnswers: clearApplicationQuestionAnswersErrors,
  getMissionApplicationQuestions: getMissionApplicationQuestionsErrors,
  createResumeTrack: createResumeTrackErrors,
  getResumePdfMetadata: getResumePdfMetadataErrors,
  readResumePdf: readResumePdfErrors,
  getResumeAtsAttachmentPlan: getResumeAtsAttachmentPlanErrors,
  getResumeAtsAttachmentPrepared: getResumeAtsAttachmentPreparedErrors,
  releaseResumeAtsAttachment: releaseResumeAtsAttachmentErrors,
  renameResumeTrack: renameResumeTrackErrors,
  archiveResumeTrack: archiveResumeTrackErrors,
  restoreResumeTrack: restoreResumeTrackErrors,
  setDefaultResumeTrack: setDefaultResumeTrackErrors,
  setResumeTrackCurrentVersion: setResumeTrackCurrentVersionErrors,
  createJobResumeGeneration: createJobResumeGenerationErrors,
  recordMissionApproval: recordMissionApprovalErrors,
  cancelMission: cancelMissionErrors,
  enterSubmissionBoundary: enterSubmissionBoundaryErrors,
  recordSubmissionEvent: recordSubmissionEventErrors,
  getExecutionIntentJwks: getExecutionIntentJwksErrors,
  createSensitiveWriteConfirmation: createSensitiveWriteConfirmationErrors,
  decideSensitiveWriteConfirmation: decideSensitiveWriteConfirmationErrors,
  issueExecutionIntent: issueExecutionIntentErrors,
  claimExecutionIntent: claimExecutionIntentErrors,
  fetchSensitiveExecutionMaterial: fetchSensitiveExecutionMaterialErrors,
  submitApplicationReceipt: submitApplicationReceiptErrors,
  getApplicationProfile: getApplicationProfileErrors,
  listApplicationLedger: listApplicationLedgerErrors,
  updatePrimaryTimeZone: updatePrimaryTimeZoneErrors,
  createReferralRequest: createReferralRequestErrors,
  getReferralRequest: getReferralRequestErrors,
  listAdminReferralRequests: listAdminReferralRequestsErrors,
  getAdminReferralRequest: getAdminReferralRequestErrors,
  updateAdminReferralRequest: updateAdminReferralRequestErrors,
  updateAdminReferralOutcome: updateAdminReferralOutcomeErrors,
  listAdminJobIngestionRuns: listAdminJobIngestionRunsErrors,
  listAdminReferralMentorBindings: listAdminReferralMentorBindingsErrors,
  updateAdminReferralMentorBinding: updateAdminReferralMentorBindingErrors,
  listMentorReferralRequests: listMentorReferralRequestsErrors,
  decideMentorReferralRequest: decideMentorReferralRequestErrors,
  completeMentorReferralRequest: completeMentorReferralRequestErrors,
  replaceMentorCoffeeChatSlots: replaceMentorCoffeeChatSlotsErrors,
  setMentorCoffeeChatMeetingUrl: setMentorCoffeeChatMeetingUrlErrors,
  listStudentReferralCoffeeChats: listStudentReferralCoffeeChatsErrors,
  selectStudentCoffeeChatSlot: selectStudentCoffeeChatSlotErrors,
  selectStudentReferralGuaranteeRemedy: selectStudentReferralGuaranteeRemedyErrors,
  createReferralCheckout: createReferralCheckoutErrors,
  getOwnerReferralCommerce: getOwnerReferralCommerceErrors,
  getAdminReferralCommerce: getAdminReferralCommerceErrors,
  executeAdminReferralRefund: executeAdminReferralRefundErrors,
  reconcileAdminReferralRefund: reconcileAdminReferralRefundErrors,
  ingestTrustTelemetryEvent: ingestTrustTelemetryEventErrors,
  deleteTrustTelemetryIdentity: deleteTrustTelemetryIdentityErrors,
  computeGapStrength: computeGapStrengthErrors,
  computeGapAnalysisV2: computeGapAnalysisV2Errors,
  getLatestGapStrength: getLatestGapStrengthErrors,
  getLearningRecommendations: getLearningRecommendationsErrors,
  getLearningRecommendationsV2: getLearningRecommendationsV2Errors,
  getProfileStrengths: getProfileStrengthsErrors,
  saveProfileStrength: saveProfileStrengthErrors,
  removeProfileStrength: removeProfileStrengthErrors,
  classifyPilotUa2: classifyPilotUa2Errors,
  composePilotUa5: composePilotUa5Errors,
  checkPilotUa5ProfileCurrentness: checkPilotUa5ProfileCurrentnessErrors,
  resolvePilotUa5ProfilePayloads: resolvePilotUa5ProfilePayloadsErrors,
} as const satisfies Record<AgentEndpointId, readonly AgentErrorCode[]>;

export const OWNER_PROFILE_V2_ENDPOINT_ERROR_CODES = {
  getOwnerApplicationProfileV2: [...common, 'PAYWALL_REQUIRED'],
  patchOwnerApplicationProfileV2: [
    ...common,
    'PAYWALL_REQUIRED',
    'PROFILE_REVISION_MISMATCH',
    'PROFILE_DELETION_EPOCH_MISMATCH',
  ],
  deleteOwnerApplicationProfileV2: [...common, 'PAYWALL_REQUIRED'],
  createResumeProfileSuggestionsV1: [...common, 'PAYWALL_REQUIRED'],
  getOwnerProfileDirectoryPersonalV1: [...common, 'PAYWALL_REQUIRED'],
  replaceOwnerProfileDirectoryPersonalV1: [...common, 'PAYWALL_REQUIRED', 'PROFILE_REVISION_MISMATCH', 'PROFILE_DELETION_EPOCH_MISMATCH'],
  getOwnerProfileDirectoryWorkAuthorizationV1: [...common, 'PAYWALL_REQUIRED'],
  replaceOwnerProfileDirectoryWorkAuthorizationV1: [...common, 'PAYWALL_REQUIRED', 'PROFILE_REVISION_MISMATCH', 'PROFILE_DELETION_EPOCH_MISMATCH', 'PROFILE_PREFERENCES_REVISION_MISMATCH'],
  getOwnerProfileDirectoryPreferencesV1: [...common, 'PAYWALL_REQUIRED'],
  replaceOwnerProfileDirectoryPreferencesV1: [...common, 'PAYWALL_REQUIRED', 'PROFILE_PREFERENCES_REVISION_MISMATCH'],
  getOwnerEeoSelfIdentificationV1: [...common, 'PAYWALL_REQUIRED'],
  replaceOwnerEeoSelfIdentificationV1: [...common, 'PAYWALL_REQUIRED', 'PROFILE_REVISION_MISMATCH'],
  deleteOwnerEeoSelfIdentificationV1: [...common, 'PAYWALL_REQUIRED', 'PROFILE_REVISION_MISMATCH'],
  getOwnerApplicationSigningConsentV1: [...common],
  grantOwnerApplicationSigningConsentV1: [...common],
  revokeOwnerApplicationSigningConsentV1: [...common],
} as const satisfies Record<OwnerProfileV2EndpointId, readonly AgentErrorCode[]>;

export interface HttpContract<P, Q, B, S> { readonly params: P; readonly query: Q; readonly body: B; readonly success: S }
export interface AgentEndpointContractMap {
  planFullAiAutofill: HttpContract<never, never, FullAiRequest, FullAiResponse>;
  streamFullAiAutofillPlan: HttpContract<never, never, FullAiRequest, FullAiStreamEvent>;
  reviseFullAiAutofill: HttpContract<never, never, FullAiReviseRequest, FullAiReviseResponse>;
  getFullAiAutofillQuota: HttpContract<never, never, never, FullAiQuota>;
  listAssistantJobs: HttpContract<never, AssistantJobs.AssistantJobsQuery, never, AssistantJobs.AssistantJobsResponse>;
  listAssistantJobBatches: HttpContract<never, Pick<AssistantJobs.AssistantJobsQuery, 'conversationId'>, never, AssistantJobs.AssistantJobBatchesResponse>;
  deliverAssistantJobs: HttpContract<never, never, AssistantJobs.AssistantJobsDeliveryRequest, AssistantJobs.AssistantJobsResponse>;
  decideAssistantJob: HttpContract<{ entryId: string }, never, AssistantJobs.AssistantJobDecisionRequest, AssistantJobs.AssistantJobResponse>;
  getAssistantCoverDraft: HttpContract<{ entryId: string }, never, never, AssistantCover.AssistantCoverDraftResponse>;
  writeAssistantCoverDraft: HttpContract<{ entryId: string }, never, AssistantCover.AssistantCoverDraftRequest, AssistantCover.AssistantCoverDraftResponse>;
  lookupAtsReport: HttpContract<never, AtsReports.AtsReportRequest, never, AtsReports.AtsReportLookupResponse>;
  startAtsReport: HttpContract<never, never, AtsReports.AtsReportRequest, AtsReports.AtsReportResponse>;
  getAtsReport: HttpContract<{ reportId: string }, AtsReports.AtsReportQuery, never, AtsReports.AtsReportResponse>;
  listAdminSubscriptionRefunds: HttpContract<never, { cursor?: string }, never, SubscriptionLifecycle.SubscriptionRefundListResponse>;
  quoteAdminSubscriptionRefund: HttpContract<{ ownerId: string; invoiceId: string }, never, never, SubscriptionLifecycle.SubscriptionRefundQuote>;
  requestAdminSubscriptionRefund: HttpContract<{ ownerId: string }, never, SubscriptionLifecycle.SubscriptionRefundRequest, SubscriptionLifecycle.SubscriptionRefundResponse>;
  reviewAdminSubscriptionRefund: HttpContract<{ refundId: string }, never, SubscriptionLifecycle.SubscriptionRefundReviewRequest, SubscriptionLifecycle.SubscriptionRefundResponse>;
  retryAdminSubscriptionRefund: HttpContract<never, never, SubscriptionLifecycle.SubscriptionOperationRetryRequest, SubscriptionLifecycle.SubscriptionRefundResponse>;
  reviewAdminSubscriptionRefundAccess: HttpContract<{ refundId: string }, never, SubscriptionLifecycle.SubscriptionRefundAccessReviewRequest, SubscriptionLifecycle.SubscriptionRefundResponse>;
  getAgentSession: HttpContract<never, never, never, GetAgentSessionResponse>;
  createConversation: HttpContract<never, never, CreateConversationRequest, CreateConversationResponse>;
  listConversations: HttpContract<never, ListConversationsQuery, never, ListConversationsResponse>;
  getConversation: HttpContract<GetConversationParams, never, never, GetConversationResponse>;
  getRolePreferences: HttpContract<GetConversationParams, never, never, RolePreferencesSnapshot>;
  updateRolePreferences: HttpContract<GetConversationParams, never, RolePreferencesPatch, RolePreferencesSnapshot>;
  updateConversation: HttpContract<UpdateConversationParams, never, UpdateConversationRequest, UpdateConversationResponse>;
  listConversationMessages: HttpContract<ListConversationMessagesParams, ListConversationMessagesQuery, never, ListConversationMessagesResponse>;
  getConversationMessage: HttpContract<GetConversationMessageParams, never, never, GetConversationMessageResponse>;
  sendConversationMessage: HttpContract<SendConversationMessageParams, never, SendConversationMessageRequest, MessageSseFrame>;
  decideConversationAction: HttpContract<DecideConversationActionParams, never, DecideConversationActionRequest, DecideConversationActionResponse>;
  getDailyReportPreference: HttpContract<never, never, never, GetDailyReportPreferenceResponse>;
  updateDailyReportPreference: HttpContract<never, never, UpdateDailyReportPreferenceRequest, UpdateDailyReportPreferenceResponse>;
  getDailyReportEmailPreference: HttpContract<never, never, never, GetDailyReportEmailPreferenceResponse>;
  updateDailyReportEmailPreference: HttpContract<never, never, UpdateDailyReportEmailPreferenceRequest, UpdateDailyReportEmailPreferenceResponse>;
  listUnreadDailyReports: HttpContract<never, ListUnreadDailyReportsQuery, never, ListUnreadDailyReportsResponse>;
  recordDailyReportRead: HttpContract<RecordDailyReportReadParams, never, RecordDailyReportReadRequest, RecordDailyReportReadResponse>;
  listRecommendationBatches: HttpContract<never, ListRecommendationBatchesQuery, never, ListRecommendationBatchesResponse>;
  getRecommendationBatch: HttpContract<GetRecommendationBatchParams, never, never, GetRecommendationBatchResponse>;
  getRecommendationItemDetail: HttpContract<GetRecommendationItemDetailParams, never, never, GetRecommendationItemDetailResponse>;
  decideRecommendationBatch: HttpContract<DecideRecommendationBatchParams, never, DecideRecommendationBatchRequest, DecideRecommendationBatchResponse>;
  refreshRecommendationBatch: HttpContract<never, never, RefreshRecommendationBatchRequest, RefreshRecommendationBatchResponse>;
  confirmRecommendationItem: HttpContract<ConfirmRecommendationItemParams, never, ConfirmRecommendationItemRequest, ConfirmRecommendationItemResponse>;
  listAdminPolicies: HttpContract<AdminPolicyModuleParams, never, never, ListAdminPoliciesResponse>;
  createAdminPolicyDraft: HttpContract<AdminPolicyModuleParams, never, CreateAdminPolicyDraftRequest, AdminPolicyResponse>;
  publishAdminPolicy: HttpContract<AdminPolicyVersionParams, never, never, AdminPolicyResponse>;
  listApplicationPreparations: HttpContract<ApplicationPreparationsParams, never, never, ApplicationPreparationsResponse>;
  startApplicationPreparations: HttpContract<ApplicationPreparationsParams, never, StartApplicationPreparationsRequest, ApplicationPreparationsResponse>;
  retryApplicationPreparation: HttpContract<RetryApplicationPreparationParams, never, RetryApplicationPreparationRequest, ApplicationPreparationsResponse>;
  listMissions: HttpContract<never, ListMissionsQuery, never, ListMissionsResponse>;
  getMission: HttpContract<GetMissionParams, never, never, GetMissionResponse>;
  getMissionApplicationTarget: HttpContract<
    GetMissionApplicationTargetParams,
    never,
    never,
    GetMissionApplicationTargetResponse
  >;
  resolveMissionPageBinding: HttpContract<
    never,
    never,
    ResolveMissionPageBindingRequestV1,
    ResolveMissionPageBindingResponseV1
  >;
  ensureMissionStartApproval: HttpContract<
    GetMissionParams,
    never,
    EnsureMissionStartApprovalRequestV1,
    EnsureMissionStartApprovalResponseV1
  >;
  getMissionMaterials: HttpContract<GetMissionParams, never, never, MissionMaterialsV1>;
  releaseMissionResume: HttpContract<GetMissionParams, never, ReleaseMissionResumeRequestV1, Uint8Array>;
  requestMissionCoverLetter: HttpContract<
    GetMissionParams,
    never,
    RequestMissionCoverLetterRequestV1,
    RequestMissionCoverLetterResultV1
  >;
  releaseMissionCoverLetterText: HttpContract<
    GetMissionParams,
    never,
    ReleaseMissionCoverLetterRequestV1,
    ReleaseMissionCoverLetterTextV1
  >;
  releaseMissionCoverLetterPdf: HttpContract<
    GetMissionParams,
    never,
    ReleaseMissionCoverLetterRequestV1,
    Uint8Array
  >;
  createMission: HttpContract<never, never, CreateMissionRequest, CreateMissionResponse>;
  createApplicationPageContext: HttpContract<
    never,
    never,
    CreateApplicationPageContextRequest,
    CreateApplicationPageContextResponse
  >;
  createJobFromUrl: HttpContract<never, never, CreateJobFromUrlRequest, CreateJobFromUrlResponse>;
  listResumeSelectionOptions: HttpContract<never, never, never, ListResumeSelectionOptionsResponseV1>;
  getResumeLibrary: HttpContract<never, never, never, ResumeLibrarySnapshotV1>;
  createResumeTrack: HttpContract<never, never, CreateResumeTrackRequestV1, ResumeLibrarySnapshotV1>;
  renameResumeTrack: HttpContract<ResumeTrackParamsV1, never, RenameResumeTrackRequestV1, ResumeLibrarySnapshotV1>;
  archiveResumeTrack: HttpContract<ResumeTrackParamsV1, never, ArchiveResumeTrackRequestV1, ResumeLibrarySnapshotV1>;
  restoreResumeTrack: HttpContract<ResumeTrackParamsV1, never, ResumeLibraryRevisionRequestV1, ResumeLibrarySnapshotV1>;
  setDefaultResumeTrack: HttpContract<ResumeTrackParamsV1, never, ResumeLibraryRevisionRequestV1, ResumeLibrarySnapshotV1>;
  setResumeTrackCurrentVersion: HttpContract<ResumeTrackVersionParamsV1, never, ResumeLibraryRevisionRequestV1, ResumeLibrarySnapshotV1>;
  createJobResumeGeneration: HttpContract<never, never, CreateJobResumeGenerationRequestV1, JobResumeGenerationResponseV1>;
  getResumePdfMetadata: HttpContract<ResumePdfParamsV1, never, never, ResumePdfMetadataV1>;
  readResumePdf: HttpContract<ResumePdfParamsV1, never, ResumePdfReadRequestV1, Uint8Array>;
  getResumeAtsAttachmentPlan: HttpContract<never, never, ResumeAtsAttachmentPlanRequestV1, ResumeAtsAttachmentPlanV1>;
  getResumeAtsAttachmentPrepared: HttpContract<never, never, ResumeAtsAttachmentPreparedRequestV1, ResumeAtsAttachmentPreparedV1>;
  releaseResumeAtsAttachment: HttpContract<never, never, ResumeAtsAttachmentReleaseRequestV1, Uint8Array>;
  getCoverLetterRequirement: HttpContract<never, never, CoverLetterRequirementRequestV1, CoverLetterRequirementResultV1>;
  generateCoverLetterCandidate: HttpContract<never, never, CoverLetterProductRequestV1, CoverLetterProductResultV1>;
  lookupCoverLetterAttachment: HttpContract<never, never, CoverLetterAttachmentLookupRequestV1, CoverLetterAttachmentLookupV1>;
  prepareCoverLetterAttachment: HttpContract<never, never, CoverLetterAttachmentPrepareRequestV1, CoverLetterAttachmentPrepareResultV1>;
  releaseCoverLetterAttachmentText: HttpContract<never, never, CoverLetterAttachmentReleaseRequestV1, CoverLetterAttachmentTextV1>;
  releaseCoverLetterAttachmentPdf: HttpContract<never, never, CoverLetterAttachmentReleaseRequestV1, Uint8Array>;
  recordMissionApproval: HttpContract<RecordMissionApprovalParams, never, RecordMissionApprovalRequest, RecordMissionApprovalResponse>;
  cancelMission: HttpContract<CancelMissionParams, never, CancelMissionRequest, CancelMissionResponse>;
  enterSubmissionBoundary: HttpContract<EnterSubmissionBoundaryParams, never, EnterSubmissionBoundaryRequest, EnterSubmissionBoundaryResponse>;
  recordSubmissionEvent: HttpContract<RecordSubmissionEventParams, never, RecordSubmissionEventRequest, RecordSubmissionEventResponse>;
  getExecutionIntentJwks: HttpContract<never, never, never, GetExecutionIntentJwksResponse>;
  createSensitiveWriteConfirmation: HttpContract<CreateSensitiveWriteConfirmationParams, never, CreateSensitiveWriteConfirmationRequestV2, CreateSensitiveWriteConfirmationResponseV2>;
  decideSensitiveWriteConfirmation: HttpContract<DecideSensitiveWriteConfirmationParams, never, DecideSensitiveWriteConfirmationRequestV2, SensitiveWriteDecisionResponseV2>;
  issueExecutionIntent: HttpContract<IssueExecutionIntentParams, never, IssueExecutionIntentRequestContract, IssueExecutionIntentResponseContract>;
  claimExecutionIntent: HttpContract<never, never, ClaimExecutionIntentRequestContract, ClaimExecutionIntentResponseContract>;
  fetchSensitiveExecutionMaterial: HttpContract<never, never, FetchSensitiveExecutionMaterialRequestV2, FetchSensitiveExecutionMaterialResponseV2>;
  submitApplicationReceipt: HttpContract<SubmitApplicationReceiptParams, never, SubmitApplicationReceiptRequestContract, SubmitApplicationReceiptResponseContract>;
  getApplicationProfile: HttpContract<never, never, never, GetApplicationProfileResponse>;
  listApplicationLedger: HttpContract<never, ListApplicationLedgerQuery, never, ListApplicationLedgerResponse>;
  updatePrimaryTimeZone: HttpContract<never, never, UpdatePrimaryTimeZoneRequest, UpdatePrimaryTimeZoneResponse>;
  createReferralRequest: HttpContract<never, never, CreateReferralRequestRequest, CreateReferralRequestResponse>;
  getReferralRequest: HttpContract<ReferralRequestParams, never, never, ReferralRequestView>;
  listAdminReferralRequests: HttpContract<never, ListAdminReferralRequestsQuery, never, ListAdminReferralRequestsResponse>;
  getAdminReferralRequest: HttpContract<ReferralRequestParams, never, never, AdminReferralRequestView>;
  updateAdminReferralRequest: HttpContract<ReferralRequestParams, never, UpdateAdminReferralRequestRequest, AdminReferralRequestView>;
  updateAdminReferralOutcome: HttpContract<ReferralRequestParams, never, UpdateAdminReferralOutcomeRequest, UpdateAdminReferralOutcomeResponse>;
  listAdminJobIngestionRuns: HttpContract<never, never, never, JobIngestionRunListResponse>;
  listAdminReferralMentorBindings: HttpContract<never, never, never, ListAdminReferralMentorBindingsResponse>;
  updateAdminReferralMentorBinding: HttpContract<ReferralRequestPathParams, never, UpdateAdminReferralMentorBindingRequest, UpdateAdminReferralMentorBindingResponse>;
  listMentorReferralRequests: HttpContract<never, never, never, ListMentorReferralRequestsResponse>;
  decideMentorReferralRequest: HttpContract<ReferralRequestPathParams, never, DecideMentorReferralRequestRequest, DecideMentorReferralRequestResponse>;
  completeMentorReferralRequest: HttpContract<ReferralRequestPathParams, never, CompleteMentorReferralRequestRequest, CompleteMentorReferralRequestResponse>;
  replaceMentorCoffeeChatSlots: HttpContract<ReferralRequestPathParams, never, ReplaceMentorCoffeeChatSlotsRequest, ReplaceMentorCoffeeChatSlotsResponse>;
  setMentorCoffeeChatMeetingUrl: HttpContract<ReferralRequestPathParams, never, SetMentorCoffeeChatMeetingUrlRequest, SetMentorCoffeeChatMeetingUrlResponse>;
  listStudentReferralCoffeeChats: HttpContract<never, ListStudentReferralCoffeeChatsQuery, never, ListStudentReferralCoffeeChatsResponse | ListStudentReferralCoffeeChatsPageResponse>;
  selectStudentCoffeeChatSlot: HttpContract<ReferralRequestPathParams, never, SelectStudentCoffeeChatSlotRequest, SelectStudentCoffeeChatSlotResponse>;
  selectStudentReferralGuaranteeRemedy: HttpContract<ReferralRequestPathParams, never, SelectReferralGuaranteeRemedyRequest, SelectReferralGuaranteeRemedyResponse>;
  createReferralCheckout: HttpContract<ReferralRequestPathParams, never, CreateReferralCheckoutRequest, CreateReferralCheckoutResponse>;
  getOwnerReferralCommerce: HttpContract<ReferralRequestPathParams, never, never, ReferralCommerceView>;
  getAdminReferralCommerce: HttpContract<ReferralRequestPathParams, never, never, ReferralCommerceView>;
  executeAdminReferralRefund: HttpContract<ReferralRequestPathParams, never, never, ExecuteReferralRefundResponse>;
  reconcileAdminReferralRefund: HttpContract<ReferralRequestPathParams, never, never, ReconcileReferralRefundResponse>;
  ingestTrustTelemetryEvent: HttpContract<never, never, TrustTelemetryEventV1, TrustTelemetryAcceptedResponseV1>;
  deleteTrustTelemetryIdentity: HttpContract<never, never, TrustTelemetryDeletionRequestV1, TrustTelemetryAcceptedResponseV1>;
  computeGapStrength: HttpContract<never, never, GapStrengthTargetRoleRequest, GapStrengthReport>;
  computeGapAnalysisV2: HttpContract<never, never, GapAnalysisComputeRequestV2, GapAnalysisResponseV2>;
  getLatestGapStrength: HttpContract<never, never, GapStrengthTargetRoleRequest, GapStrengthReport>;
  getLearningRecommendations: HttpContract<never, never, GapStrengthTargetRoleRequest, LearningRecommendationResponse>;
  getLearningRecommendationsV2: HttpContract<never, never, LearningRecommendationRequestV2, LearningRecommendationResponseV2>;
  getProfileStrengths: HttpContract<never, never, never, ProfileStrengthSnapshot>;
  saveProfileStrength: HttpContract<never, never, SaveProfileStrengthRequest, ProfileStrengthSnapshot>;
  removeProfileStrength: HttpContract<never, never, RemoveProfileStrengthRequest, ProfileStrengthSnapshot>;
  classifyPilotUa2: HttpContract<
    never,
    never,
    PilotUa2ClassificationRequest,
    PilotUa2ClassificationResponse
  >;
  composePilotUa5: HttpContract<
    never,
    never,
    PilotUa5CompositionRequest,
    PilotUa5CompositionResponse
  >;
  checkPilotUa5ProfileCurrentness: HttpContract<never, never, PilotUa5ProfileCurrentnessRequest, PilotUa5ProfileCurrentnessResponse>;
  resolvePilotUa5ProfilePayloads: HttpContract<
    never,
    never,
    PilotUa5BoundProfilePayloadRequest,
    PilotUa5BoundProfilePayloadResponse
  >;
  generateApplicationQuestionCandidates: HttpContract<never, never, ApplicationQuestionBatchV1, ApplicationQuestionResultV1>;
  getApplicationQuestionSettings: HttpContract<never, never, never, ApplicationQuestionSettingsV1>;
  updateApplicationQuestionSettings: HttpContract<never, never, ApplicationQuestionSettingsUpdateV1, ApplicationQuestionSettingsV1>;
  getMissionAutofillConsent: HttpContract<never, never, never, MissionAutofillConsentV1>;
  recordMissionAutofillConsent: HttpContract<never, never, RecordMissionAutofillConsentV1, MissionAutofillConsentV1>;
  // 2026-09-21 跟版：argoland 这两条的 wire 是 applicationQuestionAnswers.ts 里的
  // 「answerKey + controlType + value」（listApplicationAnswers / putApplicationAnswer），
  // 不是本仓早先自拟的 memory record 形状——按那个形状发，服务端答
  // ANSWER_MEMORY_REQUEST_INVALID，记忆从来没存上过。
  listApplicationQuestionAnswers: HttpContract<never, never, never, ListApplicationAnswersResponseV1>;
  rememberApplicationQuestionAnswer: HttpContract<never, never, PutApplicationAnswerRequestV1, PutApplicationAnswerResponseV1>;
  createApplicationQuestionDrafts: HttpContract<never, never, CreateApplicationQuestionDraftsRequestV1, CreateApplicationQuestionDraftsResponseV1>;
  forgetApplicationQuestionAnswer: HttpContract<ForgetApplicationQuestionAnswerParams, never, never, never>;
  clearApplicationQuestionAnswers: HttpContract<never, never, never, never>;
  getMissionApplicationQuestions: HttpContract<
    GetMissionApplicationQuestionsParams,
    never,
    never,
    GetMissionApplicationQuestionsResponse
  >;
}

export interface AuthSessionEndpointContractMap {
  joinWaitlist: HttpContract<never, never, WaitlistRequest, WaitlistResponse>;
  csrf: HttpContract<never, never, never, GetAuthCsrfResponse>;
  register: HttpContract<never, never, RegisterAuthRequest, RegisterAuthResponse>;
  login: HttpContract<never, never, LoginAuthRequest, LoginAuthResponse>;
  googleLogin: HttpContract<never, never, GoogleLoginRequest, GoogleLoginResponse>;
  refresh: HttpContract<never, never, RefreshAuthSessionRequest, RefreshAuthSessionResponse>;
  logout: HttpContract<never, never, LogoutAuthSessionRequest, LogoutAuthSessionResponse>;
  verifyEmail: HttpContract<never, never, VerifyEmailRequest, VerifyEmailResponse>;
  resendEmailVerification: HttpContract<never, never, ResendEmailVerificationRequest, ResendEmailVerificationResponse>;
  exchangeRegistrationInvitation: HttpContract<
    never,
    never,
    ExchangeRegistrationInvitationRequest,
    ExchangeRegistrationInvitationResponse
  >;
  getRegistrationContext: HttpContract<
    never,
    never,
    GetRegistrationContextRequest,
    RegistrationContextResponse
  >;
  listAdminWaitlist: HttpContract<never, ListAdminWaitlistQuery, never, ListAdminWaitlistResponse>;
  createRegistrationInvitation: HttpContract<
    WaitlistEntryPathParams,
    never,
    never,
    CreateRegistrationInvitationResponse
  >;
  revokeRegistrationInvitation: HttpContract<
    InvitationPathParams,
    never,
    never,
    RevokeRegistrationInvitationResponse
  >;
  resendRegistrationInvitation: HttpContract<
    InvitationPathParams,
    never,
    never,
    ResendRegistrationInvitationResponse
  >;
  introspectSession: HttpContract<never, never, IntrospectAuthSessionRequest, IntrospectAuthSessionResponse>;
  revokeSession: HttpContract<never, never, RevokeAuthSessionRequest, RevokeAuthSessionResponse>;
  createExtensionHandoff: HttpContract<never, never, CreateExtensionHandoffRequest, CreateExtensionHandoffResponse>;
  redeemExtensionHandoff: HttpContract<never, never, RedeemExtensionHandoffRequest, RedeemExtensionHandoffResponse>;
  linkExtensionInstall: HttpContract<never, never, LinkExtensionInstallRequest, LinkExtensionInstallResponse>;
  attestExtensionInstall: HttpContract<never, never, AttestExtensionInstallRequest, AttestExtensionInstallResponse>;
}

export interface OwnerProfileV2EndpointContractMap {
  getOwnerApplicationProfileV2: HttpContract<
    never,
    never,
    never,
    CandidateProfileSnapshotV2
  >;
  patchOwnerApplicationProfileV2: HttpContract<
    never,
    never,
    PatchCandidateProfileV2,
    CandidateProfileSnapshotV2
  >;
  deleteOwnerApplicationProfileV2: HttpContract<
    never,
    never,
    never,
    CandidateProfileSnapshotV2
  >;
  createResumeProfileSuggestionsV1: HttpContract<
    never,
    never,
    ResumeProfileSuggestionUploadRequestV1,
    ResumeProfileSuggestionSetV1
  >;
  getOwnerProfileDirectoryPersonalV1: HttpContract<never, never, never, ProfileDirectoryPersonalV1>;
  replaceOwnerProfileDirectoryPersonalV1: HttpContract<
    never, never, ProfileDirectoryPersonalUpdateV1, ProfileDirectoryPersonalV1
  >;
  getOwnerProfileDirectoryWorkAuthorizationV1: HttpContract<
    never, never, never, ProfileDirectoryWorkAuthorizationV1
  >;
  replaceOwnerProfileDirectoryWorkAuthorizationV1: HttpContract<
    never, never, ProfileDirectoryWorkAuthorizationUpdateV1, ProfileDirectoryWorkAuthorizationV1
  >;
  getOwnerProfileDirectoryPreferencesV1: HttpContract<never, never, never, ProfileDirectoryPreferencesV1>;
  replaceOwnerProfileDirectoryPreferencesV1: HttpContract<
    never, never, ProfileDirectoryPreferencesUpdateV1, ProfileDirectoryPreferencesV1
  >;
  getOwnerEeoSelfIdentificationV1: HttpContract<never, never, never, EeoSelfIdentificationV1>;
  replaceOwnerEeoSelfIdentificationV1: HttpContract<never, never, EeoSelfIdentificationUpdateV1, EeoSelfIdentificationV1>;
  deleteOwnerEeoSelfIdentificationV1: HttpContract<never, never, EeoSelfIdentificationDeleteV1, never>;
  getOwnerApplicationSigningConsentV1: HttpContract<never, never, never, GetApplicationSigningConsentResponse>;
  grantOwnerApplicationSigningConsentV1: HttpContract<never, never, never, GetApplicationSigningConsentResponse>;
  revokeOwnerApplicationSigningConsentV1: HttpContract<never, never, never, GetApplicationSigningConsentResponse>;
}

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
export const AGENT_ENDPOINT_MAP_IS_EXACT: Equal<keyof AgentEndpointContractMap, AgentEndpointId> = true;
export const AUTH_ENDPOINT_MAP_IS_EXACT: Equal<keyof AuthSessionEndpointContractMap, AuthSessionEndpointId> = true;
export const OWNER_PROFILE_V2_ENDPOINT_MAP_IS_EXACT: Equal<
  keyof OwnerProfileV2EndpointContractMap,
  OwnerProfileV2EndpointId
> = true;
