-- Internal background preview generation. No student route, birth, clinical
-- approval, prices or budget defaults are introduced here.
ALTER TABLE platform_runtime_leases DROP CONSTRAINT platform_runtime_leases_kind_check;
ALTER TABLE platform_runtime_leases ADD CONSTRAINT platform_runtime_leases_kind_check CHECK (kind IN ('chat','voice','background'));
ALTER TABLE platform_companions DROP CONSTRAINT platform_companions_status_check;
ALTER TABLE platform_companions DROP CONSTRAINT platform_companions_current_revision_check;
ALTER TABLE platform_companions ADD CONSTRAINT platform_companions_status_check CHECK (status IN ('drafting','awaiting_name'));
ALTER TABLE platform_companions ADD CONSTRAINT platform_companions_current_revision_check
  CHECK ((status='drafting' AND current_revision=0) OR (status='awaiting_name' AND current_revision=1));
ALTER TABLE platform_companion_generation_tasks DROP CONSTRAINT platform_companion_generation_tasks_status_check;
ALTER TABLE platform_companion_generation_tasks ADD CONSTRAINT platform_companion_generation_tasks_status_check
  CHECK (status IN ('pending','running','completed','failed'));
ALTER TABLE platform_companion_generation_tasks ADD COLUMN generation integer NOT NULL DEFAULT 0 CHECK (generation BETWEEN 0 AND 2147483647);
ALTER TABLE platform_companion_generation_tasks ADD COLUMN lease_token uuid;
ALTER TABLE platform_companion_generation_tasks ADD COLUMN lease_until timestamptz;
ALTER TABLE platform_companion_generation_tasks ADD COLUMN runtime_lease_id uuid;
ALTER TABLE platform_companion_generation_tasks ADD COLUMN finished_at timestamptz;
ALTER TABLE platform_companion_generation_tasks ADD UNIQUE(id,user_id,companion_id);
ALTER TABLE platform_companion_generation_tasks ADD CONSTRAINT platform_companion_generation_claim_state
  CHECK ((status='pending' AND generation=0 AND lease_token IS NULL AND lease_until IS NULL AND runtime_lease_id IS NULL AND finished_at IS NULL)
    OR (status='running' AND generation>0 AND lease_token IS NOT NULL AND lease_until IS NOT NULL AND runtime_lease_id IS NOT NULL AND finished_at IS NULL)
    OR (status IN ('completed','failed') AND generation>0 AND lease_token IS NULL AND lease_until IS NULL AND runtime_lease_id IS NULL AND finished_at IS NOT NULL));

CREATE TABLE platform_companion_generation_calls (
  call_id uuid PRIMARY KEY, task_id uuid NOT NULL, user_id uuid NOT NULL, companion_id uuid NOT NULL,
  generation integer NOT NULL CHECK (generation>0), attempt integer NOT NULL CHECK (attempt BETWEEN 1 AND 3),
  provider text NOT NULL, model text NOT NULL, purpose text NOT NULL CHECK (purpose='companion_generation'),
  reservation_id uuid NOT NULL UNIQUE REFERENCES platform_cost_reservations(id),
  status text NOT NULL CHECK (status IN ('prepared','admitted','complete','failed','cancelled','interrupted')),
  usage_status text NOT NULL CHECK (usage_status IN ('pending','reported','missing','invalid')),
  input_tokens integer CHECK (input_tokens BETWEEN 0 AND 2147483647), output_tokens integer CHECK (output_tokens BETWEEN 0 AND 2147483647),
  validation_status text CHECK (validation_status IN ('passed_rules','blocked','requires_review','invalid_format','timed_out')),
  admitted_at timestamptz, finished_at timestamptz, created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(task_id,generation,attempt),
  FOREIGN KEY(task_id,user_id,companion_id) REFERENCES platform_companion_generation_tasks(id,user_id,companion_id) ON DELETE CASCADE,
  CHECK ((usage_status='reported' AND input_tokens IS NOT NULL AND output_tokens IS NOT NULL)
    OR (usage_status<>'reported' AND input_tokens IS NULL AND output_tokens IS NULL)),
  CHECK ((status='prepared' AND admitted_at IS NULL AND finished_at IS NULL AND usage_status='pending')
    OR (status='admitted' AND admitted_at IS NOT NULL AND finished_at IS NULL AND usage_status='pending')
    OR (status IN ('complete','failed','cancelled','interrupted') AND finished_at IS NOT NULL AND usage_status<>'pending'
      AND (status<>'complete' OR admitted_at IS NOT NULL)))
);
CREATE TABLE platform_companion_output_blocks (
  call_id uuid PRIMARY KEY REFERENCES platform_companion_generation_calls(call_id) ON DELETE CASCADE,
  rules text[] NOT NULL CHECK (cardinality(rules) BETWEEN 1 AND 32),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
-- Private text and full source bindings are authenticated together. No clear
-- summaries, samples, source answers or rejected output are kept in logs/tables.
CREATE TABLE platform_companion_revisions (
  companion_id uuid NOT NULL, user_id uuid NOT NULL, revision integer NOT NULL CHECK (revision=1),
  task_id uuid NOT NULL UNIQUE, generation integer NOT NULL CHECK (generation>0),
  generated_by text NOT NULL CHECK (generated_by IN ('model','fallback')),
  payload_ciphertext bytea NOT NULL CHECK (octet_length(payload_ciphertext) BETWEEN 29 AND 65565),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(), PRIMARY KEY(companion_id,revision),
  FOREIGN KEY(task_id,user_id,companion_id) REFERENCES platform_companion_generation_tasks(id,user_id,companion_id) ON DELETE CASCADE,
  FOREIGN KEY(companion_id,user_id) REFERENCES platform_companions(id,user_id) ON DELETE CASCADE
);
