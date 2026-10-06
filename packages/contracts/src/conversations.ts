/** Conversation/message/action/SSE wire types from AGENT-API-CONTRACT.md §3. */

import type {
  AgentErrorCode,
  AgentErrorDefinition,
  AgentSchemaEnvelope,
  DecimalString,
  IsoDateTime,
  OpaqueCursor,
  Sha256Digest,
  Uuid,
} from './common.ts';
import type {
  ActionCardView,
  AnswerScopeRef,
  AnswerValueV1,
  MessageSpeaker,
  SafeDisplayParamKey,
} from './actionCards.ts';
import type {
  AtsProviderCode,
  MissionProgressCode,
  MissionStatus,
  MissionStepStatus,
  MissionStepType,
  SourcePlatformCode,
} from './missions.ts';
import type { DailyReportMessagePart } from './dailyReports.ts';

export * from './actionCards.ts';

export const CONVERSATION_KINDS = ['ROLE'] as const;
export type ConversationKind = (typeof CONVERSATION_KINDS)[number];
export const CONVERSATION_STATUSES = ['ACTIVE', 'ARCHIVED'] as const;
export type ConversationStatus = (typeof CONVERSATION_STATUSES)[number];
export const PERSONA_STATUSES = ['ACTIVE'] as const;
export type PersonaStatus = (typeof PERSONA_STATUSES)[number];

export const PERSONA_SPEAKER_TYPES = ['AI_AGENT', 'STAFF', 'MENTOR'] as const;
export type PersonaSpeakerType = (typeof PERSONA_SPEAKER_TYPES)[number];

/** Role-conversation job discovery preferences. */
export interface ConversationJobPreferences {
  readonly preferredLocation: string | null;
}

export interface PersonaView {
  readonly type: PersonaSpeakerType;
  readonly id: string;
  readonly slug: string;
  readonly displayName: string;
  readonly avatarUrl: string | null;
  readonly status: PersonaStatus;
}

export const TURN_STATUSES = ['RUNNING', 'COMPLETED', 'FAILED', 'CANCELLED'] as const;
export type TurnStatus = (typeof TURN_STATUSES)[number];

export interface ConversationActiveTurn {
  readonly turnId: Uuid;
  readonly assistantMessageId: Uuid;
  readonly status: TurnStatus;
  readonly lastActivityAt: IsoDateTime;
}

export interface ConversationBaseView {
  readonly id: Uuid;
  readonly revision: DecimalString;
  readonly kind: 'ROLE';
  /** Immutable user-visible role key, unique per owner ignoring case. */
  readonly targetRole: string;
  /** Immutable display label established with targetRole at creation. */
  readonly title: string;
  readonly jobPreferences: ConversationJobPreferences;
  readonly personas: readonly PersonaView[];
  readonly lastMessageAt: IsoDateTime | null;
  readonly lastMessagePreview: {
    readonly messageId: Uuid;
    readonly speaker: MessageSpeaker;
    readonly text: string;
    readonly createdAt: IsoDateTime;
  } | null;
  readonly relatedMissions: readonly {
    readonly missionId: Uuid;
    readonly revision: DecimalString;
    readonly status: MissionStatus;
    readonly updatedAt: IsoDateTime;
  }[];
  readonly createdAt: IsoDateTime;
  readonly updatedAt: IsoDateTime;
}
export type ConversationLifecycleView =
  | { readonly status: 'ACTIVE'; readonly archivedAt: null }
  | { readonly status: 'ARCHIVED'; readonly archivedAt: IsoDateTime };
export type ConversationSummaryView = ConversationBaseView & ConversationLifecycleView;
export type ConversationDetailView = ConversationSummaryView & {
  readonly activeTurn: ConversationActiveTurn | null;
};
export type ConversationView = ConversationDetailView;

export interface CreateConversationRequest {
  readonly clientRequestId: Uuid;
  readonly kind: 'ROLE';
  /** User-visible target role, for example "Data Scientist". */
  readonly targetRole: string;
  readonly title: string;
  /** Optional for older clients; the server persists an explicit empty preference set when absent. */
  readonly jobPreferences?: ConversationJobPreferences;
  /** Locale used for the one-time deterministic teacher onboarding script. */
  readonly generationLocale?: GenerationLocale;
  readonly jobId?: never;
  readonly mentorSlug?: never;
  readonly mentorId?: never;
  readonly participants?: never;
  readonly systemPrompt?: never;
}
export interface CreateConversationResponse extends AgentSchemaEnvelope {
  readonly conversation: ConversationDetailView;
}

