export { PLATFORM_ACCOUNT_HEADER, PLATFORM_ACCOUNT_QUERY, platformAccountId } from './account-context.ts';
export * from './mcp.ts';
export * from './conversation-tasks.ts';
export * from './audio-transcriptions.ts';
import type { ChatAttachmentSupport, ReviewedAudioTranscript } from './audio-transcriptions.ts';
import type { McpTaskSummary } from './mcp.ts';
import type { ModelStepContext, ModelStepEvent, ModelStepResult, ToolEffect } from './agent-loop.ts';
export const CHAT_MODES = ['chat', 'companion', 'agent'] as const;
export type ChatMode = typeof CHAT_MODES[number];
export const JOB_KINDS = ['image', 'video', 'speech', 'browser', 'cli', 'workflow', 'mcp'] as const;
export type JobKind = typeof JOB_KINDS[number];
export type Capability = 'chat' | 'agent' | 'image' | 'video' | 'speech' | 'transcription' | 'realtime' | 'browser' | 'cli' | 'workflow' | 'mcp';

/** Public identity of a server-reviewed generation template; never contains its graph or path. */
export interface ExecutionTemplateBinding { version: 1; hash: string; }
/** Private worker snapshot, stored in the execution policy rather than a client plan. */
export interface ComfyUITemplateSnapshot extends ExecutionTemplateBinding {
  /** Absent only in historical snapshots; new preparation and execution require a kind. */
  outputKind?: 'image' | 'video';
  baseUrl: string; promptNode: string; promptField: string; graph: Record<string, unknown>;
}

export interface ProviderStatus {
  id: string;
  name: string;
  keyConfigured: boolean;
  enabled: boolean;
  capabilities: Capability[];
  models: string[];
  modelsByCapability?: Partial<Record<Capability,string[]>>;
  /** Explicit server purpose binding; never mixed into ordinary chat model candidates. */
  modelsByPurpose?: Partial<Record<'safety_classify',string[]>>;
  /** Supported server chat inputs and explicit local audio preprocessing; no quality claim. */
  chatAttachments?: ChatAttachmentSupport;
  /** Declared speech languages (BCP 47); absence makes no language claim. */
  speechLanguages?: string[];
  /** Voices and controls verified for the server's configured voice model. */
  voiceOptions?: Partial<Record<'speech' | 'realtime', {
    voices: string[]; defaultVoice: string; instructions?: boolean; turnTaking?: boolean;
  }>>;
  referenceImages?: Partial<Record<'image' | 'video', {
    maxImages: number; maxTotalBytes: number; mimeTypes: string[];
    binding: 'openai_edits' | 'ark_video' | 'fal_input';
  }>>;
  envVariables: string[];
  reason?: string;
  documentationUrl?: string;
  browserActionsEnabled?: boolean;
  browserFixtureOrigins?: string[];
  executionTemplate?: ExecutionTemplateBinding;
}

