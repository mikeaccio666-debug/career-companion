-- The real user's accepted intake intent, original session and source are one
-- authenticated private snapshot. Queue messages contain only these row IDs.
CREATE TABLE platform_companion_generation_requests (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES platform_users(id) ON DELETE CASCADE,
  task_id uuid NOT NULL UNIQUE,
  companion_id uuid NOT NULL,
  source_draft_id uuid NOT NULL,
  source_revision integer NOT NULL CHECK (source_revision BETWEEN 1 AND 2147483647),
  auth_version bigint NOT NULL CHECK (auth_version >= 0),
  initial_generation integer NOT NULL DEFAULT 0 CHECK (initial_generation = 0),
  payload_digest text NOT NULL CHECK (payload_digest ~ '^[0-9a-f]{64}$'),
  payload_ciphertext bytea NOT NULL CHECK (octet_length(payload_ciphertext) BETWEEN 29 AND 65565),
  accepted_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(id,user_id,task_id),
  FOREIGN KEY(task_id,user_id,companion_id)
    REFERENCES platform_companion_generation_tasks(id,user_id,companion_id) ON DELETE CASCADE,
  FOREIGN KEY(source_draft_id,user_id)
    REFERENCES platform_onboarding_drafts(id,user_id) ON DELETE CASCADE
);
CREATE TABLE platform_companion_generation_outbox (
  request_id uuid PRIMARY KEY,
  user_id uuid NOT NULL,
  task_id uuid NOT NULL,
  dispatched_at timestamptz,
  held_reason text CHECK (held_reason IN ('authorization','configuration','source_changed','storage','terminal')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY(request_id,user_id,task_id)
    REFERENCES platform_companion_generation_requests(id,user_id,task_id) ON DELETE CASCADE
);
CREATE INDEX platform_companion_generation_outbox_dispatch
  ON platform_companion_generation_outbox(dispatched_at,request_id);
COMMENT ON TABLE platform_companion_generation_requests IS
  'Immutable accepted intent. Encrypted original session hash is private; neither a queue message nor a later session renews its execution authority.';
