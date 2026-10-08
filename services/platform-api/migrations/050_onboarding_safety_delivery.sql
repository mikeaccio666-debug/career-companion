-- Genuine source-specific intake delivery; no assets, grades or receipts are seeded.
-- All original030/039/047 cipher columns retain their original codecs.
DO $$ BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='platform_onboarding_safety_submissions'::regclass AND conname='intake_v2_source_binding') THEN
    ALTER TABLE platform_onboarding_safety_submissions ADD CONSTRAINT intake_v2_source_binding UNIQUE(id,user_id,generation,detector_revision,level,detector_mode);
  END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='platform_onboarding_safety_responses'::regclass AND conname='intake_v2_response_binding') THEN
    ALTER TABLE platform_onboarding_safety_responses ADD CONSTRAINT intake_v2_response_binding UNIQUE(id,user_id,submission_id,source_generation,detector_revision,level,detector_mode);
  END IF;
END $$;
CREATE TABLE IF NOT EXISTS platform_onboarding_delivery_v2_heads (
  submission_id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES platform_users(id) ON DELETE CASCADE,
  source_generation integer NOT NULL, detector_revision integer NOT NULL,
  level text NOT NULL CHECK(level IN ('L1','L2')), detector_mode text NOT NULL CHECK(detector_mode IN ('full','keyword_only')),
  revision integer NOT NULL CHECK(revision BETWEEN 0 AND 2147483647), latest_publication_id uuid,
  payload_ciphertext bytea NOT NULL CHECK(octet_length(payload_ciphertext) BETWEEN 29 AND 65565),
  UNIQUE(submission_id,user_id,source_generation,detector_revision,level,detector_mode),
  FOREIGN KEY(submission_id,user_id,source_generation,detector_revision,level,detector_mode)
    REFERENCES platform_onboarding_safety_submissions(id,user_id,generation,detector_revision,level,detector_mode) ON DELETE CASCADE,
  CHECK((revision=0 AND latest_publication_id IS NULL) OR (revision>0 AND latest_publication_id IS NOT NULL))
);
CREATE TABLE IF NOT EXISTS platform_onboarding_safety_v2_publications (
  id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES platform_users(id) ON DELETE CASCADE,
  submission_id uuid NOT NULL, response_id uuid NOT NULL, source_generation integer NOT NULL,
  detector_revision integer NOT NULL, level text NOT NULL CHECK(level IN ('L1','L2')),
  detector_mode text NOT NULL CHECK(detector_mode IN ('full','keyword_only')),
  logical_draft_id uuid NOT NULL REFERENCES platform_onboarding_drafts(id) ON DELETE CASCADE,
  edition integer NOT NULL CHECK(edition BETWEEN 1 AND 2147483647),
  publication_operation_id uuid NOT NULL, asset_id uuid NOT NULL REFERENCES platform_safety_delivery_assets(id) ON DELETE RESTRICT,
  activation_user_id uuid NOT NULL, activation_operation_id uuid NOT NULL,
  activation_kind text NOT NULL DEFAULT 'activate' CHECK(activation_kind='activate'),
  body_digest text NOT NULL CHECK(body_digest ~ '^[0-9a-f]{64}$'),
  question_digest text CHECK(question_digest ~ '^[0-9a-f]{64}$'),
  payload_ciphertext bytea NOT NULL CHECK(octet_length(payload_ciphertext) BETWEEN 29 AND 131101),
  prepared_at timestamptz NOT NULL, published_at timestamptz NOT NULL,
  retention_until timestamptz NOT NULL, evidence_retention_until timestamptz NOT NULL,
  UNIQUE(submission_id,edition), UNIQUE(user_id,publication_operation_id),
  UNIQUE(id,user_id), UNIQUE(id,user_id,submission_id,source_generation), UNIQUE(id,user_id,edition,body_digest),
  UNIQUE(id,user_id,submission_id,source_generation,logical_draft_id,question_digest),
  FOREIGN KEY(logical_draft_id,user_id) REFERENCES platform_onboarding_drafts(id,user_id) ON DELETE CASCADE,
  FOREIGN KEY(response_id,user_id,submission_id,source_generation,detector_revision,level,detector_mode)
    REFERENCES platform_onboarding_safety_responses(id,user_id,submission_id,source_generation,detector_revision,level,detector_mode) ON DELETE CASCADE,
  FOREIGN KEY(activation_user_id,activation_operation_id,asset_id,activation_kind)
    REFERENCES platform_safety_delivery_review_operations(user_id,operation_id,asset_id,kind) ON DELETE RESTRICT,
  CHECK(prepared_at=published_at AND retention_until>published_at AND evidence_retention_until>published_at),
  CHECK((level='L2' AND question_digest IS NOT NULL) OR (level='L1' AND question_digest IS NULL))
);
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='platform_onboarding_delivery_v2_heads'::regclass AND conname='intake_v2_delivery_head_publication') THEN
    ALTER TABLE platform_onboarding_delivery_v2_heads ADD CONSTRAINT intake_v2_delivery_head_publication
      FOREIGN KEY(latest_publication_id,user_id,submission_id,source_generation)
      REFERENCES platform_onboarding_safety_v2_publications(id,user_id,submission_id,source_generation)
      DEFERRABLE INITIALLY DEFERRED;
  END IF;
