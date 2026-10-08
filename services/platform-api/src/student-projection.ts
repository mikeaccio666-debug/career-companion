import type {
  AccountUsage, Attachment, AudioTranscriptionReceipt, Capability, ChatAttachmentSupport,
  Message, PlatformFeatures, PublicAccountUsage, PublicAudioTranscriptionReceipt,
  PublicCapabilities, PublicChatAttachmentSupport, PublicMessage, PublicReviewedAudioTranscript,
  PublicVoiceRecord, PublicVoiceSessionResponse, ReviewedAudioTranscript, VoiceRecord,
  VoiceSessionResponse,
  Approval, Artifact, Conversation, ConversationTaskPage, CreateJobInput, GoalPlan,
  GoalPlanContinueResult, GoalPlanContinuation, GoalPlanInputSnapshot, GoalPlanInputSource,
  GoalPlanList, GoalPlanProposalList, GoalPlanProposalResult, GoalPlanProposalSummary,
  GoalPlanReceipt, GoalPlanStep, GoalPlanStepInput, GoalPlanTaskBindings, Job,
  JobOutcomeEvidence, JobOutcomeReviewPage, JobOutcomeReviewRecord, JobOutcomeReviewSaved,
  PublicApproval, PublicConversation, PublicConversationTaskPage, PublicError,
  PublicGoalPlan, PublicGoalPlanContinueResult, PublicGoalPlanContinuation,
  PublicGoalPlanInputSnapshot, PublicGoalPlanList, PublicGoalPlanProposalList,
  PublicGoalPlanProposalResult, PublicGoalPlanProposalSummary, PublicGoalPlanStep,
  PublicGoalPlanStepInput, PublicJob, PublicJobOutcomeEvidence, PublicJobOutcomeReviewPage,
  PublicJobOutcomeReviewSaved, PublicTaskDefinition, PublicWorkflowTemplate, WorkflowTemplate,
} from '@companion/platform-contracts';

/** Pure presentation only: adapters select public vs internal DTOs. No execution or authorization occurs here. */
export function projectPlatformFeatures(policy: { workbench: boolean; providerDetails: boolean }): PlatformFeatures {
  return { version: 1, workbench: policy.workbench, providerDetails: policy.providerDetails };
}

/** Availability is computed by the caller's server-owned routing policy, never guessed here. */
export function projectPublicCapabilities(
  capabilities: Readonly<Record<Capability, boolean>>,
  chatAttachments?: ChatAttachmentSupport,
): PublicCapabilities {
  return {
    capabilities: {
      chat: capabilities.chat, agent: capabilities.agent,
      image: capabilities.image, video: capabilities.video,
      speech: capabilities.speech, transcription: capabilities.transcription, realtime: capabilities.realtime,
      browser: capabilities.browser, cli: capabilities.cli, workflow: capabilities.workflow, mcp: capabilities.mcp,
    },
    ...(chatAttachments === undefined ? {} : { chatAttachments: projectPublicChatAttachmentSupport(chatAttachments) }),
  };
}

export function projectPublicChatAttachmentSupport(support: ChatAttachmentSupport): PublicChatAttachmentSupport {
  const audio = support.audioTranscripts;
  return {
    directMimeTypes: [...support.directMimeTypes],
    maxAttachments: support.maxAttachments,
    maxTotalBytes: support.maxTotalBytes,
    audioTranscripts: {
      mimeTypes: [...audio.mimeTypes],
      maxAudioBytes: audio.maxAudioBytes,
      maxDurationSeconds: audio.maxDurationSeconds,
      maxPerMessage: audio.maxPerMessage,
      maxReviewedCharacters: audio.maxReviewedCharacters,
      available: audio.available,
      reviewRequired: audio.reviewRequired,
    },
  };
}

export function projectPublicAudioTranscriptionReceipt(receipt: AudioTranscriptionReceipt): PublicAudioTranscriptionReceipt {
  return {
    id: receipt.id,
    sourceAttachmentId: receipt.sourceAttachmentId,
    sourceName: receipt.sourceName,
    sourceMime: receipt.sourceMime,
    sourceSha256: receipt.sourceSha256,
    text: receipt.text,
    provenance: receipt.provenance,
    createdAt: receipt.createdAt,
  };
}

export function projectPublicReviewedAudioTranscript(transcript: ReviewedAudioTranscript): PublicReviewedAudioTranscript {
  return {
    receiptId: transcript.receiptId,
    sourceAttachmentId: transcript.sourceAttachmentId,
    sourceName: transcript.sourceName,
    sourceMime: transcript.sourceMime,
    sourceSha256: transcript.sourceSha256,
    text: transcript.text,
    textModified: transcript.textModified,
    provenance: transcript.provenance,
  };
}

function projectAttachment(attachment: Attachment): Attachment {
  return {
    id: attachment.id, name: attachment.name, mime: attachment.mime,
    size: attachment.size, url: attachment.url,
  };
}

export function projectPublicMessage(message: Message): PublicMessage {
  return {
    id: message.id,
    conversationId: message.conversationId,
    role: message.role,
    content: message.content,
    status: message.status,
    createdAt: message.createdAt,
    ...(message.attachments === undefined ? {} : { attachments: message.attachments.map(projectAttachment) }),
    ...(message.audioTranscripts === undefined ? {} : { audioTranscripts: message.audioTranscripts.map(projectPublicReviewedAudioTranscript) }),
  };
}