export interface ListConversationsQuery {
  readonly status?: ConversationStatus | 'ALL';
  readonly cursor?: OpaqueCursor;
  readonly limit?: number;
}
export interface ListConversationsResponse extends AgentSchemaEnvelope {
  readonly items: readonly ConversationSummaryView[];
  readonly page: { readonly nextCursor: OpaqueCursor | null; readonly hasMore: boolean };
}
export interface GetConversationParams { readonly conversationId: Uuid }
export interface GetConversationResponse extends AgentSchemaEnvelope {
  readonly conversation: ConversationDetailView;
}

export interface UpdateConversationParams { readonly conversationId: Uuid }
interface UpdateConversationRequestBase {
  readonly clientRequestId: Uuid;
  readonly expectedRevision: DecimalString;
  readonly kind?: never;
  readonly targetRole?: never;
  readonly title?: never;
  readonly jobId?: never;
  readonly mentorSlug?: never;
  readonly mentorId?: never;
  readonly participants?: never;
  readonly systemPrompt?: never;
}
export type UpdateConversationRequest = UpdateConversationRequestBase & (
  | { readonly operation: 'ARCHIVE' }
  | { readonly operation: 'RESTORE' }
);
export interface UpdateConversationResponse extends AgentSchemaEnvelope {
  readonly conversation: ConversationDetailView;
}

export const MESSAGE_STATUSES = ['PENDING', 'STREAMING', 'COMPLETED', 'FAILED', 'CANCELLED'] as const;
export type MessageStatus = (typeof MESSAGE_STATUSES)[number];
/** Source §3.5 list-page default. Producer and every consumer must use the same value. */
export const CONVERSATION_MESSAGE_LIST_DEFAULT_LIMIT = 50 as const;
/** Source §3.5 list-page hard maximum. Oversized requests/responses fail closed. */
export const CONVERSATION_MESSAGE_LIST_MAX_LIMIT = 100 as const;
/** Positive PostgreSQL bigint ceiling for persisted message sequence cursors. */
export const CONVERSATION_MESSAGE_SEQUENCE_MAX = '9223372036854775807' as const;

export const MESSAGE_SSE_ERROR_CODES = [
  'LOGIN_REQUIRED', 'ACCOUNT_UNAVAILABLE', 'AGENT_UNAVAILABLE',
  'PAYWALL_REQUIRED', 'USAGE_EXHAUSTED', 'TURN_CANCELLED',
  'TOOL_VALIDATION_FAILED', 'TOOL_NOT_ALLOWED', 'TOOL_TIMEOUT', 'TOOL_EXECUTION_FAILED',
  'JOB_UNAVAILABLE', 'NO_FINAL_RESUME', 'RESUME_PROCESSING', 'VERSION_NOT_READY',
  'RESUME_VERSION_STALE', 'PROFILE_REVISION_MISMATCH',
  'PROFILE_DELETION_EPOCH_MISMATCH', 'INTERNAL_ERROR',
] as const satisfies readonly AgentErrorCode[];
export type MessageSseErrorCode = (typeof MESSAGE_SSE_ERROR_CODES)[number];

type MessageFailureFor<C extends MessageSseErrorCode> = {
  readonly code: C;
  readonly retryable: AgentErrorDefinition<C>['retryable'];
  readonly requiresUserAction: AgentErrorDefinition<C>['requiresUserAction'];
  readonly recommendedAction: AgentErrorDefinition<C>['recommendedAction'];
  readonly requestId: string | null;
  readonly retryAfterSeconds: number | null;
};
export type MessageFailure = { [C in MessageSseErrorCode]: MessageFailureFor<C> }[MessageSseErrorCode];

export interface QualificationDisplayCode<C extends string> {
  readonly code: C;
  readonly defaultText: string;
  readonly safeParams: Readonly<Partial<Record<SafeDisplayParamKey, string | number | boolean>>>;
}