END $$;
CREATE TABLE IF NOT EXISTS platform_onboarding_delivery_v2_operations (
  user_id uuid NOT NULL REFERENCES platform_users(id) ON DELETE CASCADE,
  operation_id uuid NOT NULL, submission_id uuid NOT NULL, source_generation integer NOT NULL,
  publication_id uuid NOT NULL, kind text NOT NULL CHECK(kind IN ('publish','recover')),
  expected_edition integer NOT NULL CHECK(expected_edition BETWEEN 0 AND 2147483646),
  session_hash text NOT NULL CHECK(session_hash ~ '^[0-9a-f]{64}$'),
  payload_ciphertext bytea NOT NULL CHECK(octet_length(payload_ciphertext) BETWEEN 29 AND 65565),
  created_at timestamptz NOT NULL, PRIMARY KEY(user_id,operation_id),
  UNIQUE(user_id,operation_id,publication_id),
  FOREIGN KEY(publication_id,user_id,submission_id,source_generation)
    REFERENCES platform_onboarding_safety_v2_publications(id,user_id,submission_id,source_generation) ON DELETE CASCADE
);
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='platform_onboarding_safety_v2_publications'::regclass AND conname='intake_v2_delivery_publication_operation') THEN
    ALTER TABLE platform_onboarding_safety_v2_publications ADD CONSTRAINT intake_v2_delivery_publication_operation
      FOREIGN KEY(user_id,publication_operation_id,id)
      REFERENCES platform_onboarding_delivery_v2_operations(user_id,operation_id,publication_id) DEFERRABLE INITIALLY DEFERRED;
  END IF;
