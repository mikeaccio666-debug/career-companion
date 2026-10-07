import type {
  AccountUsage, Attachment, AudioTranscriptionReceipt, Capability, ChatAttachmentSupport,
  Message, PlatformFeatures, PublicAccountUsage, PublicAudioTranscriptionReceipt,
  PublicCapabilities, PublicChatAttachmentSupport, PublicMessage, PublicReviewedAudioTranscript,
  PublicVoiceRecord, PublicVoiceSessionResponse, ReviewedAudioTranscript, VoiceRecord,
  VoiceSessionResponse,
} from '@companion/platform-contracts';

/** Pure DTO preparation only. HTTP/SSE adapters must opt in during their coordinated switch. */
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
