-- No profile, active direction, proposal, classification or agent source is seeded.
CREATE TABLE platform_career_targets (
 id uuid PRIMARY KEY,user_id uuid NOT NULL REFERENCES platform_users(id) ON DELETE CASCADE,
 role_family text NOT NULL CHECK(role_family IN ('swe','mle','ds','da','de','hw','other')),
 priority integer NOT NULL CHECK(priority BETWEEN 1 AND 100),
 status text NOT NULL CHECK(status IN ('exploring','proposed','active','paused','dropped')),
 proposed_by text,revision integer NOT NULL CHECK(revision>0),last_operation_id uuid NOT NULL,
 record_ciphertext bytea NOT NULL CHECK(octet_length(record_ciphertext)>=29),
 created_at timestamptz NOT NULL,updated_at timestamptz NOT NULL CHECK(updated_at>=created_at),UNIQUE(id,user_id));
CREATE INDEX career_targets_owner ON platform_career_targets(user_id,priority,created_at,id);
-- Receipts contain only an encrypted command digest and coordinates. They survive
-- physical target removal, so a late create replay cannot resurrect forgotten text.
CREATE TABLE platform_career_target_operations (
 user_id uuid NOT NULL REFERENCES platform_users(id) ON DELETE CASCADE,operation_id uuid NOT NULL,
 target_id uuid NOT NULL,action text NOT NULL CHECK(action IN ('create','edit','status','delete')),
 applied_revision integer NOT NULL CHECK(applied_revision>0),created_at timestamptz NOT NULL,
 receipt_ciphertext bytea NOT NULL CHECK(octet_length(receipt_ciphertext)>=29),
 PRIMARY KEY(user_id,operation_id),UNIQUE(user_id,target_id,applied_revision),
 UNIQUE(user_id,operation_id,target_id,applied_revision));
ALTER TABLE platform_career_targets ADD CONSTRAINT career_targets_real_operation
 FOREIGN KEY(user_id,last_operation_id,id,revision) REFERENCES platform_career_target_operations(user_id,operation_id,target_id,applied_revision);
CREATE TRIGGER career_target_operation_immutable BEFORE UPDATE OR DELETE ON platform_career_target_operations
 FOR EACH ROW EXECUTE FUNCTION shared_memory_keep_receipt();