export interface User { id: string; email: string; name: string; emailVerified?: boolean; }
export interface AuthOptions { emailActionsEnabled: boolean; requireVerifiedEmail: boolean; }
export interface Conversation {
  id: string; title: string; mode: ChatMode; persona?: string;
  createdAt: string; updatedAt: string;
}
export interface Message {
  id: string; conversationId: string;
  role: 'user' | 'assistant' | 'tool'; content: string;
  status: 'complete' | 'streaming' | 'failed' | 'cancelled';
  provider?: string; model?: string; createdAt: string;
  attachments?: Attachment[];
  audioTranscripts?: ReviewedAudioTranscript[];
}
export interface Memory { id: string; content: string; createdAt: string; }
/** Private user-selected knowledge. Source URLs are provenance metadata, never fetched. */
export const KNOWLEDGE_SOURCE_MAX_BYTES = 64 * 1024;
export const KNOWLEDGE_SOURCE_LIMIT = 200;
export const KNOWLEDGE_PASSAGE_MAX_CHARACTERS = 1200;
export const KNOWLEDGE_SEARCH_MAX_RESULTS = 8;
export const KNOWLEDGE_RESULT_MAX_BYTES = 48 * 1024;
export interface KnowledgeSourceInput {
  title: string; content: string; sourceLabel?: string; sourceUrl?: string;
}
export interface KnowledgeSourceSummary {
  id: string; title: string; sourceLabel?: string; sourceUrl?: string;
  revision: number; passageCount: number; byteSize: number;
  createdAt: string; updatedAt: string;
}
export interface KnowledgeSource extends KnowledgeSourceSummary { content: string; }
export interface KnowledgeSearchInput { query: string; limit?: number; sourceIds?: string[]; }
export interface KnowledgePassageInput { sourceId: string; revision: number; passageId: string; }
/** A citation identifies the exact current version; stale versions must fail instead of mixing text. */
export interface KnowledgePassage extends KnowledgePassageInput {
  title: string; passageIndex: number; text: string; updatedAt: string;
  sourceLabel?: string; sourceUrl?: string; provenance: 'untrusted_knowledge';
}
export interface KnowledgeSearchResult {
  query: string; method: 'lexical'; matches: KnowledgePassage[];
}
export interface Attachment { id: string; name: string; mime: string; size: number; url: string; }
export type VoiceRecordSource = 'realtime_transcript' | 'transcription_excerpt' | 'speech_excerpt';
export interface VoiceRecordInput {
  clientRecordId: string; source: VoiceRecordSource;
  role: 'user' | 'assistant' | 'unknown'; text: string;
  sessionId?: string; attachmentIds?: string[];
}
export interface VoiceRecord {
  id: string; conversationId: string; clientRecordId: string;
  source: VoiceRecordSource; role: 'user' | 'assistant' | 'unknown'; text: string;
  provenance: 'client_submitted'; sessionId?: string;
  provider?: string; model?: string; attachments: Attachment[]; createdAt: string;
}
export type JobStatus = 'needs_approval' | 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'uncertain';
export interface Artifact { id: string; name: string; mime: string; url: string; size?: number; }
/** Private artifact data, read in bounded UTF-8 pages; never an execution instruction. */
export const ARTIFACT_TEXT_MIME_TYPES = ['text/plain', 'text/markdown', 'text/csv', 'application/json'] as const;
export const ARTIFACT_TEXT_SOURCE_MAX_BYTES = 1024 * 1024;
export interface ArtifactTextInput {
  artifactId: string; offset?: number; version?: string; maxBytes?: number;
}
export interface ArtifactTextResult {
  source: { artifactId: string; jobId: string; name: string; mime: string; size: number; workflowStep?: number };
  provenance: 'untrusted_artifact'; encoding: 'utf-8'; version: string;
  offset: number; nextOffset: number | null; truncated: boolean; text: string;
}
export interface CreateJobInput {
  kind: JobKind; provider: string; prompt: string; model?: string;
  options?: Record<string, unknown>; attachmentIds?: string[];
  executionTemplate?: ExecutionTemplateBinding;
}
export type BrowserTarget = { by: 'role'; role: 'link' | 'button' | 'textbox' | 'combobox'; name: string } | { by: 'label'; name: string };
export type BrowserAction =
  | { type: 'click'; target: BrowserTarget }
  | { type: 'fill'; target: BrowserTarget; value: string }
  | { type: 'select'; target: BrowserTarget; optionLabel: string }
  | { type: 'scroll'; direction: 'up' | 'down'; pixels: number };
