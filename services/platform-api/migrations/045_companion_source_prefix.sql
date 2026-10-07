-- Prospective source completeness only. Legacy tasks remain NULL and receive no
-- invented receipt. Deleting source operations cannot cascade this independent
-- encrypted manifest; ordinary account/task deletion still removes private data.
ALTER TABLE platform_companion_generation_tasks ADD COLUMN IF NOT EXISTS source_receipt_version integer
  CHECK (source_receipt_version IS NULL OR source_receipt_version=1);

CREATE TABLE IF NOT EXISTS platform_companion_source_prefixes (
  id uuid PRIMARY KEY,
  task_id uuid NOT NULL UNIQUE,
  user_id uuid NOT NULL REFERENCES platform_users(id) ON DELETE CASCADE,
  companion_id uuid NOT NULL,
  answers_id uuid NOT NULL,
  source_draft_id uuid NOT NULL,
  source_revision integer NOT NULL CHECK (source_revision BETWEEN 1 AND 2147483647),
  auth_version bigint NOT NULL CHECK (auth_version >= 0),
  questionnaire_revision integer NOT NULL CHECK (questionnaire_revision=1),
  rules_revision integer NOT NULL CHECK (rules_revision=1),
  generator_version integer NOT NULL CHECK (generator_version=1),
  purpose text NOT NULL CHECK (purpose='companion_preview'),
  schema_version integer NOT NULL CHECK (schema_version=1),
  captured_at timestamptz NOT NULL,
  payload_digest text NOT NULL CHECK (payload_digest ~ '^[0-9a-f]{64}$'),
  payload_ciphertext bytea NOT NULL CHECK (octet_length(payload_ciphertext) BETWEEN 29 AND 65565),
  CHECK (id=task_id),
  FOREIGN KEY (task_id,user_id,companion_id)
    REFERENCES platform_companion_generation_tasks(id,user_id,companion_id) ON DELETE CASCADE,
  FOREIGN KEY (answers_id,user_id,source_draft_id,source_revision)
    REFERENCES platform_companion_answers(id,user_id,source_draft_id,source_revision) ON DELETE CASCADE
);
COMMENT ON TABLE platform_companion_source_prefixes IS
  'First genuine preparation captures the authenticated original record set. Reads and legacy replay never INSERT, repair, backfill or create authorization.';