export function projectPublicVoiceRecord(record: VoiceRecord): PublicVoiceRecord {
  return {
    id: record.id,
    conversationId: record.conversationId,
    clientRecordId: record.clientRecordId,
    source: record.source,
    role: record.role,
    text: record.text,
    provenance: record.provenance,
    ...(record.sessionId === undefined ? {} : { sessionId: record.sessionId }),
    attachments: record.attachments.map(projectAttachment),
    createdAt: record.createdAt,
  };
}

export function projectPublicVoiceSessionResponse(session: VoiceSessionResponse): PublicVoiceSessionResponse {
  const context = session.serverContext;
  return {
    clientSecret: session.clientSecret,
    endpoint: session.endpoint,
    ...(session.expiresAt === undefined ? {} : { expiresAt: session.expiresAt }),
    ...(session.inputTranscriptionEnabled === undefined ? {} : { inputTranscriptionEnabled: session.inputTranscriptionEnabled }),
    sessionId: session.sessionId,
    ...(context === undefined ? {} : { serverContext: {
      source: context.source,
      conversationId: context.conversationId,
      items: context.items.map(item => ({ messageId: item.messageId, role: item.role, text: item.text })),
      truncated: context.truncated,
    } }),
  };
}

export function projectPublicAccountUsage(usage: AccountUsage): PublicAccountUsage {
  const { chat, period } = usage;
  return {
    period: { from: period.from, to: period.to, timeZone: period.timeZone },
    chat: {
      calls: chat.calls,
      reportedCalls: chat.reportedCalls,
      missingCalls: chat.missingCalls,
      invalidCalls: chat.invalidCalls,
      pendingCalls: chat.pendingCalls,
      inputTokens: chat.inputTokens,
      outputTokens: chat.outputTokens,
      coverage: chat.coverage,
      outcomes: {
        complete: chat.outcomes.complete, failed: chat.outcomes.failed,
        cancelled: chat.outcomes.cancelled, interrupted: chat.outcomes.interrupted, running: chat.outcomes.running,
      },
      legacyReports: chat.legacyReports,
    },
  };
}

export function projectPublicConversation(conversation: Conversation): PublicConversation {
  return { id: conversation.id, title: conversation.title, createdAt: conversation.createdAt, updatedAt: conversation.updatedAt };
}

function projectArtifact(artifact: Artifact): Artifact {
  return {
    id: artifact.id, name: artifact.name, mime: artifact.mime, url: artifact.url,
    ...(artifact.size === undefined ? {} : { size: artifact.size }),
  };
}

export function projectPublicJob(job: Job & { generation?: number }): PublicJob {
  const mcp = job.mcp, browser = job.browserExecution;
  return {
    id: job.id, kind: job.kind, status: job.status, progress: job.progress, attempt: job.attempt,
    ...(job.generation === undefined ? {} : { generation: job.generation }),
    artifacts: job.artifacts.map(projectArtifact), createdAt: job.createdAt, updatedAt: job.updatedAt,
    ...(job.error === undefined ? {} : { error: projectPublicError(job.error) }),
    ...(mcp === undefined ? {} : { mcp: {
      connectionId: mcp.connectionId, connectionName: mcp.connectionName,
      catalogId: mcp.catalogId, grantVersion: mcp.grantVersion, toolName: mcp.toolName, schemaHash: mcp.schemaHash,
    } }),
    ...(job.workflowSteps === undefined ? {} : { workflowSteps: job.workflowSteps.map(step => ({
      index: step.index, kind: step.kind, state: step.state,
      ...(step.errorCode === undefined ? {} : { errorCode: projectPublicError({ code: step.errorCode, message: '' }).code }),
    })) }),
    ...(job.workflowResumeAvailable === undefined ? {} : { workflowResumeAvailable: job.workflowResumeAvailable }),
    ...(browser === undefined ? {} : { browserExecution: {
      completedActions: browser.completedActions, totalActions: browser.totalActions,
      state: browser.state, reviewRequired: browser.reviewRequired,
    } }),
  };
}

export function projectPublicApproval(approval: Approval & { generation?: number }): PublicApproval {
  return {
    id: approval.id, jobId: approval.jobId, toolName: approval.toolName, status: approval.status,
    ...(approval.generation === undefined ? {} : { generation: approval.generation }), createdAt: approval.createdAt,
  };
}

function projectTaskDefinition(task: CreateJobInput): PublicTaskDefinition {
  return { kind: task.kind, prompt: task.prompt };
}

function projectTaskBindings(bindings: GoalPlanTaskBindings): GoalPlanTaskBindings {
  const prompt = bindings.prompt;
  return {
    ...(prompt === undefined ? {} : { prompt: {
      fromStep: prompt.fromStep, source: prompt.source, mode: prompt.mode,
      ...(prompt.artifactIndex === undefined ? {} : { artifactIndex: prompt.artifactIndex }),
    } }),
    ...(bindings.referenceImages === undefined ? {} : { referenceImages: bindings.referenceImages.map(binding => ({
      fromStep: binding.fromStep, ...(binding.imageIndex === undefined ? {} : { imageIndex: binding.imageIndex }),
    })) }),
    ...(bindings.artifactFiles === undefined ? {} : { artifactFiles: bindings.artifactFiles.map(binding => ({
      fromStep: binding.fromStep, ...(binding.artifactIndex === undefined ? {} : { artifactIndex: binding.artifactIndex }),
    })) }),
  };
}

function projectPlanStepInput(input: GoalPlanStepInput): PublicGoalPlanStepInput {
  if (input.kind === 'agent_turn') return { kind: input.kind, title: input.title, instruction: input.instruction };
  return { kind: input.kind, title: input.title, task: projectTaskDefinition(input.task),
    ...(input.bindings === undefined ? {} : { bindings: projectTaskBindings(input.bindings) }) };
}

