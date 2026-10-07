/** These declarations describe the server adapter's input surface, not model quality. */
export interface ChatAttachmentSupport {
  directMimeTypes: string[];
  maxAttachments: number;
  maxTotalBytes: number;
  audioTranscripts: {
    mimeTypes: string[];
    provider: 'faster-whisper';
    model: 'whisper-tiny';
    maxAudioBytes: number;
    maxDurationSeconds: number;
    maxPerMessage: number;
    maxReviewedCharacters: number;
    available: boolean;
    reviewRequired: true;
    reason?: string;
  };
}
export interface CreateAudioTranscriptionInput { clientRequestId: string; }
/** Immutable server ASR result; it verifies neither the speaker nor career evidence. */
export interface AudioTranscriptionReceipt {
  id: string;
  sourceAttachmentId: string;
  sourceName: string;
  sourceMime: string;
  sourceSha256: string;
  provider: 'faster-whisper';
  model: 'whisper-tiny';
  text: string;
  provenance: 'untrusted_audio_transcript';
  createdAt: string;
}
/** An explicit user-selected text snapshot, with edits kept distinct from ASR output. */
export interface AudioTranscriptReference { receiptId: string; reviewedText: string; }
export interface ReviewedAudioTranscript {
  receiptId: string;
  sourceAttachmentId: string;
  sourceName: string;
  sourceMime: string;
  sourceSha256: string;
  provider: 'faster-whisper';
  model: 'whisper-tiny';
  text: string;
  textModified: boolean;
  provenance: 'untrusted_audio_transcript';
}
