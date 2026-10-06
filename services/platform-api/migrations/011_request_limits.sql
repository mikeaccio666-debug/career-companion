-- Shared request windows contain verified user ids or socket-IP digests only.
CREATE TABLE IF NOT EXISTS platform_request_limits (
  subject_type text NOT NULL CHECK(subject_type IN ('user','ip')),
  subject_key text NOT NULL,
  scope text NOT NULL CHECK(scope IN ('api','chat','speech','transcription','realtime','control','auth-login','auth-register','public')),
  request_count integer NOT NULL CHECK(request_count > 0),
  expires_at timestamptz NOT NULL,
  PRIMARY KEY(subject_type,subject_key,scope),
  CHECK ((subject_type='user' AND subject_key ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      AND scope IN ('api','chat','speech','transcription','realtime','control'))
    OR (subject_type='ip' AND subject_key ~ '^[0-9a-f]{64}$' AND scope IN ('auth-login','auth-register','public')))
);
CREATE INDEX IF NOT EXISTS platform_request_limits_expiry ON platform_request_limits(expires_at,subject_type,subject_key,scope);