END $$;
CREATE TABLE IF NOT EXISTS platform_onboarding_safety_v2_body_projections (
  id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES platform_users(id) ON DELETE CASCADE,
  publication_id uuid NOT NULL, edition integer NOT NULL, body_digest text NOT NULL,
  session_hash text NOT NULL CHECK(session_hash ~ '^[0-9a-f]{64}$'),
  issued_at timestamptz NOT NULL, payload_ciphertext bytea NOT NULL CHECK(octet_length(payload_ciphertext) BETWEEN 29 AND 131101),
  UNIQUE(id,user_id,publication_id,session_hash,body_digest),
  FOREIGN KEY(publication_id,user_id,edition,body_digest)
    REFERENCES platform_onboarding_safety_v2_publications(id,user_id,edition,body_digest) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS platform_onboarding_safety_v2_followup_states (
  publication_id uuid PRIMARY KEY REFERENCES platform_onboarding_safety_v2_publications(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES platform_users(id) ON DELETE CASCADE,
  revision integer NOT NULL CHECK(revision BETWEEN 0 AND 2147483647), latest_operation_id uuid,
  journal_digest text NOT NULL CHECK(journal_digest ~ '^[0-9a-f]{64}$'),
  payload_ciphertext bytea NOT NULL CHECK(octet_length(payload_ciphertext) BETWEEN 29 AND 65565),
  FOREIGN KEY(publication_id,user_id) REFERENCES platform_onboarding_safety_v2_publications(id,user_id) ON DELETE CASCADE,
  CHECK((revision=0 AND latest_operation_id IS NULL) OR (revision>0 AND latest_operation_id IS NOT NULL))
);
CREATE TABLE IF NOT EXISTS platform_onboarding_safety_v2_followups (
  user_id uuid NOT NULL REFERENCES platform_users(id) ON DELETE CASCADE, operation_id uuid NOT NULL,
  publication_id uuid NOT NULL, submission_id uuid NOT NULL, source_generation integer NOT NULL,
  kind text NOT NULL CHECK(kind IN ('present_body','present_body_evidence','acknowledge','need_support','continue_intake','clarify_exaggeration')),
  expected_revision integer NOT NULL CHECK(expected_revision BETWEEN 0 AND 2147483646),
  applied_revision integer NOT NULL CHECK(applied_revision=expected_revision+1),
  session_hash text NOT NULL CHECK(session_hash ~ '^[0-9a-f]{64}$'),
  body_projection_id uuid, body_digest text,
  presentation_digest text CHECK(presentation_digest ~ '^[0-9a-f]{64}$'),
  presentation_operation_id uuid, acknowledgment_operation_id uuid,
  presentation_kind text CHECK(presentation_kind IS NULL OR presentation_kind='present_body'),
  acknowledgment_kind text CHECK(acknowledgment_kind IS NULL OR acknowledgment_kind='acknowledge'),
  handled boolean NOT NULL, clarified_at timestamptz, created_at timestamptz NOT NULL,
  previous_digest text NOT NULL CHECK(previous_digest ~ '^[0-9a-f]{64}$'),
  journal_digest text NOT NULL CHECK(journal_digest ~ '^[0-9a-f]{64}$'),
  payload_ciphertext bytea NOT NULL CHECK(octet_length(payload_ciphertext) BETWEEN 29 AND 131101),
  PRIMARY KEY(user_id,operation_id), UNIQUE(publication_id,applied_revision),
  UNIQUE(user_id,operation_id,publication_id,applied_revision),
  UNIQUE(user_id,operation_id,publication_id,session_hash,body_projection_id,presentation_digest,kind),
  UNIQUE(user_id,operation_id,publication_id,submission_id,source_generation,kind),
  FOREIGN KEY(publication_id,user_id,submission_id,source_generation)
    REFERENCES platform_onboarding_safety_v2_publications(id,user_id,submission_id,source_generation) ON DELETE CASCADE,
  FOREIGN KEY(body_projection_id,user_id,publication_id,session_hash,body_digest)
    REFERENCES platform_onboarding_safety_v2_body_projections(id,user_id,publication_id,session_hash,body_digest) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY(user_id,presentation_operation_id,publication_id,session_hash,body_projection_id,presentation_digest,presentation_kind)
    REFERENCES platform_onboarding_safety_v2_followups(user_id,operation_id,publication_id,session_hash,body_projection_id,presentation_digest,kind) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY(user_id,acknowledgment_operation_id,publication_id,session_hash,body_projection_id,presentation_digest,acknowledgment_kind)
    REFERENCES platform_onboarding_safety_v2_followups(user_id,operation_id,publication_id,session_hash,body_projection_id,presentation_digest,kind) DEFERRABLE INITIALLY DEFERRED,
  CHECK((kind='need_support' AND body_projection_id IS NULL AND body_digest IS NULL AND presentation_digest IS NULL AND presentation_operation_id IS NULL AND acknowledgment_operation_id IS NULL AND presentation_kind IS NULL AND acknowledgment_kind IS NULL AND NOT handled AND clarified_at IS NULL)
    OR (kind='present_body_evidence' AND body_projection_id IS NOT NULL AND body_digest IS NOT NULL AND presentation_digest IS NULL AND presentation_operation_id IS NULL AND acknowledgment_operation_id IS NULL AND presentation_kind IS NULL AND acknowledgment_kind IS NULL AND NOT handled AND clarified_at IS NULL)
    OR (kind='present_body' AND body_projection_id IS NOT NULL AND body_digest IS NOT NULL AND presentation_digest IS NOT NULL AND presentation_operation_id IS NULL AND acknowledgment_operation_id IS NULL AND presentation_kind IS NULL AND acknowledgment_kind IS NULL AND NOT handled AND clarified_at IS NULL)
    OR (kind='acknowledge' AND body_projection_id IS NOT NULL AND body_digest IS NOT NULL AND presentation_digest IS NOT NULL AND presentation_operation_id IS NOT NULL AND presentation_kind IS NOT NULL AND presentation_kind='present_body' AND acknowledgment_operation_id IS NULL AND acknowledgment_kind IS NULL AND NOT handled AND clarified_at IS NULL)
    OR (kind IN ('continue_intake','clarify_exaggeration') AND body_projection_id IS NOT NULL AND body_digest IS NOT NULL AND presentation_digest IS NOT NULL AND presentation_operation_id IS NOT NULL AND acknowledgment_operation_id IS NOT NULL AND presentation_kind IS NOT NULL AND presentation_kind='present_body' AND acknowledgment_kind IS NOT NULL AND acknowledgment_kind='acknowledge' AND handled AND ((kind='continue_intake' AND clarified_at IS NULL) OR (kind='clarify_exaggeration' AND clarified_at IS NOT NULL AND clarified_at=created_at))))
);
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='platform_onboarding_safety_v2_followup_states'::regclass AND conname='intake_v2_followup_state_head') THEN
    ALTER TABLE platform_onboarding_safety_v2_followup_states ADD CONSTRAINT intake_v2_followup_state_head
      FOREIGN KEY(user_id,latest_operation_id,publication_id,revision)
      REFERENCES platform_onboarding_safety_v2_followups(user_id,operation_id,publication_id,applied_revision) DEFERRABLE INITIALLY DEFERRED;
  END IF;
END $$;
CREATE TABLE IF NOT EXISTS platform_onboarding_safety_v2_handled (
  submission_id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES platform_users(id) ON DELETE CASCADE,
  source_generation integer NOT NULL, detector_revision integer NOT NULL,
  level text NOT NULL CHECK(level IN ('L1','L2')), detector_mode text NOT NULL CHECK(detector_mode IN ('full','keyword_only')),
  publication_id uuid NOT NULL, operation_id uuid NOT NULL,
  kind text NOT NULL CHECK(kind IN ('continue_intake','clarify_exaggeration')),
  FOREIGN KEY(submission_id,user_id,source_generation,detector_revision,level,detector_mode)
    REFERENCES platform_onboarding_safety_submissions(id,user_id,generation,detector_revision,level,detector_mode) ON DELETE CASCADE,
  FOREIGN KEY(user_id,operation_id,publication_id,submission_id,source_generation,kind)
    REFERENCES platform_onboarding_safety_v2_followups(user_id,operation_id,publication_id,submission_id,source_generation,kind) ON DELETE CASCADE
);


-- Non-rewindable real source root and prospective old039 publication cutover.
ALTER TABLE platform_onboarding_safety_submissions ADD COLUMN IF NOT EXISTS first_safety_v2_publication_id uuid;
ALTER TABLE platform_onboarding_drafts ADD COLUMN IF NOT EXISTS safety_resource_v2_draft_id uuid;
CREATE TABLE IF NOT EXISTS platform_onboarding_resource_cutovers (
 user_id uuid NOT NULL REFERENCES platform_users(id) ON DELETE CASCADE,
 draft_id uuid PRIMARY KEY, recorded_at timestamptz NOT NULL,
 legacy_digest text NOT NULL CHECK(legacy_digest ~ '^[0-9a-f]{64}$'),
 payload_ciphertext bytea NOT NULL CHECK(octet_length(payload_ciphertext) BETWEEN 29 AND 262173),
 UNIQUE(user_id,draft_id), FOREIGN KEY(draft_id,user_id) REFERENCES platform_onboarding_drafts(id,user_id) ON DELETE CASCADE
);
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='platform_onboarding_safety_submissions'::regclass AND conname='intake_v2_first_publication') THEN
  ALTER TABLE platform_onboarding_safety_submissions ADD CONSTRAINT intake_v2_first_publication FOREIGN KEY(first_safety_v2_publication_id,user_id,id,generation)
   REFERENCES platform_onboarding_safety_v2_publications(id,user_id,submission_id,source_generation) DEFERRABLE INITIALLY DEFERRED;
 END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='platform_onboarding_drafts'::regclass AND conname='intake_v2_cutover_anchor') THEN
  ALTER TABLE platform_onboarding_drafts ADD CONSTRAINT intake_v2_cutover_anchor FOREIGN KEY(user_id,safety_resource_v2_draft_id)
   REFERENCES platform_onboarding_resource_cutovers(user_id,draft_id) DEFERRABLE INITIALLY DEFERRED;
 END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='platform_onboarding_drafts'::regclass AND conname='intake_v2_cutover_same_draft') THEN
  ALTER TABLE platform_onboarding_drafts ADD CONSTRAINT intake_v2_cutover_same_draft CHECK(safety_resource_v2_draft_id IS NULL OR safety_resource_v2_draft_id=id);
 END IF;
