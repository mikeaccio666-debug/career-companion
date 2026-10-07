-- Internal preparation only: no detector, approved crisis response, room or student release is seeded.
ALTER TABLE platform_onboarding_operations ADD CONSTRAINT platform_onboarding_operation_binding
  UNIQUE (user_id, operation_id, draft_id, applied_revision);

CREATE TABLE platform_onboarding_safety_submissions (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES platform_users(id) ON DELETE CASCADE,
  operation_id uuid NOT NULL,
  draft_id uuid NOT NULL,
  question_id text NOT NULL CHECK (question_id IN ('study','graduation','roles','search_stage','emotion_language','identity_stage','Q1','Q2','Q3','Q4','Q5','Q6','Q7','extra')),
  submitted_revision integer NOT NULL CHECK (submitted_revision BETWEEN 2 AND 2147483647),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','running','detected')),
  generation integer NOT NULL DEFAULT 0 CHECK (generation BETWEEN 0 AND 2147483647),
  auth_version bigint CHECK (auth_version >= 0),
  lease_token uuid,
  lease_until timestamptz,
  execution_token uuid,
  detector_revision integer CHECK (detector_revision BETWEEN 1 AND 2147483647),
  result_ciphertext bytea CHECK (octet_length(result_ciphertext) BETWEEN 29 AND 65565),
  level text CHECK (level IN ('L0','L1','L2')),
  detector_mode text CHECK (detector_mode IN ('full','keyword_only')),
  failure text CHECK (failure IN ('unavailable','timeout','invalid_result')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (user_id, operation_id),
  FOREIGN KEY (user_id,operation_id,draft_id,submitted_revision)
    REFERENCES platform_onboarding_operations(user_id,operation_id,draft_id,applied_revision) ON DELETE CASCADE,
  CHECK ((status='pending' AND lease_token IS NULL AND lease_until IS NULL AND execution_token IS NULL)
    OR (status IN ('running','detected') AND generation>0 AND auth_version IS NOT NULL
      AND lease_token IS NOT NULL AND lease_until IS NOT NULL AND detector_revision IS NOT NULL)),
  CHECK ((status='detected' AND execution_token IS NOT NULL AND result_ciphertext IS NOT NULL AND level IS NOT NULL AND detector_mode IS NOT NULL AND failure IS NULL)
    OR (status<>'detected' AND result_ciphertext IS NULL AND level IS NULL AND detector_mode IS NULL)),
  CHECK (level IS DISTINCT FROM 'L0' OR detector_mode='full')
);
CREATE INDEX platform_onboarding_safety_pending ON platform_onboarding_safety_submissions(user_id,submitted_revision)
  WHERE status<>'detected';
