-- Internal composition only. First adoption records the authentic surviving raw
-- inventory; it does not assert or manufacture a pre-adoption history.
CREATE TABLE IF NOT EXISTS platform_companion_prebirth_heads (
  user_id uuid PRIMARY KEY REFERENCES platform_users(id) ON DELETE CASCADE,
  revision integer NOT NULL CHECK(revision BETWEEN 0 AND 2147483647),
  adopted_at timestamptz NOT NULL,
  tip_id uuid,
  tip_digest text NOT NULL CHECK(tip_digest ~ '^[0-9a-f]{64}$'),
  payload_ciphertext bytea NOT NULL CHECK(octet_length(payload_ciphertext) BETWEEN 29 AND 65565),
  CHECK((revision=0 AND tip_id IS NULL AND tip_digest=repeat('0',64)) OR (revision>0 AND tip_id IS NOT NULL))
);
ALTER TABLE platform_users ADD COLUMN IF NOT EXISTS prebirth_inventory_owner_id uuid;
DO $$ BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conname='companion_prebirth_owner_anchor' AND conrelid='platform_users'::regclass) THEN
    ALTER TABLE platform_users ADD CONSTRAINT companion_prebirth_owner_anchor
      FOREIGN KEY(prebirth_inventory_owner_id) REFERENCES platform_companion_prebirth_heads(user_id) DEFERRABLE INITIALLY DEFERRED;
  END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conname='companion_prebirth_owner_self' AND conrelid='platform_users'::regclass) THEN
    ALTER TABLE platform_users ADD CONSTRAINT companion_prebirth_owner_self CHECK(prebirth_inventory_owner_id IS NULL OR prebirth_inventory_owner_id=id);
  END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conname='companion_prebirth_intake_fixed_source' AND conrelid='platform_onboarding_safety_submissions'::regclass) THEN
    ALTER TABLE platform_onboarding_safety_submissions ADD CONSTRAINT companion_prebirth_intake_fixed_source
      UNIQUE(id,user_id,operation_id,draft_id,question_id,submitted_revision);
  END IF;
END $$;
CREATE TABLE IF NOT EXISTS platform_companion_prebirth_inventory (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES platform_users(id) ON DELETE CASCADE,
  revision integer NOT NULL CHECK(revision BETWEEN 1 AND 2147483647),
  kind text NOT NULL CHECK(kind IN ('intake_operation','name_entry','name_submission')),
  source_id uuid NOT NULL,
  intake_draft_id uuid,
  intake_operation_id uuid,
  intake_revision integer,
  intake_submission_id uuid,
  intake_question_id text,
  name_entry_id uuid,
  name_submission_id uuid,
  name_operation_id uuid,
  name_task_id uuid,
  name_companion_id uuid,
  name_preview_revision integer,
  name_submitted_revision integer,
  name_expected_identity_revision integer,
  source_digest text NOT NULL CHECK(source_digest ~ '^[0-9a-f]{64}$'),
  chain_digest text NOT NULL CHECK(chain_digest ~ '^[0-9a-f]{64}$'),
  enrolled_at timestamptz NOT NULL,
  payload_ciphertext bytea NOT NULL CHECK(octet_length(payload_ciphertext) BETWEEN 29 AND 65565),
  UNIQUE(user_id,revision), UNIQUE(user_id,kind,source_id), UNIQUE(id,user_id,revision,chain_digest),
  FOREIGN KEY(user_id) REFERENCES platform_companion_prebirth_heads(user_id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY(user_id,intake_operation_id,intake_draft_id,intake_revision)
    REFERENCES platform_onboarding_operations(user_id,operation_id,draft_id,applied_revision) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY(intake_submission_id,user_id,intake_operation_id,intake_draft_id,intake_question_id,intake_revision)
    REFERENCES platform_onboarding_safety_submissions(id,user_id,operation_id,draft_id,question_id,submitted_revision) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY(name_entry_id,user_id,name_task_id,name_companion_id,name_preview_revision)
    REFERENCES platform_companion_name_entries(id,user_id,task_id,companion_id,preview_revision) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY(name_submission_id,user_id,name_operation_id,name_entry_id,name_task_id,name_companion_id,name_preview_revision,name_submitted_revision,name_expected_identity_revision)
    REFERENCES platform_companion_name_submissions(id,user_id,operation_id,entry_id,task_id,companion_id,preview_revision,submitted_revision,expected_identity_revision) DEFERRABLE INITIALLY DEFERRED,
  CHECK((kind='intake_operation' AND source_id=intake_operation_id AND intake_operation_id IS NOT NULL AND intake_draft_id IS NOT NULL
      AND intake_revision IS NOT NULL AND intake_revision>0 AND ((intake_submission_id IS NULL AND intake_question_id IS NULL) OR (intake_submission_id IS NOT NULL AND intake_question_id IS NOT NULL))
      AND name_entry_id IS NULL AND name_submission_id IS NULL AND name_operation_id IS NULL AND name_task_id IS NULL
      AND name_companion_id IS NULL AND name_preview_revision IS NULL AND name_submitted_revision IS NULL AND name_expected_identity_revision IS NULL)
    OR (kind='name_entry' AND source_id=name_entry_id AND name_entry_id IS NOT NULL AND name_task_id IS NOT NULL AND name_companion_id IS NOT NULL AND name_preview_revision IS NOT NULL AND name_preview_revision=1
      AND name_submission_id IS NULL AND name_operation_id IS NULL AND name_submitted_revision IS NULL AND name_expected_identity_revision IS NULL
      AND intake_draft_id IS NULL AND intake_operation_id IS NULL AND intake_revision IS NULL AND intake_submission_id IS NULL AND intake_question_id IS NULL)
    OR (kind='name_submission' AND source_id=name_submission_id AND name_submission_id IS NOT NULL AND name_operation_id IS NOT NULL AND name_entry_id IS NOT NULL
      AND name_task_id IS NOT NULL AND name_companion_id IS NOT NULL AND name_preview_revision IS NOT NULL AND name_preview_revision=1 AND name_submitted_revision IS NOT NULL AND name_submitted_revision>0
      AND name_expected_identity_revision IS NOT NULL AND name_expected_identity_revision>=0
      AND intake_draft_id IS NULL AND intake_operation_id IS NULL AND intake_revision IS NULL AND intake_submission_id IS NULL AND intake_question_id IS NULL))
);
DO $$ BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conname='companion_prebirth_tip' AND conrelid='platform_companion_prebirth_heads'::regclass) THEN
    ALTER TABLE platform_companion_prebirth_heads ADD CONSTRAINT companion_prebirth_tip
      FOREIGN KEY(tip_id,user_id,revision,tip_digest) REFERENCES platform_companion_prebirth_inventory(id,user_id,revision,chain_digest) DEFERRABLE INITIALLY DEFERRED;
  END IF;