END $$;
CREATE OR REPLACE FUNCTION platform_preserve_intake_v2_anchor() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF OLD.first_safety_v2_publication_id IS NOT NULL AND NEW.first_safety_v2_publication_id IS DISTINCT FROM OLD.first_safety_v2_publication_id THEN
  RAISE EXCEPTION 'Intake resource history anchor is immutable' USING ERRCODE='23514';
 END IF; RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION platform_preserve_intake_v2_cutover() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF OLD.safety_resource_v2_draft_id IS NOT NULL AND NEW.safety_resource_v2_draft_id IS DISTINCT FROM OLD.safety_resource_v2_draft_id THEN
  RAISE EXCEPTION 'Intake resource cutover is immutable' USING ERRCODE='23514';
 END IF; RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION platform_reject_old_resource_publication() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF EXISTS(SELECT 1 FROM platform_onboarding_drafts WHERE id=NEW.draft_id AND user_id=NEW.user_id AND safety_resource_v2_draft_id IS NOT NULL) THEN
  RAISE EXCEPTION 'Intake resource transport has changed' USING ERRCODE='23514';
 END IF; RETURN NEW;
END $$;
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='platform_onboarding_safety_submissions'::regclass AND tgname='preserve_intake_v2_anchor' AND NOT tgisinternal) THEN
  CREATE TRIGGER preserve_intake_v2_anchor BEFORE UPDATE ON platform_onboarding_safety_submissions FOR EACH ROW EXECUTE FUNCTION platform_preserve_intake_v2_anchor();
 END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='platform_onboarding_drafts'::regclass AND tgname='preserve_intake_v2_cutover' AND NOT tgisinternal) THEN
  CREATE TRIGGER preserve_intake_v2_cutover BEFORE UPDATE ON platform_onboarding_drafts FOR EACH ROW EXECUTE FUNCTION platform_preserve_intake_v2_cutover();
 END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='platform_onboarding_safety_publications'::regclass AND tgname='reject_old_resource_publication' AND NOT tgisinternal) THEN
  CREATE TRIGGER reject_old_resource_publication BEFORE INSERT ON platform_onboarding_safety_publications FOR EACH ROW EXECUTE FUNCTION platform_reject_old_resource_publication();
 END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='platform_onboarding_safety_followups'::regclass AND tgname='reject_old_resource_followup' AND NOT tgisinternal) THEN
  CREATE TRIGGER reject_old_resource_followup BEFORE INSERT ON platform_onboarding_safety_followups FOR EACH ROW EXECUTE FUNCTION platform_reject_old_resource_publication();
 END IF;
