-- Recovery belongs to the original accepted generation. Queue delivery and a
-- replacement lease are not new model admission, persona rerolls or authority.
ALTER TABLE platform_companion_generation_tasks DROP CONSTRAINT platform_companion_generation_tasks_status_check;
ALTER TABLE platform_companion_generation_tasks ADD CONSTRAINT platform_companion_generation_tasks_status_check
  CHECK (status IN ('pending','running','completed','failed','uncertain','interrupted'));
ALTER TABLE platform_companion_generation_tasks DROP CONSTRAINT platform_companion_generation_claim_state;
ALTER TABLE platform_companion_generation_tasks ADD CONSTRAINT platform_companion_generation_claim_state
  CHECK ((status='pending' AND generation=0 AND lease_token IS NULL AND lease_until IS NULL AND runtime_lease_id IS NULL AND finished_at IS NULL)
    OR (status='running' AND generation>0 AND lease_token IS NOT NULL AND lease_until IS NOT NULL AND runtime_lease_id IS NOT NULL AND finished_at IS NULL)
    OR (status IN ('completed','failed','uncertain','interrupted') AND generation>0
      AND lease_token IS NULL AND lease_until IS NULL AND runtime_lease_id IS NULL AND finished_at IS NOT NULL));
ALTER TABLE platform_companion_generation_tasks ADD COLUMN error_code text
  CHECK (error_code IN ('COMPANION_GENERATION_UNAVAILABLE','COMPANION_GENERATION_CANCELLED',
    'COMPANION_GENERATION_BUDGET_UNAVAILABLE','MODEL_ROUTE_UNAVAILABLE','COMPANION_DRAFT_SOURCE_CHANGED',
    'COMPANION_GENERATION_UNCERTAIN','COMPANION_GENERATION_INTERRUPTED'));
ALTER TABLE platform_companion_generation_tasks ADD CONSTRAINT platform_companion_generation_error_state
  CHECK (status NOT IN ('pending','running','completed') OR error_code IS NULL);
CREATE INDEX platform_companion_generation_expired ON platform_companion_generation_tasks(lease_until,id)
  WHERE status='running';

-- Only a preview which passed deterministic validation is retained here.
-- The encrypted canonical body authenticates its immutable source, actual call
-- and settled money receipts. The digest is checked after authenticated decrypt.
-- Rejected output and provider prompts are never persisted.
CREATE TABLE platform_companion_generation_checkpoints (
  task_id uuid NOT NULL, user_id uuid NOT NULL, companion_id uuid NOT NULL,
  generation integer NOT NULL CHECK (generation>0),
  source_draft_id uuid NOT NULL, source_revision integer NOT NULL CHECK (source_revision>=0),
  call_ids uuid[] NOT NULL CHECK (cardinality(call_ids) BETWEEN 1 AND 3),
  policy_revision integer NOT NULL CHECK (policy_revision=1),
  payload_digest text NOT NULL CHECK (payload_digest ~ '^[0-9a-f]{64}$'),
  payload_ciphertext bytea NOT NULL CHECK (octet_length(payload_ciphertext) BETWEEN 29 AND 65565),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(), PRIMARY KEY(task_id,generation),
  FOREIGN KEY(task_id,user_id,companion_id)
    REFERENCES platform_companion_generation_tasks(id,user_id,companion_id) ON DELETE CASCADE
);
COMMENT ON TABLE platform_companion_generation_checkpoints IS
  'Private validated preview checkpoint. A read or replacement lease is not execution admission or publication permission.';
