-- Account changes and mail delivery share authoritative PostgreSQL state.
-- Existing accounts are not silently declared to have verified their email.
ALTER TABLE platform_users ADD COLUMN IF NOT EXISTS auth_version bigint NOT NULL DEFAULT 0 CHECK (auth_version >= 0);
ALTER TABLE platform_users ADD COLUMN IF NOT EXISTS email_verified_at timestamptz;
ALTER TABLE platform_sessions ADD COLUMN IF NOT EXISTS auth_version bigint NOT NULL DEFAULT 0 CHECK (auth_version >= 0);
CREATE INDEX IF NOT EXISTS platform_sessions_owner ON platform_sessions(user_id,auth_version);

CREATE TABLE IF NOT EXISTS platform_account_actions (
  id uuid PRIMARY KEY,
  token_hash text NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  user_id uuid NOT NULL REFERENCES platform_users(id) ON DELETE CASCADE,
  purpose text NOT NULL CHECK (purpose IN ('password-reset','verify-email')),
  auth_version bigint NOT NULL CHECK (auth_version >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  CHECK (expires_at > created_at AND expires_at <= created_at + interval '15 minutes')
);
CREATE INDEX IF NOT EXISTS platform_account_actions_owner ON platform_account_actions(user_id,purpose,expires_at);
CREATE INDEX IF NOT EXISTS platform_account_actions_expiry ON platform_account_actions(expires_at);

-- Only purpose-separated email digests, never addresses, are retained in counters.
CREATE TABLE IF NOT EXISTS platform_account_action_limits (
  target_hash text NOT NULL CHECK (target_hash ~ '^[0-9a-f]{64}$'),
  purpose text NOT NULL CHECK (purpose IN ('password-reset','verify-email')),
  request_count integer NOT NULL CHECK (request_count BETWEEN 1 AND 3),
  expires_at timestamptz NOT NULL,
  PRIMARY KEY (target_hash,purpose)
);
CREATE INDEX IF NOT EXISTS platform_account_action_limits_expiry ON platform_account_action_limits(expires_at);

-- Payloads contain fixed mail bytes encrypted with a separately supplied server key.
-- A sending lease can be reclaimed; its idempotency key and encrypted payload stay fixed.
CREATE TABLE IF NOT EXISTS platform_account_email_outbox (
  id uuid PRIMARY KEY,
  action_id uuid NOT NULL UNIQUE REFERENCES platform_account_actions(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES platform_users(id) ON DELETE CASCADE,
  ciphertext bytea,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sending','sent','expired','revoked','failed')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  lease_token uuid,
  lease_until timestamptz,
  provider_message_id text,
  error_code text CHECK (error_code IS NULL OR error_code IN ('ACCOUNT_EMAIL_SEND_FAILED','ACCOUNT_EMAIL_PAYLOAD_INVALID')),
  finished_at timestamptz,
  CHECK (expires_at > created_at AND expires_at <= created_at + interval '15 minutes'),
  CHECK ((status IN ('pending','sending') AND ciphertext IS NOT NULL) OR (status IN ('sent','expired','revoked','failed') AND ciphertext IS NULL)),
  CHECK ((status='sending' AND lease_token IS NOT NULL AND lease_until IS NOT NULL) OR (status <> 'sending' AND lease_token IS NULL AND lease_until IS NULL))
);
CREATE INDEX IF NOT EXISTS platform_account_email_outbox_available ON platform_account_email_outbox(next_attempt_at,created_at) WHERE status IN ('pending','sending');
CREATE INDEX IF NOT EXISTS platform_account_email_outbox_expiry ON platform_account_email_outbox(expires_at) WHERE status IN ('pending','sending');
CREATE INDEX IF NOT EXISTS platform_account_email_outbox_owner ON platform_account_email_outbox(user_id,status);
