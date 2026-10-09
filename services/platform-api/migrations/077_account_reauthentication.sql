-- Password proofs do not authorize a model, application, or external action.
ALTER TABLE platform_sessions ADD CONSTRAINT platform_sessions_owner_token UNIQUE(token_hash,user_id);
CREATE TABLE platform_account_reauthentications (
  user_id uuid NOT NULL REFERENCES platform_users(id) ON DELETE CASCADE,
  session_hash text NOT NULL,
  purpose text NOT NULL CHECK(purpose IN ('account_export','account_delete')),
  proof_hash text NOT NULL UNIQUE CHECK(proof_hash ~ '^[0-9a-f]{64}$'),
  auth_version bigint NOT NULL CHECK(auth_version>=0),
  verified_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  PRIMARY KEY(user_id,session_hash,purpose),
  FOREIGN KEY(session_hash,user_id) REFERENCES platform_sessions(token_hash,user_id) ON DELETE CASCADE,
  CHECK(expires_at>verified_at AND expires_at<=verified_at+interval '5 minutes'),
  CHECK(consumed_at IS NULL OR consumed_at>=verified_at)
);
ALTER TABLE platform_request_limits DROP CONSTRAINT IF EXISTS platform_request_limits_scope_check;
ALTER TABLE platform_request_limits DROP CONSTRAINT IF EXISTS platform_request_limits_check;
ALTER TABLE platform_request_limits ADD CONSTRAINT platform_request_limits_scope_check
  CHECK(scope IN ('api','chat','speech','transcription','realtime','control','org-knowledge','account-reauth','auth-login','auth-register','auth-email-request','auth-email-consume','public'));
ALTER TABLE platform_request_limits ADD CONSTRAINT platform_request_limits_check
  CHECK ((subject_type='user' AND subject_key ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      AND scope IN ('api','chat','speech','transcription','realtime','control','org-knowledge','account-reauth'))
    OR (subject_type='ip' AND subject_key ~ '^[0-9a-f]{64}$'
      AND scope IN ('auth-login','auth-register','auth-email-request','auth-email-consume','public')));
