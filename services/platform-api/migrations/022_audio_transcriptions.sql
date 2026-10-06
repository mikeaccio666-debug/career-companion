CREATE TABLE IF NOT EXISTS platform_audio_transcriptions (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES platform_users(id) ON DELETE CASCADE,
  client_request_id uuid NOT NULL,
  source_upload_id uuid NOT NULL REFERENCES platform_uploads(id) ON DELETE CASCADE,
  source_sha256 text NOT NULL CHECK (source_sha256 ~ '^[0-9a-f]{64}$'),
  source_name text NOT NULL,
  source_mime text NOT NULL,
  source_size integer NOT NULL CHECK (source_size BETWEEN 1 AND 20971520),
  provider text NOT NULL CHECK (provider='faster-whisper'),
  model text NOT NULL CHECK (model='whisper-tiny'),
  content text NOT NULL,
  content_bytes integer NOT NULL CHECK (content_bytes BETWEEN 0 AND 65536),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (user_id,client_request_id)
);
CREATE INDEX IF NOT EXISTS platform_audio_transcriptions_owner ON platform_audio_transcriptions(user_id,created_at DESC);
ALTER TABLE platform_messages ADD COLUMN IF NOT EXISTS audio_transcripts jsonb NOT NULL DEFAULT '[]'::jsonb;
CREATE OR REPLACE FUNCTION platform_immutable_audio_transcription() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Audio transcription receipts are immutable';
END;
$$;
DROP TRIGGER IF EXISTS platform_audio_transcription_immutable ON platform_audio_transcriptions;
CREATE TRIGGER platform_audio_transcription_immutable BEFORE UPDATE ON platform_audio_transcriptions
FOR EACH ROW EXECUTE FUNCTION platform_immutable_audio_transcription();