export const QUALIFICATION_ELIGIBILITIES = ['ELIGIBLE', 'INELIGIBLE', 'UNKNOWN', 'PENDING_VERIFICATION'] as const;
export type QualificationEligibility = (typeof QUALIFICATION_ELIGIBILITIES)[number];
export const QUALIFICATION_REASON_CODES = ['SKILL_MATCH', 'EXPERIENCE_MATCH', 'LOCATION_MATCH', 'PREFERENCE_MATCH', 'GROWTH_MATCH'] as const;
export const QUALIFICATION_RISK_CODES = ['REQUIRED_SKILL_GAP', 'EXPERIENCE_GAP', 'LOCATION_CONSTRAINT', 'SPONSORSHIP_UNCLEAR', 'APPLICATION_WINDOW_RISK', 'GRADUATION_NOT_STATED', 'LEVEL_NOT_STATED', 'EXPERIENCE_NOT_STATED', 'EDUCATION_NOT_STATED', 'MUST_HAVE_NOT_STATED'] as const;
export const QUALIFICATION_MISSING_CODES = ['WORK_AUTHORIZATION', 'REQUIRED_SKILL', 'YEARS_EXPERIENCE', 'EDUCATION', 'LOCATION'] as const;
export const SPONSORSHIP_STATUSES = ['SUPPORTED', 'NOT_SUPPORTED', 'UNKNOWN', 'PENDING_VERIFICATION'] as const;
export const SPONSORSHIP_SOURCE_CODES = ['JOB_POSTING', 'EMPLOYER_POLICY', 'USER_PROVIDED', 'UNKNOWN'] as const;
export const REFERRAL_AVAILABILITIES = ['AVAILABLE', 'UNAVAILABLE', 'UNKNOWN'] as const;
/** LOCATION admission tier: A accepted outright, B needs the candidate's confirmation, C excluded. */
export const LOCATION_TIERS = ['A', 'B', 'C'] as const;
export type LocationTier = (typeof LOCATION_TIERS)[number];
/** Hard criteria the active recommendation policy admitted as "confirm before you rely on it". */
export const PENDING_CONFIRMATION_CODES = ['SPONSORSHIP', 'LOCATION', 'GRADUATION', 'LEVEL', 'EXPERIENCE', 'EDUCATION', 'REQUIRED_SKILL'] as const;
export type PendingConfirmationCode = (typeof PENDING_CONFIRMATION_CODES)[number];

export interface JobCardView {
  readonly jobId: string;
  readonly title: string;
  readonly company: string;
  readonly location: string | null;
  readonly employmentType: string | null;
  readonly sourcePlatform: SourcePlatformCode;
  readonly atsProvider: AtsProviderCode;
  readonly qualification: {
    readonly eligibility: QualificationEligibility;
    readonly score: number | null;
    readonly scoreScale: 100;
    readonly reasons: readonly QualificationDisplayCode<(typeof QUALIFICATION_REASON_CODES)[number]>[];
    readonly risks: readonly QualificationDisplayCode<(typeof QUALIFICATION_RISK_CODES)[number]>[];
    readonly missingRequirements: readonly QualificationDisplayCode<(typeof QUALIFICATION_MISSING_CODES)[number]>[];
    readonly sponsorship: {
      readonly status: (typeof SPONSORSHIP_STATUSES)[number];
      readonly sourceCode: (typeof SPONSORSHIP_SOURCE_CODES)[number];
      readonly confidence: number | null;
    };
    readonly referralAvailability: (typeof REFERRAL_AVAILABILITIES)[number];
    /** Absent on cards produced before the recommendation policy existed; null when location evidence was unresolved. */
    readonly locationTier?: LocationTier | null;
    /** Non-empty only when eligibility is UNKNOWN and the active policy admitted the job flagged. */
    readonly pendingConfirmations?: readonly QualificationDisplayCode<PendingConfirmationCode>[];
  };
}

export const SYSTEM_NOTICE_CODES = ['WELCOME', 'SESSION_RESTORED', 'ACTION_EXPIRED', 'MISSION_CANCELLED', 'CONTENT_UNAVAILABLE'] as const;
export const GENERATION_LOCALES = ['en-US', 'zh-CN'] as const;
export type GenerationLocale = (typeof GENERATION_LOCALES)[number];

