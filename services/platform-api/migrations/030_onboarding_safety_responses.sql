-- Initial-meeting fixed-response preparation, not a publication/seen/question receipt.
-- No template, contact, retention policy, reviewer or activation is seeded.
CREATE TABLE platform_safety_response_policy (
  singleton boolean PRIMARY KEY CHECK (singleton),
  revision integer NOT NULL CHECK (revision BETWEEN 1 AND 2147483647),
  content_digest text NOT NULL CHECK (content_digest ~ '^[0-9a-f]{64}$'),
  review_digest text NOT NULL CHECK (review_digest ~ '^[0-9a-f]{64}$'),
  activated_at timestamptz NOT NULL,
  activated_by uuid NOT NULL REFERENCES platform_users(id) ON DELETE RESTRICT
);
CREATE TABLE platform_onboarding_safety_responses (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES platform_users(id) ON DELETE CASCADE,
  submission_id uuid NOT NULL UNIQUE,
  operation_id uuid NOT NULL,
  draft_id uuid NOT NULL,
  question_id text NOT NULL,
  submitted_revision integer NOT NULL CHECK (submitted_revision BETWEEN 2 AND 2147483647),
  source_generation integer NOT NULL CHECK (source_generation BETWEEN 1 AND 2147483647),
  detector_revision integer NOT NULL CHECK (detector_revision BETWEEN 1 AND 2147483647),
  level text NOT NULL CHECK (level IN ('L1','L2')),
  detector_mode text NOT NULL CHECK (detector_mode IN ('full','keyword_only')),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','ready')),
  payload_ciphertext bytea CHECK (octet_length(payload_ciphertext) BETWEEN 29 AND 65565),
  bundle_revision integer CHECK (bundle_revision BETWEEN 1 AND 2147483647),
  content_digest text CHECK (content_digest ~ '^[0-9a-f]{64}$'),
  review_digest text CHECK (review_digest ~ '^[0-9a-f]{64}$'),
  locale text CHECK (locale IN ('zh','en')),
  prepared_at timestamptz,
  retention_until timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(id,user_id,submission_id),
  FOREIGN KEY(submission_id,user_id,operation_id,draft_id,question_id,submitted_revision)
    REFERENCES platform_onboarding_safety_submissions(id,user_id,operation_id,draft_id,question_id,submitted_revision) ON DELETE CASCADE,
  CHECK ((status='pending' AND payload_ciphertext IS NULL AND bundle_revision IS NULL AND content_digest IS NULL
      AND review_digest IS NULL AND locale IS NULL AND prepared_at IS NULL AND retention_until IS NULL)
    OR (status='ready' AND payload_ciphertext IS NOT NULL AND bundle_revision IS NOT NULL AND content_digest IS NOT NULL
      AND review_digest IS NOT NULL AND locale IS NOT NULL AND prepared_at IS NOT NULL AND retention_until IS NOT NULL AND retention_until>prepared_at))
);
CREATE INDEX platform_onboarding_safety_response_pending ON platform_onboarding_safety_responses(level,created_at) WHERE status='pending';
-- Only actual onboarding references exist here. Main rooms/messages are added by their owning future migration.
CREATE TABLE platform_safety_events (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES platform_users(id) ON DELETE CASCADE,
  source_kind text NOT NULL CHECK (source_kind='onboarding'),
  submission_id uuid NOT NULL,
  response_id uuid NOT NULL UNIQUE,
  event_kind text NOT NULL CHECK (event_kind='response_prepared'),
  level text NOT NULL CHECK (level IN ('L1','L2')),
  detector_revision integer NOT NULL CHECK (detector_revision BETWEEN 1 AND 2147483647),
  detector_mode text NOT NULL CHECK (detector_mode IN ('full','keyword_only')),
  created_at timestamptz NOT NULL,
  retention_until timestamptz NOT NULL CHECK (retention_until>created_at),
  FOREIGN KEY(response_id,user_id,submission_id) REFERENCES platform_onboarding_safety_responses(id,user_id,submission_id) ON DELETE CASCADE
);