/** Copy exact provenance, including original source hashes. No projected hash is computed. */
function projectInputSource(source: GoalPlanInputSource): GoalPlanInputSource {
  switch (source.source) {
    case 'analysis_text': return { source: source.source, fromStep: source.fromStep, mode: source.mode, messageId: source.messageId, sha256: source.sha256, byteSize: source.byteSize };
    case 'artifact_text': return { source: source.source, fromStep: source.fromStep, mode: source.mode, artifactIndex: source.artifactIndex, jobId: source.jobId, generation: source.generation, artifactId: source.artifactId, mime: source.mime, sha256: source.sha256, byteSize: source.byteSize };
    case 'reference_image': return { source: source.source, fromStep: source.fromStep, imageIndex: source.imageIndex, jobId: source.jobId, generation: source.generation, artifactId: source.artifactId, attachmentId: source.attachmentId, mime: source.mime, sha256: source.sha256, byteSize: source.byteSize };
    case 'artifact_file': return { source: source.source, fromStep: source.fromStep, artifactIndex: source.artifactIndex, jobId: source.jobId, generation: source.generation, artifactId: source.artifactId, attachmentId: source.attachmentId, name: source.name, mime: source.mime, sha256: source.sha256, byteSize: source.byteSize };
  }
}

function projectPlanReceipt(receipt: GoalPlanReceipt): GoalPlanReceipt {
  return receipt.kind === 'task'
    ? { kind: receipt.kind, jobId: receipt.jobId, generation: receipt.generation, artifactIds: [...receipt.artifactIds], completedAt: receipt.completedAt }
    : { kind: receipt.kind, messageId: receipt.messageId, completedAt: receipt.completedAt };
}

function projectPlanStep(step: GoalPlanStep): PublicGoalPlanStep {
  return {
    index: step.index, input: projectPlanStepInput(step.input), state: step.state, ready: step.ready,
    ...(step.blockReason === undefined ? {} : { blockReason: step.blockReason }),
    ...(step.job === undefined ? {} : { job: projectPublicJob(step.job) }),
    ...(step.generation === undefined ? {} : { generation: step.generation }),
    ...(step.approval === undefined ? {} : { approval: projectPublicApproval(step.approval) }),
    artifacts: step.artifacts.map(projectArtifact),
    ...(step.messageId === undefined ? {} : { messageId: step.messageId }),
    ...(step.receipt === undefined ? {} : { receipt: projectPlanReceipt(step.receipt) }),
    ...(step.resolvedTask === undefined ? {} : { resolvedTask: projectTaskDefinition(step.resolvedTask) }),
    ...(step.inputSources === undefined ? {} : { inputSources: step.inputSources.map(projectInputSource) }),
  };
}

export function projectPublicGoalPlan(plan: GoalPlan): PublicGoalPlan {
  return {
    id: plan.id, conversationId: plan.conversationId, revision: plan.revision, status: plan.status,
    definitionHash: plan.definitionHash, title: plan.title, goal: plan.goal, steps: plan.steps.map(projectPlanStep),
    createdAt: plan.createdAt, updatedAt: plan.updatedAt,
    ...(plan.confirmedAt === undefined ? {} : { confirmedAt: plan.confirmedAt }),
  };
}

export function projectPublicGoalPlanList(list: GoalPlanList): PublicGoalPlanList {
  return { plans: list.plans.map(projectPublicGoalPlan), limit: list.limit };
}

export function projectPublicGoalPlanContinuation(continuation: GoalPlanContinuation): PublicGoalPlanContinuation {
  return { planId: continuation.planId, revision: continuation.revision, stepIndex: continuation.stepIndex, conversationId: continuation.conversationId };
}

export function projectPublicGoalPlanInputSnapshot(snapshot: GoalPlanInputSnapshot): PublicGoalPlanInputSnapshot {
  return {
    planId: snapshot.planId, revision: snapshot.revision, stepIndex: snapshot.stepIndex,
    templateHash: snapshot.templateHash, effectiveInputHash: snapshot.effectiveInputHash,
    inputSources: snapshot.inputSources.map(projectInputSource),
  };
}

export function projectPublicGoalPlanContinueResult(result: GoalPlanContinueResult): PublicGoalPlanContinueResult {
  const plan = projectPublicGoalPlan(result.plan);
  switch (result.kind) {
    case 'task': return { kind: result.kind, plan, stepIndex: result.stepIndex, job: projectPublicJob(result.job),
      ...(result.approval === undefined ? {} : { approval: projectPublicApproval(result.approval) }) };
    case 'agent_turn': return { kind: result.kind, plan, stepIndex: result.stepIndex, continuation: projectPublicGoalPlanContinuation(result.continuation) };
    case 'existing': return { kind: result.kind, plan, stepIndex: result.stepIndex };
  }
}

export function projectPublicGoalPlanProposalSummary(proposal: GoalPlanProposalSummary): PublicGoalPlanProposalSummary {
  return {
    planId: proposal.planId, conversationId: proposal.conversationId, title: proposal.title,
    revision: proposal.revision, status: proposal.status, stepCount: proposal.stepCount,
    messageId: proposal.messageId, createdAt: proposal.createdAt,
  };
}
export function projectPublicGoalPlanProposalList(list: GoalPlanProposalList): PublicGoalPlanProposalList {
  return { proposals: list.proposals.map(projectPublicGoalPlanProposalSummary), nextBefore: list.nextBefore, limit: list.limit };
}
export function projectPublicGoalPlanProposalResult(result: GoalPlanProposalResult): PublicGoalPlanProposalResult {
  return { proposal: projectPublicGoalPlanProposalSummary(result.proposal) };
}