interface PartBase { readonly partId: Uuid }
export interface TextMessagePart extends PartBase {
  readonly type: 'text';
  readonly text: string;
  readonly locale: GenerationLocale | null;
}
export interface JobCardMessagePart extends PartBase { readonly type: 'job_card'; readonly job: JobCardView }
export interface MissionReferenceMessagePart extends PartBase {
  readonly type: 'mission_ref'; readonly missionId: Uuid; readonly revision: DecimalString;
  readonly status: MissionStatus; readonly progressCode: MissionProgressCode;
}
export interface MissionProgressSnapshot {
  readonly missionId: Uuid; readonly revision: DecimalString; readonly status: MissionStatus;
  readonly progressCode: MissionProgressCode; readonly completed: number; readonly total: number;
  readonly currentStep: { readonly stepId: Uuid; readonly sequence: number; readonly type: MissionStepType; readonly status: MissionStepStatus } | null;
  readonly needsUserInput: { readonly kind: 'IN_PAGE_ACTION' | 'CHAT_ANSWER' | 'SENSITIVE_CONFIRM'; readonly actionId: Uuid; readonly messageCode: 'COMPLETE_IN_PAGE_FIELD' | 'ANSWER_IN_CHAT' | 'CONFIRM_NON_DENYLISTED_FIELD' | 'REAUTHENTICATE_EXTENSION' | 'REVIEW_APPLICATION_PLAN' } | null;
  readonly updatedAt: IsoDateTime;
}
export interface MissionProgressMessagePart extends PartBase { readonly type: 'mission_progress'; readonly mission: MissionProgressSnapshot }
export interface ActionCardMessagePart extends PartBase { readonly type: 'action_card'; readonly card: ActionCardView }
export const WORKFLOW_ACTION_CODES = ['UPLOAD_RESUME', 'OPEN_GAP_REPORT'] as const;
export type WorkflowActionCode = (typeof WORKFLOW_ACTION_CODES)[number];
export interface WorkflowActionMessagePart extends PartBase {
  readonly type: 'workflow_action';
  readonly action: {
    readonly code: WorkflowActionCode;
    /** Localized visible label; routing is always derived from the closed code. */
    readonly label: string;
  };
}
export interface RecommendationReferenceMessagePart extends PartBase { readonly type: 'recommendation_batch_ref'; readonly batchId: Uuid }
export interface SystemNoticeMessagePart extends PartBase {
  readonly type: 'system_notice'; readonly code: (typeof SYSTEM_NOTICE_CODES)[number];
  readonly severity: 'INFO' | 'WARNING' | 'ERROR';
  readonly safeParams: Readonly<Record<string, string | number | boolean>>;
}
export type PersistedMessagePart = TextMessagePart | JobCardMessagePart | MissionReferenceMessagePart |
  MissionProgressMessagePart | ActionCardMessagePart | WorkflowActionMessagePart | RecommendationReferenceMessagePart |
  SystemNoticeMessagePart | DailyReportMessagePart;

interface PersistedMessageBase {
  readonly id: Uuid;
  readonly clientMessageId: Uuid | null;
  readonly turnId: Uuid | null;
  readonly sequence: DecimalString;
  readonly speaker: MessageSpeaker;
  readonly parts: readonly PersistedMessagePart[];
  readonly createdAt: IsoDateTime;
  readonly updatedAt: IsoDateTime;
}
export type PersistedMessageView = PersistedMessageBase & (
  | { readonly status: 'FAILED' | 'CANCELLED'; readonly error: MessageFailure }
  | { readonly status: 'PENDING' | 'STREAMING' | 'COMPLETED'; readonly error: null }
);

export interface ListConversationMessagesParams { readonly conversationId: Uuid }
export type ListConversationMessagesQuery =
  | { readonly beforeSequence?: DecimalString; readonly afterSequence?: never; readonly limit?: number }
  | { readonly beforeSequence?: never; readonly afterSequence?: DecimalString; readonly limit?: number };
export interface ListConversationMessagesResponse extends AgentSchemaEnvelope {
  readonly messages: readonly PersistedMessageView[];
  readonly page: {
    readonly oldestSequence: DecimalString | null; readonly newestSequence: DecimalString | null;
    readonly hasOlder: boolean; readonly hasNewer: boolean;
    readonly nextBeforeSequence: DecimalString | null; readonly nextAfterSequence: DecimalString | null;
  };
}
export interface GetConversationMessageParams { readonly conversationId: Uuid; readonly messageId: Uuid }
export interface GetConversationMessageResponse extends AgentSchemaEnvelope {
  readonly message: PersistedMessageView; readonly pollAfterMs: number | null;
}

export interface SendTextPart { readonly type: 'text'; readonly text: string }
export interface SendJobReferencePart { readonly type: 'job_ref'; readonly jobId: string }
export type SendMessagePart = SendTextPart | SendJobReferencePart;
export interface SendConversationMessageParams { readonly conversationId: Uuid }
export interface SendConversationMessageRequest {
  readonly clientMessageId: Uuid;
  readonly generationLocale: GenerationLocale;
  readonly parts: readonly SendMessagePart[];
}