export interface BrowserTaskOptions { url: string; actions?: BrowserAction[]; }
export interface BrowserObservation {
  version: 1; provenance: 'untrusted_page'; requestedUrl: string; url: string;
  title: string; text: string; completedActions: number;
  targets: { target: BrowserTarget; action: 'click' | 'fill' | 'select' }[];
}
export interface BrowserCheckpoint {
  definitionHash: string; revision: number; nextIndex: number;
  state: 'ready' | 'started' | 'completed' | 'uncertain';
}
export type BrowserCheckpointEvent = {
  definitionHash: string; expectedRevision: number; index: number;
} & ({ type: 'started' } | { type: 'completed'; result: JobExecutionResult });
export interface WorkflowStep {
  kind: 'chat' | 'image' | 'video' | 'speech'; provider: string;
  prompt: string; model?: string; options?: Record<string, unknown>;
  referenceImages?: { fromStep: number; imageIndex?: number }[];
  executionTemplate?: ExecutionTemplateBinding;
}
export interface WorkflowTemplateInput {
  name: string; description?: string; steps: WorkflowStep[];
}
export interface WorkflowTemplate extends WorkflowTemplateInput {
  id: string; revision: number; createdAt: string; updatedAt: string;
}
export interface WorkflowArtifactRef {
  attachmentId: string; name: string; mime: string; size: number;
}
export interface WorkflowStepCheckpoint {
  index: number; inputHash: string;
  state: 'started' | 'provider_task' | 'completed' | 'failed' | 'uncertain';
  providerTaskId?: string; text?: string; artifacts?: WorkflowArtifactRef[];
  errorCode?: string;
}
export interface WorkflowCheckpoint {
  definitionHash: string; revision: number; steps: WorkflowStepCheckpoint[];
}
export type WorkflowCheckpointEvent = {
  index: number; inputHash: string; expectedRevision: number;
} & (
  | { type: 'started' }
  | { type: 'provider_task'; providerTaskId: string }
  | { type: 'completed'; result: JobExecutionResult }
  | { type: 'failed' | 'uncertain'; errorCode: string }
);
export interface Job extends CreateJobInput {
  mcp?: McpTaskSummary;
  id: string; status: JobStatus; progress: number; artifacts: Artifact[];
  createdAt: string; updatedAt: string; error?: { code: string; message: string };
  providerTaskId?: string; attempt: number;
  workflowSteps?: { index: number; kind: WorkflowStep['kind']; provider: string;
    model?: string; state: WorkflowStepCheckpoint['state'] | 'pending'; errorCode?: string }[];
  workflowResumeAvailable?: boolean;
  browserExecution?: { completedActions: number; totalActions: number; state: BrowserCheckpoint['state']; reviewRequired: boolean };
}
export interface Approval {
  id: string; jobId: string; toolName: string; args: Record<string, unknown>;
  status: 'pending' | 'approved' | 'rejected'; createdAt: string;
}
export type ChatStreamEvent =
  | { type: 'delta'; text: string }
  | { type: 'tool'; name: string; callId: string; input: Record<string, unknown>; result?: unknown }
  | { type: 'usage'; inputTokens: number; outputTokens: number }
  | { type: 'approval'; id: string; toolName: string; args: Record<string, unknown>; status: string };

export interface ToolDefinition {
  name: string; description: string; parameters: Record<string, unknown>;
  /** Required by the shared agent loop; optional only for existing legacy tools. */
  effect?: ToolEffect; progressPhrase?: string; endsTurn?: boolean;
}
export interface ProviderChatMessage { role: 'user' | 'assistant' | 'system'; content: string; attachments?:ProviderAttachment[]; }
export interface ChatInput {
  provider: string; model?: string; mode: ChatMode; messages: ProviderChatMessage[];
  persona?: string; memories?: string[]; attachments?: ProviderAttachment[];
}
export interface ProviderAttachment { name: string; mime: string; bytes: Uint8Array; }
/** Server-only request admission. A launch must synchronously start the request with the supplied signal. */
export type ProviderRequestAdmission = <T>(launch: (signal: AbortSignal) => Promise<T>, signal?: AbortSignal) => Promise<T>;
export interface ProviderRequestContext { signal?: AbortSignal; requestAdmission?: ProviderRequestAdmission; }
export interface ChatContext extends ProviderRequestContext {
  signal?: AbortSignal;
  tools?: ToolDefinition[];
  executeTool?: (name: string, input: Record<string, unknown>) => Promise<unknown>;
  /** Server-owned accounting hook. Contains identifiers and counts only, never conversation text. */
  onModelCall?: (event: ModelCallEvent) => Promise<void> | void;
}
export type ModelCallUsage = { status: 'reported'; inputTokens: number; outputTokens: number } | { status: 'missing' | 'invalid' };
export type ModelCallEvent =
  | { type: 'started'; callId: string; index: number; provider: string; model: string; purpose?: string }
  | { type: 'finished'; callId: string; status: 'complete' | 'failed' | 'cancelled' | 'interrupted'; usage: ModelCallUsage };