export function projectPublicConversationTaskPage(page: ConversationTaskPage): PublicConversationTaskPage {
  return { tasks: page.tasks.map(task => ({
    origin: {
      conversationId: task.origin.conversationId, messageId: task.origin.messageId, tool: task.origin.tool,
      createdGeneration: task.origin.createdGeneration, createdAt: task.origin.createdAt,
    },
    job: projectPublicJob(task.job), generation: task.generation,
    ...(task.approval === undefined ? {} : { approval: projectPublicApproval(task.approval) }),
  })), nextBefore: page.nextBefore };
}

export function projectPublicWorkflowTemplate(template: WorkflowTemplate): PublicWorkflowTemplate {
  return {
    id: template.id, name: template.name,
    ...(template.description === undefined ? {} : { description: template.description }),
    steps: template.steps.map(step => ({
      kind: step.kind, prompt: step.prompt,
      ...(step.referenceImages === undefined ? {} : { referenceImages: step.referenceImages.map(binding => ({
        fromStep: binding.fromStep, ...(binding.imageIndex === undefined ? {} : { imageIndex: binding.imageIndex }),
      })) }),
    })),
    revision: template.revision, createdAt: template.createdAt, updatedAt: template.updatedAt,
  };
}

function projectOutcomeRecord(record: JobOutcomeReviewRecord): JobOutcomeReviewRecord {
  return {
    id: record.id, jobId: record.jobId, generation: record.generation, revision: record.revision,
    requestId: record.requestId, evidenceVersion: record.evidenceVersion, outcome: record.outcome,
    ...(record.note === undefined ? {} : { note: record.note }),
    provenance: record.provenance, verified: record.verified, createdAt: record.createdAt,
  };
}

function projectOutcomeEvidence(evidence: JobOutcomeEvidence): PublicJobOutcomeEvidence {
  const browser = evidence.browser, workflow = evidence.workflow, mcp = evidence.mcp;
  return {
    version: evidence.version, generation: evidence.generation, kind: evidence.kind, status: evidence.status,
    totalAttempts: evidence.totalAttempts, hasExternalTask: evidence.hasProviderTask, cleanupPending: evidence.cleanupPending,
    reasons: evidence.reasons.map(reason => reason === 'comfyui_submission_unknown' ? 'external_submission_unknown' : reason === 'model_relay_uncertain' ? 'analysis_result_unknown' : reason),
    attempts: evidence.attempts.map(attempt => ({ attempt: attempt.attempt, status: attempt.status, hasExternalTask: attempt.hasProviderTask })),
    attemptsHasMore: evidence.attemptsHasMore,
    ...(browser === undefined ? {} : { browser: { scope: browser.scope, revision: browser.revision, state: browser.state, completedActions: browser.completedActions, totalActions: browser.totalActions } }),
    ...(workflow === undefined ? {} : { workflow: { scope: workflow.scope, revision: workflow.revision, steps: workflow.steps.map(step => ({ index: step.index, state: step.state, hasExternalTask: step.hasProviderTask })) } }),
    ...(mcp === undefined ? {} : { mcp: { generation: mcp.generation, status: mcp.status, hasSavedResult: mcp.hasSavedResult } }),
  };
}

export function projectPublicJobOutcomeReviewPage(page: JobOutcomeReviewPage): PublicJobOutcomeReviewPage {
  return {
    jobId: page.jobId, requestedGeneration: page.requestedGeneration, currentGeneration: page.currentGeneration,
    evidence: page.evidence === null ? null : projectOutcomeEvidence(page.evidence),
    writeEligibility: { allowed: page.writeEligibility.allowed, reason: page.writeEligibility.reason },
    latestRevision: page.latestRevision, records: page.records.map(projectOutcomeRecord), hasMore: page.hasMore,
  };
}
export function projectPublicJobOutcomeReviewSaved(saved: JobOutcomeReviewSaved): PublicJobOutcomeReviewSaved {
  return { record: projectOutcomeRecord(saved.record) };
}

const publicErrorCatalogue = new Map<string, { code: string; message: string }>();
function keepErrorCodes(codes: readonly string[], message: string): void {
  for (const code of codes) publicErrorCatalogue.set(code, { code, message });
}
function aliasErrorCodes(codes: readonly string[], code: string, message: string): void {
  for (const internalCode of codes) publicErrorCatalogue.set(internalCode, { code, message });
}