END $$;
CREATE OR REPLACE FUNCTION companion_prebirth_keep_owner_anchor() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  IF OLD.prebirth_inventory_owner_id IS NOT NULL AND NEW.prebirth_inventory_owner_id IS DISTINCT FROM OLD.prebirth_inventory_owner_id THEN
    RAISE EXCEPTION 'prebirth inventory anchor cannot be cleared or replaced' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION companion_prebirth_keep_inventory() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  IF EXISTS(SELECT 1 FROM platform_users WHERE id=OLD.user_id) THEN
    RAISE EXCEPTION 'prebirth enrollment is immutable while its owner exists' USING ERRCODE='23514';
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF; RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION companion_prebirth_keep_head() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  IF TG_OP='DELETE' THEN
    IF EXISTS(SELECT 1 FROM platform_users WHERE id=OLD.user_id) THEN
      RAISE EXCEPTION 'prebirth inventory head cannot be deleted while its owner exists' USING ERRCODE='23514';
    END IF; RETURN OLD;
  END IF;
  IF NEW.user_id IS DISTINCT FROM OLD.user_id OR NEW.adopted_at IS DISTINCT FROM OLD.adopted_at OR NEW.revision<=OLD.revision THEN
    RAISE EXCEPTION 'prebirth inventory head cannot be rewound or replaced' USING ERRCODE='23514';
  END IF; RETURN NEW;
END $$;
DO $$ BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgname='companion_prebirth_owner_anchor_guard' AND tgrelid='platform_users'::regclass) THEN
    CREATE TRIGGER companion_prebirth_owner_anchor_guard BEFORE UPDATE ON platform_users FOR EACH ROW EXECUTE FUNCTION companion_prebirth_keep_owner_anchor();
  END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgname='companion_prebirth_inventory_guard' AND tgrelid='platform_companion_prebirth_inventory'::regclass) THEN
    CREATE TRIGGER companion_prebirth_inventory_guard BEFORE UPDATE OR DELETE ON platform_companion_prebirth_inventory FOR EACH ROW EXECUTE FUNCTION companion_prebirth_keep_inventory();
  END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgname='companion_prebirth_head_guard' AND tgrelid='platform_companion_prebirth_heads'::regclass) THEN
    CREATE TRIGGER companion_prebirth_head_guard BEFORE UPDATE OR DELETE ON platform_companion_prebirth_heads FOR EACH ROW EXECUTE FUNCTION companion_prebirth_keep_head();
  END IF;
END $$;
