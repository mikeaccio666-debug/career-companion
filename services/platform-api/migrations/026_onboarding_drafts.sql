-- Unreleased intake preparation. No companion, conversation, memory, consent or completion is issued here.
-- The payload contains private answers and text references; raw text is in encrypted operation input.
CREATE TABLE IF NOT EXISTS platform_onboarding_drafts (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL UNIQUE REFERENCES platform_users(id) ON DELETE CASCADE,
  revision integer NOT NULL CHECK (revision BETWEEN 1 AND 2147483647),
  payload_ciphertext bytea NOT NULL CHECK (octet_length(payload_ciphertext) BETWEEN 29 AND 65565),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (id, user_id)
);

-- Operation inputs are encrypted as well. Retried requests do not overwrite an answer or create a second draft.
CREATE TABLE IF NOT EXISTS platform_onboarding_operations (
  user_id uuid NOT NULL REFERENCES platform_users(id) ON DELETE CASCADE,
  operation_id uuid NOT NULL,
  draft_id uuid NOT NULL,
  applied_revision integer NOT NULL CHECK (applied_revision BETWEEN 1 AND 2147483647),
  request_ciphertext bytea NOT NULL CHECK (octet_length(request_ciphertext) BETWEEN 29 AND 65565),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (user_id, operation_id),
  FOREIGN KEY (draft_id, user_id) REFERENCES platform_onboarding_drafts(id, user_id) ON DELETE CASCADE
);