// Exact, controlled error codes only. Original error text can reflect configuration
// or third-party details and is never used to classify or rewrite user content.
keepErrorCodes(['AUTH_REQUIRED'], 'Sign in to continue.');
keepErrorCodes(['LEGAL_DOCUMENTS_UNAVAILABLE'], 'The current legal documents are not available.');
keepErrorCodes(['TERMS_CONFIRMATION_REQUIRED', 'TERMS_VERSION_CHANGED'], 'Read and confirm the current legal documents before using AI.');
keepErrorCodes(['INVITE_REQUIRED', 'INVITE_INVALID'], 'Use a valid invitation for this email.');
keepErrorCodes(['INVALID_CREDENTIALS'], 'Email or password is incorrect.');
keepErrorCodes(['EMAIL_VERIFICATION_REQUIRED'], 'Verify your email to continue.');
keepErrorCodes(['STUDENT_ACCOUNT_REQUIRED'], 'Use a student account to continue.');
keepErrorCodes(['DATA_STORAGE_UNAVAILABLE'], 'Private intake data could not be saved or read.');
keepErrorCodes(['ONBOARDING_REVISION_CHANGED', 'ONBOARDING_STATE_CHANGED'], 'Read the current intake progress before continuing.');
keepErrorCodes(['ONBOARDING_OPERATION_CONFLICT'], 'Use a new operation identifier for a different intake change.');
keepErrorCodes(['ONBOARDING_SAFETY_UNAVAILABLE', 'ONBOARDING_SAFETY_RESPONSE_UNAVAILABLE'], 'Intake text or support resources are temporarily unavailable.');
keepErrorCodes(['ONBOARDING_SAFETY_REQUIRED', 'ONBOARDING_SAFETY_REVIEW_REQUIRED'], 'Read the current support response before continuing intake.');
keepErrorCodes(['ONBOARDING_SAFETY_CLAIM_CHANGED'], 'Read the current intake safety progress before retrying.');
keepErrorCodes(['ONBOARDING_SAFETY_PRESENTATION_REQUIRED', 'ONBOARDING_SAFETY_ACKNOWLEDGMENT_REQUIRED'], 'Read and acknowledge the current support response before continuing.');
keepErrorCodes(['ONBOARDING_SAFETY_RESPONSE_EXPIRED'], 'A current reviewed support response is needed.');
keepErrorCodes(['COMPANION_NAME_ENTRY_REVISION_CHANGED'], 'Read the current naming progress before submitting another name.');
keepErrorCodes(['COMPANION_IDENTITY_REVISION_CHANGED', 'COMPANION_SEAL_SELECTION_REVISION_CHANGED'], 'Read the current name and seal selection before choosing again.');
keepErrorCodes(['COMPANION_JOURNEY_CHANGED'], 'Read the current companion preparation again.');
keepErrorCodes(['COMPANION_BIRTH_SOURCE_CHANGED'], 'Read the current saved name and seal before continuing.');
keepErrorCodes(['COMPANION_BIRTH_OPERATION_CONFLICT'], 'Use the original birth request or a new operation key for a different request.');
keepErrorCodes(['COMPANION_EXISTS'], 'This account already has a companion. Read its saved profile.');
keepErrorCodes(['PERSONA_NOT_ACCEPTED'], 'Accept the companion preview before continuing.');
keepErrorCodes(['COMPANION_IDENTITY_REQUIRED', 'COMPANION_SEAL_SELECTION_REQUIRED'], 'Save a name and explicitly choose its current seal before continuing.');
keepErrorCodes(['NAME_REJECTED'], 'Choose another name for your companion.');
keepErrorCodes(['SEAL_REJECTED'], 'Choose a seal from the current saved candidates.');
keepErrorCodes(['COMPANION_BIRTH_STORAGE_UNAVAILABLE', 'COMPANION_BIRTH_ASSETS_UNAVAILABLE'], 'The saved companion birth could not be confirmed.');
keepErrorCodes(['COMPANION_SEAL_GLYPH_UNAVAILABLE', 'COMPANION_SEAL_GLYPH_INVALID', 'COMPANION_SEAL_RENDER_INVALID_INPUT', 'COMPANION_SEAL_RENDER_BUSY', 'COMPANION_SEAL_RENDER_TIMEOUT', 'COMPANION_SEAL_RENDER_WORKER_FAILED', 'COMPANION_SEAL_RENDER_INVALID_PNG'], 'The companion seal could not be rendered. Try again later.');
keepErrorCodes(['COMPANION_ROOM_REQUIRED'], 'Use the companion room for this action.');
keepErrorCodes(['COMPANION_NAME_OPERATION_CONFLICT'], 'Use the saved naming request or a new operation identifier for different text.');
keepErrorCodes(['COMPANION_PREVIEW_REQUIRED'], 'Wait for the completed companion preview before submitting a name.');
keepErrorCodes(['COMPANION_NAMING_UNAVAILABLE', 'COMPANION_PREBIRTH_INVENTORY_UNAVAILABLE', 'COMPANION_NAME_SAFETY_UNAVAILABLE'], 'Saved naming progress is temporarily unavailable. No new result has been inferred.');
keepErrorCodes(['COMPANION_NAME_RESOURCE_UNAVAILABLE', 'COMPANION_NAME_SAFETY_RESPONSE_UNAVAILABLE'], 'Saved naming support resources are temporarily unavailable.');
keepErrorCodes(['EMAIL_EXISTS'], 'An account already exists for this email.');
keepErrorCodes(['ACCOUNT_CONTEXT_REQUIRED', 'ACCOUNT_CONTEXT_INVALID', 'ACCOUNT_CONTEXT_CHANGED'], 'Reload the current account before continuing.');
keepErrorCodes(['ACCOUNT_ACTION_INVALID'], 'This account link is invalid or expired. Request a new email.');
keepErrorCodes(['ACCOUNT_ACTION_UNAVAILABLE'], 'The account action could not be confirmed. Please try again.');
keepErrorCodes(['ACCOUNT_EMAIL_UNAVAILABLE'], 'Account email is unavailable. No email has been sent.');
keepErrorCodes(['NOT_FOUND', 'STORAGE_NOT_FOUND'], 'Item not found.');
keepErrorCodes(['INVALID_INPUT', 'INVALID_REQUEST', 'INVALID_TOOL_ARGUMENTS'], 'The request is invalid. Check the supplied fields and try again.');
keepErrorCodes(['ORIGIN_REJECTED', 'PREFLIGHT_REJECTED'], 'Use this action from the configured application.');
keepErrorCodes(['WORKBENCH_DISABLED', 'PROVIDER_DETAILS_DISABLED', 'TOOL_NOT_ALLOWED', 'SPEECH_NOT_AVAILABLE'], 'This action is unavailable in this application.');
keepErrorCodes(['REQUEST_LIMIT_REACHED', 'ACTIVE_JOB_LIMIT', 'RUNTIME_CONCURRENCY_LIMIT', 'VOICE_SESSION_LIMIT'], 'The request limit has been reached. Wait before trying again.');
keepErrorCodes(['CONVERSATION_BUSY'], 'A response is already active in this conversation. Wait for it to finish.');
keepErrorCodes(['ASSISTANT_TURN_INACTIVE', 'CONVERSATION_TASK_ORIGIN_INACTIVE', 'GOAL_PLAN_PROPOSAL_ORIGIN_INACTIVE'], 'This response is no longer active. No new task or plan was saved.');
keepErrorCodes(['STREAM_CANCELLED', 'JOB_CANCELLED', 'KNOWLEDGE_CANCELLED', 'ARTIFACT_READ_CANCELLED', 'STORAGE_ABORTED'], 'The request was cancelled.');
keepErrorCodes(['CANCELLATION_PENDING', 'JOB_CANCELLING'], 'Cancellation was requested. Wait for execution shutdown to be confirmed.');
keepErrorCodes(['JOB_LEASE_EXPIRED', 'AUDIO_TRANSCRIPTION_LEASE_INACTIVE'], 'This request is no longer active. Review its saved result before trying again.');
keepErrorCodes(['JOB_APPROVAL_REVOKED', 'BROWSER_AUTH_REVOKED', 'MCP_AUTH_REVOKED', 'WORKFLOW_AUTH_REVOKED'], 'This task is no longer authorized to execute. Review the current task before continuing.');
keepErrorCodes(['APPROVAL_DECIDED'], 'This approval already has a decision. Read its current state.');
keepErrorCodes(['APPROVAL_STALE', 'APPROVAL_NOT_EXECUTABLE', 'JOB_NOT_AWAITING_APPROVAL', 'JOB_NOT_RETRYABLE'], 'This task cannot accept that action in its current state. Read its current version before continuing.');
keepErrorCodes(['JOB_GENERATION_CHANGED', 'JOB_OUTCOME_GENERATION_CHANGED'], 'The task version changed. Reload its current version before continuing.');
keepErrorCodes(['JOB_DEFINITION_CHANGED', 'BROWSER_DEFINITION_CHANGED', 'MCP_DEFINITION_CHANGED', 'WORKFLOW_DEFINITION_CHANGED', 'GOAL_PLAN_DEFINITION_CHANGED'], 'The reviewed task definition changed. Prepare and review a new task.');
keepErrorCodes(['BROWSER_CHECKPOINT_CONFLICT', 'WORKFLOW_CHECKPOINT_CONFLICT', 'WORKFLOW_INPUT_CHANGED', 'GOAL_PLAN_INPUT_CHANGED', 'GOAL_PLAN_SOURCE_CHANGED', 'MCP_RESULT_CHANGED', 'MCP_TOOL_CHANGED', 'MCP_SCHEMA_CHANGED', 'MCP_GRANT_CHANGED'], 'The saved source, connection or execution evidence changed. Review it before continuing.');
keepErrorCodes(['BROWSER_REVIEW_REQUIRED', 'MCP_REVIEW_REQUIRED', 'WORKFLOW_REVIEW_REQUIRED', 'QUEUE_REVIEW_REQUIRED', 'OPERATOR_REVIEW_REQUIRED'], 'Review the existing execution evidence before starting another attempt.');
keepErrorCodes(['GOAL_PLAN_REVISION_CONFLICT', 'JOB_OUTCOME_REVISION_CONFLICT', 'KNOWLEDGE_REVISION_CONFLICT', 'WORKFLOW_TEMPLATE_REVISION_CONFLICT'], 'The saved revision changed. Reload it before continuing.');
keepErrorCodes(['JOB_OUTCOME_EVIDENCE_CHANGED', 'JOB_OUTCOME_REQUEST_CONFLICT'], 'The observation no longer matches the current task evidence. Reload it before saving.');
keepErrorCodes(['JOB_OUTCOME_EVIDENCE_UNAVAILABLE'], 'The saved task evidence cannot be safely summarized. No result has been inferred.');
keepErrorCodes(['GOAL_PLAN_FROZEN'], 'This plan is already confirmed. Create a new draft to change its definition.');
keepErrorCodes(['GOAL_PLAN_BLOCKED', 'GOAL_PLAN_SOURCE_REQUIRED'], 'This step is blocked. Confirm the preceding results and current source evidence before continuing.');
keepErrorCodes(['GOAL_PLAN_STEP_ALREADY_STARTED', 'WORKFLOW_STEP_COMPLETE', 'WORKFLOW_STEP_ORDER'], 'This step cannot be started again or out of order. Read the current plan and results.');
keepErrorCodes(['GOAL_PLAN_PROPOSAL_EXISTS'], 'This response already proposed a plan. Edit its saved draft or ask for a new proposal.');
keepErrorCodes(['AUDIO_TRANSCRIPT_REQUIRED'], 'Transcribe and explicitly review the audio attachment before sending it.');
keepErrorCodes(['AUDIO_TRANSCRIPT_SOURCE_MISMATCH', 'AUDIO_TRANSCRIPTION_SOURCE_CHANGED'], 'Keep the original audio with its reviewed transcript. If the source changed, create and review a new transcription.');
keepErrorCodes(['AUDIO_TRANSCRIPTION_CONFLICT', 'VOICE_RECORD_CONFLICT'], 'This identifier was already used for a different excerpt or attachment. Use the original request or a new identifier.');
keepErrorCodes(['VOICE_SESSION_EXPIRED', 'VOICE_SESSION_SAVE_EXPIRED'], 'The voice session or its save period ended. Start a new session before saving another excerpt.');
keepErrorCodes(['AUDIO_TRANSCRIPTION_TIMEOUT'], 'Transcription exceeded its request deadline. Review its state before trying again.');
keepErrorCodes(['CHAT_ATTACHMENT_UNSUPPORTED', 'AUDIO_TRANSCRIPTION_UNSUPPORTED', 'ARTIFACT_TEXT_UNSUPPORTED', 'REFERENCE_IMAGES_UNSUPPORTED', 'REFERENCE_IMAGE_UNSUPPORTED', 'BROWSER_RESPONSE_UNSUPPORTED'], 'This file or source type is unsupported for the requested action. Choose a supported source.');
keepErrorCodes(['ARTIFACT_CHANGED', 'ARTIFACT_METADATA_MISMATCH', 'ARTIFACT_VERSION_REQUIRED', 'ARTIFACT_VERSION_UNAVAILABLE', 'ARTIFACT_OFFSET_INVALID', 'REFERENCE_IMAGE_INVALID', 'PRIVATE_FILE_SIZE_MISMATCH', 'STORAGE_CHANGED', 'STORAGE_INVALID_RANGE'], 'The file version or source metadata does not match. Reload the original source before continuing.');
keepErrorCodes(['FILE_TOO_LARGE', 'ARTIFACT_TOO_LARGE', 'ARTIFACT_TEXT_TOO_LARGE', 'CONTEXT_ATTACHMENTS_TOO_LARGE', 'REFERENCE_IMAGES_TOO_LARGE', 'REFERENCE_IMAGE_TOO_LARGE', 'VOICE_AUDIO_TOO_LARGE', 'VOICE_RECORD_TOO_LARGE', 'VOICE_HISTORY_LIMIT', 'RESPONSE_TOO_LARGE', 'BROWSER_LIMIT_EXCEEDED', 'BROWSER_RESULT_TOO_LARGE', 'WORKFLOW_RESULT_TOO_LARGE', 'WORKFLOW_OUTPUT_LIMIT', 'WORKFLOW_TEMPLATE_TOO_LARGE', 'WORKFLOW_TEMPLATE_LIMIT', 'GOAL_PLAN_CONTEXT_LIMIT', 'GOAL_PLAN_INPUT_LIMIT', 'GOAL_PLAN_LIMIT', 'GOAL_PLAN_RESULT_LIMIT', 'GOAL_PLAN_SOURCE_TOO_LARGE', 'JOB_OUTCOME_REVISION_LIMIT', 'KNOWLEDGE_REVISION_LIMIT', 'KNOWLEDGE_SOURCE_LIMIT', 'MCP_CATALOG_TOO_LARGE', 'MCP_DATA_TOO_LARGE', 'MCP_RESPONSE_TOO_LARGE', 'MCP_RESULT_TOO_LARGE', 'AGENT_TURN_LIMIT', 'TOOL_LIMIT', 'TOOL_RESULT_TOO_LARGE'], 'The request, source or result exceeds its supported limit. Reduce its size before trying again.');
keepErrorCodes(['MCP_RESULT_UNAPPROVED'], 'This saved result has no matching historical approval. It cannot be used as approved execution evidence.');
keepErrorCodes(['BROWSER_ADDRESS_BLOCKED', 'BROWSER_TARGET_BLOCKED', 'MCP_ENDPOINT_REJECTED', 'UNTRUSTED_MEDIA_URL'], 'This external destination is not permitted. Choose a supported destination.');
keepErrorCodes(['BROWSER_ACTIONS_DISABLED'], 'External browser actions are unavailable.');
keepErrorCodes(['EXECUTION_UNCERTAIN', 'EXECUTION_INTERRUPTED', 'BROWSER_CLEANUP_UNCONFIRMED', 'CLI_CLEANUP_UNCONFIRMED', 'CLI_WORKSPACE_CLEANUP_FAILED', 'WORKFLOW_CHECKPOINT_UNCONFIRMED', 'WORKFLOW_STEP_UNCERTAIN', 'MCP_INTERRUPTED', 'USAGE_RECORD_UNCONFIRMED'], 'The execution result or cleanup is unconfirmed. Review the saved evidence before another attempt; no success or replay permission has been inferred.');
keepErrorCodes(['QUEUE_CLOSED', 'QUEUE_UNAVAILABLE', 'QUEUE_RECORD_INVALID', 'REQUEST_LIMIT_UNAVAILABLE', 'GOAL_PLAN_READ_UNAVAILABLE', 'MCP_STORAGE_UNAVAILABLE', 'MCP_CONNECTION_FAILED', 'WORKFLOW_CHECKPOINT_UNAVAILABLE'], 'The requested service is unavailable. Saved state has not been treated as a completed result.');
keepErrorCodes(['ARTIFACT_READ_FAILED', 'ARTIFACT_TEXT_INVALID', 'STORAGE_READ_FAILED', 'STORAGE_INVALID_RESPONSE', 'STORAGE_TRUNCATED', 'BROWSER_RESULT_INVALID', 'MCP_DISCOVERY_INVALID', 'MCP_RESULT_INVALID', 'MCP_TOOL_ERROR', 'INVALID_TRANSCRIPTION_RESULT', 'WORKFLOW_CHECKPOINT_INVALID', 'WORKFLOW_TRANSITION_INVALID', 'CLI_EXECUTION_FAILED', 'CLI_RELAY_PROTOCOL', 'CLI_UNSAFE_FILE', 'BROWSER_EXECUTION_FAILED', 'INCOMPLETE_TOOL_CALL'], 'The requested action did not return a confirmed valid result. Review its saved state before trying again.');

