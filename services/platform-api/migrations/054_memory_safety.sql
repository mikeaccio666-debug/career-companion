ALTER TABLE platform_memory_operations ADD CONSTRAINT memory_operation_source_revision UNIQUE(user_id,operation_id,memory_id,applied_revision);
-- Classification sources contain authenticated coordinates/digests, never a
-- second copy of the memory text. No L0, detector policy or model grant is seeded.
CREATE TABLE platform_memory_safety_sources(
 id uuid PRIMARY KEY,user_id uuid NOT NULL REFERENCES platform_users(id) ON DELETE CASCADE,
 memory_id uuid NOT NULL,operation_id uuid NOT NULL,submitted_revision integer NOT NULL CHECK(submitted_revision>0),
 captured_detector_revision integer NOT NULL CHECK(captured_detector_revision>0),source_ciphertext bytea NOT NULL CHECK(octet_length(source_ciphertext)>=29),created_at timestamptz NOT NULL,
 status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','running','detected')),
 generation integer NOT NULL DEFAULT 0 CHECK(generation>=0),auth_version bigint,
 lease_token uuid,lease_until timestamptz,execution_token uuid,detector_revision integer,
 claim_ciphertext bytea,result_ciphertext bytea,level text CHECK(level IN ('L0','L1','L2')),
 detector_mode text CHECK(detector_mode IN ('full','keyword_only')),failure text,
 UNIQUE(user_id,memory_id,submitted_revision,captured_detector_revision),
 FOREIGN KEY(memory_id,user_id) REFERENCES platform_memories(id,user_id) ON DELETE CASCADE,
 FOREIGN KEY(user_id,operation_id,memory_id,submitted_revision) REFERENCES platform_memory_operations(user_id,operation_id,memory_id,applied_revision) ON DELETE CASCADE,
 CHECK((generation=0 AND status='pending' AND auth_version IS NULL AND lease_token IS NULL AND lease_until IS NULL AND claim_ciphertext IS NULL)
  OR(generation>0 AND auth_version IS NOT NULL AND auth_version>=0 AND detector_revision IS NOT NULL AND detector_revision>0 AND claim_ciphertext IS NOT NULL)),
 CHECK(status<>'running' OR(lease_token IS NOT NULL AND lease_until IS NOT NULL)),
 CHECK((status='detected' AND execution_token IS NOT NULL AND level IS NOT NULL AND detector_mode IS NOT NULL AND result_ciphertext IS NOT NULL
   AND (level<>'L0' OR detector_mode='full')) OR(status<>'detected' AND level IS NULL AND detector_mode IS NULL AND result_ciphertext IS NULL)));
CREATE INDEX memory_safety_owner ON platform_memory_safety_sources(user_id,memory_id,submitted_revision);
CREATE OR REPLACE FUNCTION memory_safety_keep_capture() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN
  IF EXISTS(SELECT 1 FROM platform_users WHERE id=OLD.user_id) AND EXISTS(SELECT 1 FROM platform_memories WHERE id=OLD.memory_id AND user_id=OLD.user_id) THEN RAISE EXCEPTION 'memory safety source exists while memory exists' USING ERRCODE='23514'; END IF;
  RETURN OLD;
 END IF;
 IF(NEW.id,NEW.user_id,NEW.memory_id,NEW.operation_id,NEW.submitted_revision,NEW.source_ciphertext,NEW.created_at,NEW.captured_detector_revision)
   IS DISTINCT FROM(OLD.id,OLD.user_id,OLD.memory_id,OLD.operation_id,OLD.submitted_revision,OLD.source_ciphertext,OLD.created_at,OLD.captured_detector_revision) THEN
  RAISE EXCEPTION 'memory safety capture is immutable' USING ERRCODE='23514';
 END IF;
 IF OLD.status='detected' AND NEW IS DISTINCT FROM OLD THEN
  RAISE EXCEPTION 'completed memory classification is immutable' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER memory_safety_capture_immutable BEFORE UPDATE OR DELETE ON platform_memory_safety_sources FOR EACH ROW EXECUTE FUNCTION memory_safety_keep_capture();

ALTER TABLE platform_safety_model_usage ADD COLUMN memory_id uuid,ADD COLUMN memory_execution_token uuid;
ALTER TABLE platform_safety_model_usage DROP CONSTRAINT platform_safety_model_usage_source_kind_check;
ALTER TABLE platform_safety_model_usage ADD CONSTRAINT platform_safety_model_usage_source_kind_check CHECK(source_kind IN ('onboarding','companion_name','shared_memory'));
ALTER TABLE platform_safety_model_usage DROP CONSTRAINT platform_safety_usage_source_shape;
ALTER TABLE platform_safety_model_usage ADD CONSTRAINT platform_safety_usage_source_shape CHECK(
 (source_kind='onboarding' AND submitted_revision>=2 AND draft_id IS NOT NULL AND question_id IS NOT NULL
  AND entry_id IS NULL AND task_id IS NULL AND companion_id IS NULL AND preview_revision IS NULL AND expected_identity_revision IS NULL AND name_execution_token IS NULL AND memory_id IS NULL AND memory_execution_token IS NULL)
 OR(source_kind='companion_name' AND draft_id IS NULL AND question_id IS NULL AND entry_id IS NOT NULL AND task_id IS NOT NULL AND companion_id IS NOT NULL
  AND preview_revision IS NOT NULL AND preview_revision=1 AND expected_identity_revision IS NOT NULL AND expected_identity_revision BETWEEN 0 AND 2147483647 AND name_execution_token IS NOT NULL AND memory_id IS NULL AND memory_execution_token IS NULL)
 OR(source_kind='shared_memory' AND draft_id IS NULL AND question_id IS NULL AND entry_id IS NULL AND task_id IS NULL AND companion_id IS NULL
  AND preview_revision IS NULL AND expected_identity_revision IS NULL AND name_execution_token IS NULL AND memory_id IS NOT NULL AND memory_execution_token IS NOT NULL));
-- Content-free actual expenditure survives forgetting the memory. Its immutable
-- owner operation remains a real source until the account itself is deleted.
ALTER TABLE platform_safety_model_usage ADD CONSTRAINT platform_safety_usage_memory_operation
 FOREIGN KEY(user_id,operation_id,memory_id,submitted_revision) REFERENCES platform_memory_operations(user_id,operation_id,memory_id,applied_revision) ON DELETE CASCADE;

-- Pending actual safety responses are independent of mutable/deleted memory.
-- A future verified followup protocol must acknowledge these; no auto-clear.
CREATE TABLE platform_memory_safety_blocks(
 id uuid PRIMARY KEY,user_id uuid NOT NULL REFERENCES platform_users(id) ON DELETE CASCADE,
 memory_id uuid NOT NULL,operation_id uuid NOT NULL,source_id uuid NOT NULL UNIQUE,
 level text NOT NULL CHECK(level IN ('L1','L2')),detector_mode text NOT NULL CHECK(detector_mode IN ('full','keyword_only')),
 detected_at timestamptz NOT NULL,receipt_ciphertext bytea NOT NULL CHECK(octet_length(receipt_ciphertext)>=29),
 FOREIGN KEY(user_id,operation_id,memory_id) REFERENCES platform_memory_operations(user_id,operation_id,memory_id) ON DELETE CASCADE);
CREATE INDEX memory_safety_blocks_owner ON platform_memory_safety_blocks(user_id);
CREATE TRIGGER memory_safety_block_immutable BEFORE UPDATE OR DELETE ON platform_memory_safety_blocks FOR EACH ROW EXECUTE FUNCTION shared_memory_keep_receipt();