export interface DecideConversationActionParams { readonly conversationId: Uuid; readonly actionId: Uuid }
export type DecideConversationActionRequest = {
  readonly clientRequestId: Uuid;
} & (
  | { readonly actionCode: 'SEND_REPLY'; readonly actionRevision: DecimalString; readonly payloadDigest: Sha256Digest; readonly reply: SendTextPart }
  | { readonly actionCode: 'CONFIRM' | 'OPEN_WORKSPACE'; readonly actionRevision: DecimalString; readonly payloadDigest: Sha256Digest; readonly reply?: never }
  | { readonly actionCode: 'SUBMIT_ANSWER'; readonly expectedRevision: DecimalString; readonly answerSchemaVersion: 1; readonly answer: AnswerValueV1; readonly scopeRef: AnswerScopeRef }
);
export interface DecideConversationActionResponse extends AgentSchemaEnvelope {
  readonly actionCard: ActionCardView;
  readonly effects: { readonly appendedMessageIds: readonly Uuid[]; readonly missionId: Uuid | null };
}

export const MESSAGE_SSE_EVENT_NAMES = ['message.started', 'message.delta', 'tool.started', 'tool.completed', 'mission.progress', 'action.updated', 'message.completed', 'error', 'done'] as const;
export type MessageSseEventName = (typeof MESSAGE_SSE_EVENT_NAMES)[number];
interface SseBase extends AgentSchemaEnvelope {
  readonly eventSequence: DecimalString; readonly streamId: Uuid; readonly conversationId: Uuid;
  readonly turnId: Uuid; readonly occurredAt: IsoDateTime;
}
export const TOOL_ACTIVITY_CODES = ['ANALYZING_REQUEST', 'READING_PROFILE', 'READING_RESUME', 'RESOLVING_JOB', 'SCORING_JOB', 'PREPARING_APPLICATION', 'WAITING_FOR_APPROVAL', 'EXECUTING_APPLICATION'] as const;
type ActivityCode = (typeof TOOL_ACTIVITY_CODES)[number];
type Frame<E extends MessageSseEventName, D extends SseBase> = { readonly id: DecimalString; readonly event: E; readonly data: D };

export interface MessageStartedSseData extends SseBase {
  readonly userMessage: { readonly id: Uuid; readonly clientMessageId: Uuid; readonly sequence: DecimalString };
  readonly assistantMessage: { readonly id: Uuid; readonly sequence: DecimalString; readonly speaker: MessageSpeaker };
}
export interface MessageDeltaSseData extends SseBase { readonly messageId: Uuid; readonly partId: Uuid; readonly partIndex: number; readonly delta: string }
export interface ToolStartedSseData extends SseBase { readonly activityId: Uuid; readonly activityCode: ActivityCode; readonly requiresUserAction: boolean }
export interface ToolCompletedSseData extends SseBase { readonly activityId: Uuid; readonly activityCode: ActivityCode; readonly outcomeCode: 'SUCCEEDED' | 'FAILED' | 'DENIED' | 'TIMED_OUT' }
export interface MissionProgressSseData extends SseBase { readonly mission: MissionProgressSnapshot }
export interface ActionUpdatedSseData extends SseBase { readonly messageId: Uuid; readonly partId: Uuid; readonly partIndex: number; readonly card: ActionCardView }
export interface MessageCompletedSseData extends SseBase { readonly message: PersistedMessageView; readonly finishReason: 'STOP' | 'TOOL_LOOP_COMPLETED' }

type MessageErrorSseDataFor<C extends MessageSseErrorCode> = SseBase & {
  readonly statusCode: AgentErrorDefinition<C>['statusCode']; readonly code: C; readonly message: string;
  readonly retryable: AgentErrorDefinition<C>['retryable']; readonly retryAfterSeconds: number | null;
  readonly requiresUserAction: AgentErrorDefinition<C>['requiresUserAction'];
  readonly recommendedAction: AgentErrorDefinition<C>['recommendedAction'];
  readonly messageId: Uuid; readonly requestId: string;
};
export type MessageErrorSseData = { [C in MessageSseErrorCode]: MessageErrorSseDataFor<C> }[MessageSseErrorCode];
export interface MessageDoneSseData extends SseBase { readonly messageId: Uuid; readonly terminalStatus: 'COMPLETED' | 'FAILED' | 'CANCELLED' }

export type MessageSseFrame =
  | Frame<'message.started', MessageStartedSseData>
  | Frame<'message.delta', MessageDeltaSseData>
  | Frame<'tool.started', ToolStartedSseData>
  | Frame<'tool.completed', ToolCompletedSseData>
  | Frame<'mission.progress', MissionProgressSseData>
  | Frame<'action.updated', ActionUpdatedSseData>
  | Frame<'message.completed', MessageCompletedSseData>
  | Frame<'error', MessageErrorSseData>
  | Frame<'done', MessageDoneSseData>;

/** Reject a transport frame whose SSE id disagrees with its JSON sequence. */
export function isMessageSseFrameIdConsistent(frame: MessageSseFrame): boolean {
  return frame.id === frame.data.eventSequence;
}