END $$;
-- Existing name rows gain only their truthful source discriminator. Their original
-- canonical captures remain V1. Derived parents close the source XOR without null bypass.
ALTER TABLE platform_safety_question_occurrences ADD COLUMN IF NOT EXISTS source_kind text NOT NULL DEFAULT 'companion_name';
ALTER TABLE platform_safety_question_occurrences ADD COLUMN IF NOT EXISTS name_publication_id uuid GENERATED ALWAYS AS(CASE WHEN source_kind='companion_name' THEN publication_id END) STORED;
ALTER TABLE platform_safety_question_occurrences ADD COLUMN IF NOT EXISTS name_submission_id uuid GENERATED ALWAYS AS(CASE WHEN source_kind='companion_name' THEN submission_id END) STORED;
ALTER TABLE platform_safety_question_occurrences ADD COLUMN IF NOT EXISTS intake_publication_id uuid GENERATED ALWAYS AS(CASE WHEN source_kind='onboarding' THEN publication_id END) STORED;
ALTER TABLE platform_safety_question_occurrences ADD COLUMN IF NOT EXISTS intake_submission_id uuid GENERATED ALWAYS AS(CASE WHEN source_kind='onboarding' THEN submission_id END) STORED;
DO $$ DECLARE r record; BEGIN
 FOR r IN SELECT conname FROM pg_constraint WHERE conrelid='platform_safety_question_occurrences'::regclass AND contype='f' AND confrelid='platform_companion_name_safety_publications'::regclass AND conname<>'question_name_target_v2' LOOP
  EXECUTE format('ALTER TABLE platform_safety_question_occurrences DROP CONSTRAINT %I',r.conname);
 END LOOP;
 FOR r IN SELECT conname FROM pg_constraint WHERE conrelid='platform_safety_question_occurrences'::regclass AND contype='u' AND pg_get_constraintdef(oid)='UNIQUE (submission_id, source_generation, occurrence)' LOOP
  EXECUTE format('ALTER TABLE platform_safety_question_occurrences DROP CONSTRAINT %I',r.conname);
 END LOOP;
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='platform_safety_question_occurrences'::regclass AND conname='question_source_xor_v2') THEN
  ALTER TABLE platform_safety_question_occurrences ADD CONSTRAINT question_source_xor_v2 CHECK(
   (source_kind='companion_name' AND name_publication_id IS NOT NULL AND name_submission_id IS NOT NULL AND intake_publication_id IS NULL AND intake_submission_id IS NULL)
   OR(source_kind='onboarding' AND intake_publication_id IS NOT NULL AND intake_submission_id IS NOT NULL AND name_publication_id IS NULL AND name_submission_id IS NULL));
 END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='platform_safety_question_occurrences'::regclass AND conname='question_source_occurrence_v2') THEN
  ALTER TABLE platform_safety_question_occurrences ADD CONSTRAINT question_source_occurrence_v2 UNIQUE(source_kind,submission_id,source_generation,occurrence);
 END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='platform_safety_question_occurrences'::regclass AND conname='question_name_target_v2') THEN
  ALTER TABLE platform_safety_question_occurrences ADD CONSTRAINT question_name_target_v2 FOREIGN KEY(name_publication_id,user_id,name_submission_id,source_generation,draft_id,question_digest)
   REFERENCES platform_companion_name_safety_publications(id,user_id,submission_id,source_generation,logical_draft_id,question_digest) ON DELETE CASCADE;
 END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='platform_safety_question_occurrences'::regclass AND conname='question_intake_target_v2') THEN
  ALTER TABLE platform_safety_question_occurrences ADD CONSTRAINT question_intake_target_v2 FOREIGN KEY(intake_publication_id,user_id,intake_submission_id,source_generation,draft_id,question_digest)
   REFERENCES platform_onboarding_safety_v2_publications(id,user_id,submission_id,source_generation,logical_draft_id,question_digest) ON DELETE CASCADE;
 END IF;
