-- First original-draft execution. Preparation remains immutable; no publication.
-- Defer the money FK until COMMIT, matching migration 078: account erasure
-- aggregates costs before its ownership cascade deletes execution records.
CREATE TABLE platform_first_letter_stages (
 id uuid PRIMARY KEY,
 task_id uuid NOT NULL, user_id uuid NOT NULL,
 stage text NOT NULL CHECK(stage='write_original'),
 provider text NOT NULL, model text NOT NULL, auth_version bigint NOT NULL,
 status text NOT NULL CHECK(status IN ('running','draft_saved','invalid_format','failed','uncertain')),
 lease_token uuid, runtime_lease_id uuid, lease_until timestamptz,
 start_ciphertext bytea NOT NULL CHECK(octet_length(start_ciphertext) BETWEEN 29 AND 65565),
 call_id uuid UNIQUE, reservation_id uuid UNIQUE REFERENCES platform_cost_reservations(id) DEFERRABLE INITIALLY DEFERRED,
 call_status text CHECK(call_status IN ('prepared','admitted','complete','failed','cancelled','interrupted')),
 admitted_at timestamptz, call_finished_at timestamptz,
 receipt_ciphertext bytea CHECK(octet_length(receipt_ciphertext) BETWEEN 29 AND 65565),
 output_ciphertext bytea CHECK(octet_length(output_ciphertext) BETWEEN 29 AND 65565),
 created_at timestamptz NOT NULL, finished_at timestamptz,
 UNIQUE(task_id,stage),UNIQUE(id,user_id),
 FOREIGN KEY(task_id,user_id) REFERENCES platform_first_letter_tasks(id,user_id) ON DELETE CASCADE,
 CHECK((status='running' AND lease_token IS NOT NULL AND runtime_lease_id IS NOT NULL AND lease_until IS NOT NULL AND finished_at IS NULL)
  OR(status<>'running' AND lease_token IS NULL AND runtime_lease_id IS NULL AND lease_until IS NULL AND finished_at IS NOT NULL)),
 CHECK((call_id IS NULL AND reservation_id IS NULL AND call_status IS NULL AND admitted_at IS NULL AND call_finished_at IS NULL AND receipt_ciphertext IS NULL)
  OR(call_id IS NOT NULL AND reservation_id IS NOT NULL AND call_status IS NOT NULL AND
   ((call_status='prepared' AND admitted_at IS NULL AND call_finished_at IS NULL AND receipt_ciphertext IS NULL)
    OR(call_status='admitted' AND admitted_at IS NOT NULL AND call_finished_at IS NULL AND receipt_ciphertext IS NULL)
    OR(call_status IN ('complete','failed','cancelled','interrupted') AND call_finished_at IS NOT NULL AND receipt_ciphertext IS NOT NULL
      AND(call_status<>'complete' OR admitted_at IS NOT NULL))))),
 CHECK((status='draft_saved' AND call_status='complete' AND output_ciphertext IS NOT NULL) OR(status<>'draft_saved' AND output_ciphertext IS NULL)),
 CHECK(status<>'invalid_format' OR(call_status='failed' AND admitted_at IS NOT NULL))
);