export interface AccountUsage {
  period: { from: string; to: string; timeZone: 'UTC' };
  chat: {
    calls: number; reportedCalls: number; missingCalls: number; invalidCalls: number; pendingCalls: number;
    inputTokens: number | null; outputTokens: number | null;
    coverage: 'none' | 'partial' | 'complete';
    outcomes: { complete: number; failed: number; cancelled: number; interrupted: number; running: number };
    providers: { provider: string; model: string; calls: number; reportedCalls: number; inputTokens: number | null; outputTokens: number | null }[];
    legacyReports: number;
  };
}
export interface GeneratedArtifact { name: string; mime: string; bytes: Uint8Array; }
export interface ModelRelayRequest {
  requestId: string; body: Record<string, unknown>; signal: AbortSignal;
}
export interface JobExecutionContext {
  jobId: string; userId: string; signal?: AbortSignal;
  requestAdmission?: ProviderRequestAdmission;
  workspaceDirectory: string;
  previousProviderTaskId?: string;
  readAttachment?: (id: string) => Promise<ProviderAttachment>;
  requestModel?: (request: ModelRelayRequest) => Promise<Response>;
  onProgress?: (progress: number) => Promise<void> | void;
  onProviderTask?: (taskId: string) => Promise<void> | void;
  workflowCheckpoint?: WorkflowCheckpoint;
  onWorkflowCheckpoint?: (event: WorkflowCheckpointEvent) => Promise<WorkflowCheckpoint>;
  readWorkflowArtifact?: (attachmentId: string) => Promise<ProviderAttachment>;
  browserCheckpoint?: BrowserCheckpoint;
  onBrowserCheckpoint?: (event: BrowserCheckpointEvent) => Promise<BrowserCheckpoint>;
  assertBrowserAuthorized?: () => Promise<void>;
  comfyuiTemplate?: ComfyUITemplateSnapshot;
  workflowComfyUITemplates?: Record<string, ComfyUITemplateSnapshot>;
}
export interface JobExecutionResult { artifacts: GeneratedArtifact[]; text?: string; providerTaskId?: string; }
/** Omitted provider preserves the OpenAI default; an explicit provider must never fall back. */
export interface VoiceSessionInput { provider?: string; model?: string; persona?: string; voice?: string; turnTaking?: 'patient' | 'balanced' | 'quick'; }
export interface SpeechInput { provider?: string; text: string; voice?: string; model?: string; instructions?: string; }
export interface TranscriptionContext extends ProviderRequestContext { provider?: string; }
export interface VoiceSessionResult { clientSecret: string; model: string; endpoint: string; expiresAt?: number; inputTranscriptionEnabled?: boolean; }

export interface PlatformProviderRuntime {
  capabilities(): ProviderStatus[];
  captureComfyUITemplate?(): ComfyUITemplateSnapshot;
  validateComfyUITemplate?(snapshot: ComfyUITemplateSnapshot, binding: ExecutionTemplateBinding): void;
  streamChat(input: ChatInput, context?: ChatContext): AsyncIterable<ChatStreamEvent>;
  /** One actual provider request. Optional only for trusted legacy runtime fixtures. */
  streamModelStep?(input: ChatInput, context: ModelStepContext): AsyncGenerator<ModelStepEvent, ModelStepResult>;
  executeJob(input: CreateJobInput, context: JobExecutionContext): Promise<JobExecutionResult>;
  createVoiceSession(input?: VoiceSessionInput, context?: ProviderRequestContext): Promise<VoiceSessionResult>;
  transcribe(input: ProviderAttachment, context?: TranscriptionContext): Promise<{ text: string }>;
  speech(input: SpeechInput, context?: ProviderRequestContext): Promise<GeneratedArtifact>;
}
export * from './plans.ts';
export * from './goal-proposals.ts';
export * from './job-outcome-reviews.ts';
export * from './voice-context.ts';
export * from './student-api.ts';

export * from './agent-loop.ts';
export * from './staff.ts';
export * from './student-entry.ts';
export * from './onboarding.ts';
