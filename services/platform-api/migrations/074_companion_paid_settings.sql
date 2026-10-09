-- Product default, not a backfilled owner choice. Personality/birth revisions are unaffected.
ALTER TABLE platform_companions ADD COLUMN IF NOT EXISTS paid_suggestions_mode text NOT NULL DEFAULT 'when_relevant' CHECK(paid_suggestions_mode IN ('when_relevant','only_when_asked'));
ALTER TABLE platform_companions ADD COLUMN IF NOT EXISTS paid_suggestions_revision integer NOT NULL DEFAULT 0 CHECK(paid_suggestions_revision>=0);
ALTER TABLE platform_companions ADD COLUMN IF NOT EXISTS paid_suggestions_ciphertext bytea;
ALTER TABLE platform_companions ADD COLUMN IF NOT EXISTS paid_suggestions_updated_at timestamptz;
ALTER TABLE platform_companions ADD COLUMN IF NOT EXISTS paid_suggestions_operation_id uuid;
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='platform_companions'::regclass AND conname='companion_paid_settings_shape') THEN
 ALTER TABLE platform_companions ADD CONSTRAINT companion_paid_settings_shape CHECK(
  (paid_suggestions_revision=0 AND paid_suggestions_mode='when_relevant' AND paid_suggestions_ciphertext IS NULL AND paid_suggestions_updated_at IS NULL AND paid_suggestions_operation_id IS NULL)
  OR (paid_suggestions_revision>0 AND paid_suggestions_ciphertext IS NOT NULL AND octet_length(paid_suggestions_ciphertext)>=29 AND paid_suggestions_updated_at IS NOT NULL AND paid_suggestions_operation_id IS NOT NULL));
 END IF;
END $$;
CREATE TABLE IF NOT EXISTS platform_companion_paid_setting_operations(
 user_id uuid NOT NULL REFERENCES platform_users(id) ON DELETE CASCADE,
 companion_id uuid NOT NULL,operation_id uuid NOT NULL,applied_revision integer NOT NULL CHECK(applied_revision>0),
 receipt_ciphertext bytea NOT NULL CHECK(octet_length(receipt_ciphertext)>=29),created_at timestamptz NOT NULL,
 PRIMARY KEY(user_id,operation_id),UNIQUE(user_id,companion_id,applied_revision),UNIQUE(user_id,companion_id,operation_id,applied_revision),
 FOREIGN KEY(companion_id,user_id) REFERENCES platform_companions(id,user_id) ON DELETE CASCADE);
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='platform_companions'::regclass AND conname='companion_paid_settings_receipt') THEN
 ALTER TABLE platform_companions ADD CONSTRAINT companion_paid_settings_receipt
 FOREIGN KEY(user_id,id,paid_suggestions_operation_id,paid_suggestions_revision)
 REFERENCES platform_companion_paid_setting_operations(user_id,companion_id,operation_id,applied_revision);
 END IF;
END $$;
DROP TRIGGER IF EXISTS companion_paid_setting_operation_immutable ON platform_companion_paid_setting_operations;
CREATE TRIGGER companion_paid_setting_operation_immutable BEFORE UPDATE OR DELETE ON platform_companion_paid_setting_operations
 FOR EACH ROW EXECUTE FUNCTION shared_memory_keep_receipt();
