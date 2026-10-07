import type { VoiceSessionInput, VoiceSessionResult } from './index.ts';

export const VOICE_CONTEXT_LIMITS = { messages: 20, messageCharacters: 8_000, textBytes: 24 * 1024 } as const;

/** Optional, explicit handoff of an owned legacy conversation; never a client-supplied history. */
export interface VoiceSessionRequest extends VoiceSessionInput { conversationId?: string; }
/** Text only. Files, audio excerpts, saved memories and career-group context are separate surfaces. */
export interface VoiceContextSnapshot {
  source: 'server_conversation';
  conversationId: string;
  items: { messageId: string; role: 'user' | 'assistant'; text: string }[];
  truncated: boolean;
}
export interface VoiceSessionResponse extends VoiceSessionResult { sessionId: string; serverContext?: VoiceContextSnapshot; }