aliasErrorCodes(['PROVIDER_UNSUPPORTED', 'PROVIDER_NOT_CONFIGURED', 'PROVIDER_UNAVAILABLE', 'INVALID_PROVIDER_CONFIG', 'MODEL_NOT_CONFIGURED', 'MODEL_ROUTE_UNAVAILABLE', 'MODEL_RELAY_CONFIG_INVALID', 'MODEL_RELAY_DISABLED', 'LOCAL_TRANSCRIPTION_UNAVAILABLE', 'CLI_UNAVAILABLE', 'EXECUTOR_CONFIGURATION', 'COMFYUI_TEMPLATE_UNAVAILABLE', 'WORKFLOW_PROVIDER_UNAVAILABLE', 'REFERENCE_POLICY_INVALID'], 'CAPABILITY_UNAVAILABLE', 'The requested capability is unavailable.');
aliasErrorCodes(['PROVIDER_AUTH_FAILED', 'PROVIDER_UNREACHABLE', 'PROVIDER_REJECTED'], 'RESPONSE_UNAVAILABLE', 'The response service is unavailable. Try again later.');
aliasErrorCodes(['PROVIDER_RATE_LIMIT'], 'RESPONSE_LIMIT_REACHED', 'The response limit has been reached. Wait before trying again.');
aliasErrorCodes(['PROVIDER_INTERRUPTED', 'PROVIDER_STREAM_INTERRUPTED', 'EXECUTOR_TIMEOUT'], 'RESPONSE_INTERRUPTED', 'The response was interrupted. Review the saved message or task before trying again.');
aliasErrorCodes(['PROVIDER_TASK_PENDING', 'MODEL_RELAY_UNCERTAIN', 'COMFYUI_SUBMISSION_UNCERTAIN'], 'RESULT_UNCONFIRMED', 'The task result is unconfirmed. Review the saved evidence before another attempt.');
aliasErrorCodes(['PROVIDER_OUTPUT_LIMIT', 'PROVIDER_OUTPUT_TOO_LARGE', 'PROVIDER_REASONING_LIMIT', 'MODEL_RELAY_BUDGET_LIMIT', 'MODEL_RELAY_INPUT_LIMIT', 'MODEL_RELAY_OUTPUT_LIMIT', 'CLI_OUTPUT_LIMIT', 'CLI_RELAY_LIMIT'], 'RESPONSE_TOO_LARGE', 'The response or request exceeds its supported limit. Reduce its size before trying again.');
aliasErrorCodes(['INVALID_PROVIDER_INPUT', 'MODEL_RELAY_INVALID_REQUEST'], 'INVALID_INPUT', 'The request is invalid. Check the supplied fields and try again.');
aliasErrorCodes(['MODEL_RELAY_AUTH_REVOKED'], 'TASK_AUTH_REVOKED', 'This task is no longer authorized to execute. Review its current state before continuing.');
aliasErrorCodes(['COMFYUI_REVIEW_REQUIRED', 'COMFYUI_TEMPLATE_REQUIRED', 'COMFYUI_TEMPLATE_INVALID', 'COMFYUI_TEMPLATE_BINDING_INVALID', 'COMFYUI_TEMPLATE_SNAPSHOT_INVALID', 'COMFYUI_TEMPLATE_UNBOUND', 'INVALID_COMFYUI_TEMPLATE', 'MODEL_RELAY_DUPLICATE'], 'TASK_REVIEW_REQUIRED', 'Review the existing task definition and execution evidence before another attempt.');
aliasErrorCodes(['COMFYUI_TEMPLATE_CHANGED', 'COMFYUI_SERVER_CHANGED', 'COMFYUI_OUTPUT_KIND_MISMATCH', 'MODEL_RELAY_POLICY_CHANGED', 'WORKFLOW_PROVIDER_TASK_CHANGED'], 'TASK_DEFINITION_CHANGED', 'The reviewed task definition changed. Prepare and review a new task.');
aliasErrorCodes(['PROVIDER_FAILED', 'INVALID_PROVIDER_RESPONSE', 'INVALID_PROVIDER_STREAM', 'INVALID_PROVIDER_TASK', 'EMPTY_PROVIDER_RESPONSE', 'PROVIDER_GENERATION_FAILED', 'ELEVENLABS_SPEECH_FAILED', 'LOCAL_SPEECH_FAILED', 'LOCAL_TRANSCRIPTION_FAILED', 'COMFYUI_FAILED', 'COMFYUI_NO_OUTPUT', 'COMFYUI_OUTPUT_INVALID', 'COMFYUI_REJECTED', 'MEDIA_GENERATION_FAILED', 'VIDEO_GENERATION_FAILED', 'MODEL_RELAY_PROVIDER_FAILED', 'MODEL_RELAY_USAGE_INVALID', 'WORKFLOW_REFERENCE_UNAVAILABLE'], 'RESPONSE_FAILED', 'The action did not return a confirmed valid response. Review its saved state before trying again.');

keepErrorCodes(['NOT_ENTITLED'], '这份内容目前不可访问。');
keepErrorCodes(['STALE_REVISION'], '来源版本已变化或撤回。');
keepErrorCodes(['ORG_CONTENT_INPUT_INVALID'], '请使用支持的来源坐标。');
keepErrorCodes(['ORG_CONTENT_STORAGE_UNAVAILABLE'], '内容来源暂时无法核对。');
export function projectPublicError(error: { code: string; message: string; status?: number }): PublicError {
  const mapped = publicErrorCatalogue.get(error.code) ?? { code: 'REQUEST_FAILED', message: 'The request could not be completed. Please try again.' };
  return { code: mapped.code, message: mapped.message, ...(error.status === undefined ? {} : { status: error.status }) };
}
