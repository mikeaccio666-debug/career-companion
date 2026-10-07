import type { Capability, Message, VoiceRecord } from './index.ts';
import type { VoiceContextSnapshot } from './voice-context.ts';

/** Deployment features do not assert a staff role, consent or execution authorization. */
export interface PlatformFeatures {
  version: 1;
  workbench: boolean;
  providerDetails: boolean;
}

/** Genuine capability availability, separate from the internal provider catalogue. */
export interface PublicCapabilities {
  capabilities: Record<Capability, boolean>;
  chatAttachments?: PublicChatAttachmentSupport;
}

/** Input limits without local ASR configuration or model identifiers. */
export interface PublicChatAttachmentSupport {
  directMimeTypes: string[];
  maxAttachments: number;
  maxTotalBytes: number;
  audioTranscripts: {
    mimeTypes: string[];
    maxAudioBytes: number;
    maxDurationSeconds: number;
    maxPerMessage: number;
    maxReviewedCharacters: number;
    available: boolean;
    reviewRequired: true;
  };
}

/** Immutable ASR output keeps source evidence; it does not verify the speaker. */
export interface PublicAudioTranscriptionReceipt {
  id: string;
  sourceAttachmentId: string;
  sourceName: string;
  sourceMime: string;
  sourceSha256: string;
  text: string;
  provenance: 'untrusted_audio_transcript';
  createdAt: string;
}

/** User-selected text remains distinct from the immutable ASR output. */
export interface PublicReviewedAudioTranscript {
  receiptId: string;
  sourceAttachmentId: string;
  sourceName: string;
  sourceMime: string;
  sourceSha256: string;
  text: string;
  textModified: boolean;
  provenance: 'untrusted_audio_transcript';
}

export interface PublicMessage {
  id: string;
  conversationId: string;
  role: Message['role'];
  content: string;
  status: Message['status'];
  createdAt: string;
  attachments?: Message['attachments'];
  audioTranscripts?: PublicReviewedAudioTranscript[];
}

export interface PublicVoiceRecord {
  id: string;
  conversationId: string;
  clientRecordId: string;
  source: VoiceRecord['source'];
  role: VoiceRecord['role'];
  text: string;
  provenance: 'client_submitted';
  sessionId?: string;
  attachments: VoiceRecord['attachments'];
  createdAt: string;
}

/** Direct WebRTC needs its actual endpoint and temporary credential. These are
 * transport fields, not a promise that browser network traffic hides its vendor. */
export interface PublicVoiceSessionResponse {
  clientSecret: string;
  endpoint: string;
  expiresAt?: number;
  inputTranscriptionEnabled?: boolean;
  sessionId: string;
  serverContext?: VoiceContextSnapshot;
}

/** Actual aggregate usage, without the internal provider/model breakdown. */
export interface PublicAccountUsage {
  period: { from: string; to: string; timeZone: 'UTC' };
  chat: {
    calls: number;
    reportedCalls: number;
    missingCalls: number;
    invalidCalls: number;
    pendingCalls: number;
    inputTokens: number | null;
    outputTokens: number | null;
    coverage: 'none' | 'partial' | 'complete';
    outcomes: { complete: number; failed: number; cancelled: number; interrupted: number; running: number };
    legacyReports: number;
  };
}
