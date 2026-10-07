-- No approved policy, invitation or consent is seeded by this migration.
CREATE TABLE IF NOT EXISTS platform_terms_policy (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  terms_version text NOT NULL CHECK (length(terms_version) BETWEEN 1 AND 100),
  content_digest text NOT NULL CHECK (content_digest ~ '^[0-9a-f]{64}$'),
  review_digest text NOT NULL CHECK (review_digest ~ '^[0-9a-f]{64}$'),
  activated_at timestamptz NOT NULL,
  activated_by uuid REFERENCES platform_users(id) ON DELETE SET NULL
);
CREATE TABLE IF NOT EXISTS platform_invites (
  code_hash text PRIMARY KEY CHECK (code_hash ~ '^[0-9a-f]{64}$'),
  email_digest text NOT NULL CHECK (email_digest ~ '^[0-9a-f]{64}$'),
  batch text NOT NULL CHECK (batch IN ('B0','B1','B2','B3')),
  invited_by uuid REFERENCES platform_users(id) ON DELETE SET NULL,
  expires_at timestamptz NOT NULL,
  redeemed_at timestamptz,
  redeemed_user_id uuid REFERENCES platform_users(id) ON DELETE SET NULL,
  CHECK (redeemed_at IS NOT NULL OR redeemed_user_id IS NULL)
);
CREATE TABLE IF NOT EXISTS platform_terms_consents (
  user_id uuid NOT NULL REFERENCES platform_users(id) ON DELETE CASCADE,
  terms_version text NOT NULL CHECK (length(terms_version) BETWEEN 1 AND 100),
  content_digest text NOT NULL CHECK (content_digest ~ '^[0-9a-f]{64}$'),
  consented_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(user_id, terms_version, content_digest)
);
