CREATE TABLE IF NOT EXISTS platform_voice_sessions (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES platform_users(id) ON DELETE CASCADE,
  provider text NOT NULL,
  model text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  save_until timestamptz NOT NULL,
  released_at timestamptz
);
CREATE INDEX IF NOT EXISTS platform_voice_sessions_owner ON platform_voice_sessions(user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS platform_voice_records (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES platform_users(id) ON DELETE CASCADE,
  conversation_id uuid NOT NULL REFERENCES platform_conversations(id) ON DELETE CASCADE,
  client_record_id uuid NOT NULL,
  source text NOT NULL CHECK (source IN ('realtime_transcript','transcription_excerpt','speech_excerpt')),
  role text NOT NULL CHECK (role IN ('user','assistant','unknown')),
  provenance text NOT NULL DEFAULT 'client_submitted' CHECK (provenance='client_submitted'),
  content text NOT NULL,
  content_bytes integer NOT NULL CHECK (content_bytes BETWEEN 1 AND 32768),
  session_id uuid REFERENCES platform_voice_sessions(id),
  provider text,
  model text,
  attachment_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  request_hash text NOT NULL,
  ordinal bigserial NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, client_record_id),
  CHECK ((source='realtime_transcript' AND session_id IS NOT NULL) OR source<>'realtime_transcript')
);
CREATE INDEX IF NOT EXISTS platform_voice_records_conversation ON platform_voice_records(conversation_id, ordinal);
CREATE INDEX IF NOT EXISTS platform_voice_records_owner ON platform_voice_records(user_id);
