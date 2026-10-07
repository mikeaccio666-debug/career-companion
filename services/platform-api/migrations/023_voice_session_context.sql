ALTER TABLE platform_voice_sessions
  ADD COLUMN IF NOT EXISTS conversation_id uuid REFERENCES platform_conversations(id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS platform_voice_sessions_conversation ON platform_voice_sessions(conversation_id)
  WHERE conversation_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS platform_messages_voice_context ON platform_messages(conversation_id,ordinal DESC)
  WHERE status='complete' AND role IN ('user','assistant')
    AND attachments='[]'::jsonb AND audio_transcripts='[]'::jsonb;