END $$;

-- V2 captures genuine050 original body handling at actual preparation. Existing
-- V1/NULL tasks and encrypted manifests are never rewritten or backfilled.
DO $$ DECLARE r record; BEGIN
 FOR r IN SELECT conname FROM pg_constraint WHERE conrelid='platform_companion_generation_tasks'::regclass AND contype='c'
   AND pg_get_constraintdef(oid) LIKE '%source_receipt_version%' AND conname<>'companion_source_receipt_versions_v2' LOOP
  EXECUTE format('ALTER TABLE platform_companion_generation_tasks DROP CONSTRAINT %I',r.conname);
 END LOOP;
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='platform_companion_generation_tasks'::regclass AND conname='companion_source_receipt_versions_v2') THEN
  ALTER TABLE platform_companion_generation_tasks ADD CONSTRAINT companion_source_receipt_versions_v2 CHECK(source_receipt_version IS NULL OR source_receipt_version IN(1,2));
 END IF;
 FOR r IN SELECT conname FROM pg_constraint WHERE conrelid='platform_companion_source_prefixes'::regclass AND contype='c'
   AND pg_get_constraintdef(oid) LIKE '%schema_version%' AND conname<>'companion_prefix_versions_v2' LOOP
  EXECUTE format('ALTER TABLE platform_companion_source_prefixes DROP CONSTRAINT %I',r.conname);
 END LOOP;
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='platform_companion_source_prefixes'::regclass AND conname='companion_prefix_versions_v2') THEN
  ALTER TABLE platform_companion_source_prefixes ADD CONSTRAINT companion_prefix_versions_v2 CHECK(schema_version IN(1,2));
 END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='platform_companion_generation_tasks'::regclass AND conname='companion_task_prefix_version_binding') THEN
  ALTER TABLE platform_companion_generation_tasks ADD CONSTRAINT companion_task_prefix_version_binding UNIQUE(id,user_id,source_receipt_version);
 END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='platform_companion_source_prefixes'::regclass AND conname='companion_prefix_typed_version') THEN
  ALTER TABLE platform_companion_source_prefixes ADD CONSTRAINT companion_prefix_typed_version FOREIGN KEY(task_id,user_id,schema_version)
   REFERENCES platform_companion_generation_tasks(id,user_id,source_receipt_version) DEFERRABLE INITIALLY DEFERRED;
 END IF;
END $$;
