-- Internal delivery of real classified name resources. No assets, review,
-- activation, grade, presentation, question or handled evidence is seeded.
CREATE TABLE IF NOT EXISTS platform_safety_delivery_assets (
  id uuid PRIMARY KEY, bundle_revision integer NOT NULL CHECK(bundle_revision>0),
  content_digest text NOT NULL CHECK(content_digest ~ '^[0-9a-f]{64}$'),
  bundle_review_digest text NOT NULL CHECK(bundle_review_digest ~ '^[0-9a-f]{64}$'),
  review_digest text NOT NULL UNIQUE CHECK(review_digest ~ '^[0-9a-f]{64}$'),
  bundle_json text NOT NULL, review_json text NOT NULL,
  reviewer_id uuid NOT NULL REFERENCES platform_users(id) ON DELETE RESTRICT,
  org_id uuid NOT NULL REFERENCES platform_orgs(id) ON DELETE RESTRICT,
  reviewer_session_hash text NOT NULL CHECK(reviewer_session_hash ~ '^[0-9a-f]{64}$'),
  auth_version text NOT NULL, reviewed_at timestamptz NOT NULL, recorded_at timestamptz NOT NULL,
  decision_ciphertext bytea NOT NULL CHECK(octet_length(decision_ciphertext) BETWEEN 29 AND 262173),
  CHECK(reviewed_at<=recorded_at)
);
CREATE TABLE IF NOT EXISTS platform_safety_delivery_review_operations (
  user_id uuid NOT NULL REFERENCES platform_users(id) ON DELETE RESTRICT,
  operation_id uuid NOT NULL, asset_id uuid NOT NULL REFERENCES platform_safety_delivery_assets(id) ON DELETE RESTRICT,
  kind text NOT NULL CHECK(kind IN ('review','activate')),
  input_digest text NOT NULL CHECK(input_digest ~ '^[0-9a-f]{64}$'),
  capture_ciphertext bytea NOT NULL CHECK(octet_length(capture_ciphertext) BETWEEN 29 AND 262173),
  created_at timestamptz NOT NULL, PRIMARY KEY(user_id,operation_id),
  UNIQUE(user_id,operation_id,asset_id,kind)
);
CREATE TABLE IF NOT EXISTS platform_safety_delivery_policy (
  singleton boolean PRIMARY KEY CHECK(singleton),
  asset_id uuid NOT NULL REFERENCES platform_safety_delivery_assets(id) ON DELETE RESTRICT,
  activated_by uuid NOT NULL REFERENCES platform_users(id) ON DELETE RESTRICT,
  activation_operation_id uuid NOT NULL,
  activation_kind text NOT NULL DEFAULT 'activate' CHECK(activation_kind='activate'),
  activated_at timestamptz NOT NULL,
  FOREIGN KEY(activated_by,activation_operation_id,asset_id,activation_kind)
    REFERENCES platform_safety_delivery_review_operations(user_id,operation_id,asset_id,kind) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS platform_companion_name_delivery_heads (
  submission_id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES platform_users(id) ON DELETE CASCADE,
  source_generation integer NOT NULL, detector_revision integer NOT NULL,
  level text NOT NULL CHECK(level IN ('L1','L2')), detector_mode text NOT NULL CHECK(detector_mode IN ('full','keyword_only')),
  revision integer NOT NULL CHECK(revision BETWEEN 0 AND 2147483647), latest_publication_id uuid,
  payload_ciphertext bytea NOT NULL CHECK(octet_length(payload_ciphertext) BETWEEN 29 AND 65565),
  UNIQUE(submission_id,user_id,source_generation,detector_revision,level,detector_mode),
  FOREIGN KEY(submission_id,user_id,source_generation,detector_revision,level,detector_mode)
    REFERENCES platform_companion_name_submissions(id,user_id,generation,detector_revision,level,detector_mode) ON DELETE CASCADE,
  CHECK((revision=0 AND latest_publication_id IS NULL) OR (revision>0 AND latest_publication_id IS NOT NULL))
);
CREATE TABLE IF NOT EXISTS platform_companion_name_safety_publications (
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
    REFERENCES platform_companion_name_safety_responses(id,user_id,submission_id,source_generation,detector_revision,level,detector_mode) ON DELETE CASCADE,
  FOREIGN KEY(activation_user_id,activation_operation_id,asset_id,activation_kind)
    REFERENCES platform_safety_delivery_review_operations(user_id,operation_id,asset_id,kind) ON DELETE RESTRICT,
  CHECK(prepared_at=published_at AND retention_until>published_at AND evidence_retention_until>published_at),
  CHECK((level='L2' AND question_digest IS NOT NULL) OR (level='L1' AND question_digest IS NULL))
);
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='platform_companion_name_delivery_heads'::regclass AND conname='name_delivery_head_publication') THEN
    ALTER TABLE platform_companion_name_delivery_heads ADD CONSTRAINT name_delivery_head_publication
      FOREIGN KEY(latest_publication_id,user_id,submission_id,source_generation)
      REFERENCES platform_companion_name_safety_publications(id,user_id,submission_id,source_generation)
      DEFERRABLE INITIALLY DEFERRED;
  END IF;
END $$;
CREATE TABLE IF NOT EXISTS platform_companion_name_delivery_operations (
  user_id uuid NOT NULL REFERENCES platform_users(id) ON DELETE CASCADE,
  operation_id uuid NOT NULL, submission_id uuid NOT NULL, source_generation integer NOT NULL,
  publication_id uuid NOT NULL, kind text NOT NULL CHECK(kind IN ('publish','recover')),
  expected_edition integer NOT NULL CHECK(expected_edition BETWEEN 0 AND 2147483646),
  session_hash text NOT NULL CHECK(session_hash ~ '^[0-9a-f]{64}$'),
  payload_ciphertext bytea NOT NULL CHECK(octet_length(payload_ciphertext) BETWEEN 29 AND 65565),
  created_at timestamptz NOT NULL, PRIMARY KEY(user_id,operation_id),
  UNIQUE(user_id,operation_id,publication_id),
  FOREIGN KEY(publication_id,user_id,submission_id,source_generation)
    REFERENCES platform_companion_name_safety_publications(id,user_id,submission_id,source_generation) ON DELETE CASCADE
);
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='platform_companion_name_safety_publications'::regclass AND conname='name_delivery_publication_operation') THEN
    ALTER TABLE platform_companion_name_safety_publications ADD CONSTRAINT name_delivery_publication_operation
      FOREIGN KEY(user_id,publication_operation_id,id)
      REFERENCES platform_companion_name_delivery_operations(user_id,operation_id,publication_id) DEFERRABLE INITIALLY DEFERRED;
  END IF;
END $$;
CREATE TABLE IF NOT EXISTS platform_companion_name_safety_body_projections (
  id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES platform_users(id) ON DELETE CASCADE,
  publication_id uuid NOT NULL, edition integer NOT NULL, body_digest text NOT NULL,
  session_hash text NOT NULL CHECK(session_hash ~ '^[0-9a-f]{64}$'),
  issued_at timestamptz NOT NULL, payload_ciphertext bytea NOT NULL CHECK(octet_length(payload_ciphertext) BETWEEN 29 AND 131101),
  UNIQUE(id,user_id,publication_id,session_hash,body_digest),
  FOREIGN KEY(publication_id,user_id,edition,body_digest)
    REFERENCES platform_companion_name_safety_publications(id,user_id,edition,body_digest) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS platform_companion_name_safety_followup_states (
  publication_id uuid PRIMARY KEY REFERENCES platform_companion_name_safety_publications(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES platform_users(id) ON DELETE CASCADE,
  revision integer NOT NULL CHECK(revision BETWEEN 0 AND 2147483647), latest_operation_id uuid,
  journal_digest text NOT NULL CHECK(journal_digest ~ '^[0-9a-f]{64}$'),
  payload_ciphertext bytea NOT NULL CHECK(octet_length(payload_ciphertext) BETWEEN 29 AND 65565),
  FOREIGN KEY(publication_id,user_id) REFERENCES platform_companion_name_safety_publications(id,user_id) ON DELETE CASCADE,
  CHECK((revision=0 AND latest_operation_id IS NULL) OR (revision>0 AND latest_operation_id IS NOT NULL))
);
CREATE TABLE IF NOT EXISTS platform_companion_name_safety_followups (
  user_id uuid NOT NULL REFERENCES platform_users(id) ON DELETE CASCADE, operation_id uuid NOT NULL,
  publication_id uuid NOT NULL, submission_id uuid NOT NULL, source_generation integer NOT NULL,
  kind text NOT NULL CHECK(kind IN ('present_body','present_body_evidence','acknowledge','need_support','continue_naming','clarify_exaggeration')),
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
    REFERENCES platform_companion_name_safety_publications(id,user_id,submission_id,source_generation) ON DELETE CASCADE,
  FOREIGN KEY(body_projection_id,user_id,publication_id,session_hash,body_digest)
    REFERENCES platform_companion_name_safety_body_projections(id,user_id,publication_id,session_hash,body_digest) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY(user_id,presentation_operation_id,publication_id,session_hash,body_projection_id,presentation_digest,presentation_kind)
    REFERENCES platform_companion_name_safety_followups(user_id,operation_id,publication_id,session_hash,body_projection_id,presentation_digest,kind) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY(user_id,acknowledgment_operation_id,publication_id,session_hash,body_projection_id,presentation_digest,acknowledgment_kind)
    REFERENCES platform_companion_name_safety_followups(user_id,operation_id,publication_id,session_hash,body_projection_id,presentation_digest,kind) DEFERRABLE INITIALLY DEFERRED,
  CHECK((kind='need_support' AND body_projection_id IS NULL AND body_digest IS NULL AND presentation_digest IS NULL AND presentation_operation_id IS NULL AND acknowledgment_operation_id IS NULL AND presentation_kind IS NULL AND acknowledgment_kind IS NULL AND NOT handled AND clarified_at IS NULL)
    OR (kind='present_body_evidence' AND body_projection_id IS NOT NULL AND body_digest IS NOT NULL AND presentation_digest IS NULL AND presentation_operation_id IS NULL AND acknowledgment_operation_id IS NULL AND presentation_kind IS NULL AND acknowledgment_kind IS NULL AND NOT handled AND clarified_at IS NULL)
    OR (kind='present_body' AND body_projection_id IS NOT NULL AND body_digest IS NOT NULL AND presentation_digest IS NOT NULL AND presentation_operation_id IS NULL AND acknowledgment_operation_id IS NULL AND presentation_kind IS NULL AND acknowledgment_kind IS NULL AND NOT handled AND clarified_at IS NULL)
    OR (kind='acknowledge' AND body_projection_id IS NOT NULL AND body_digest IS NOT NULL AND presentation_digest IS NOT NULL AND presentation_operation_id IS NOT NULL AND presentation_kind IS NOT NULL AND presentation_kind='present_body' AND acknowledgment_operation_id IS NULL AND acknowledgment_kind IS NULL AND NOT handled AND clarified_at IS NULL)
    OR (kind IN ('continue_naming','clarify_exaggeration') AND body_projection_id IS NOT NULL AND body_digest IS NOT NULL AND presentation_digest IS NOT NULL AND presentation_operation_id IS NOT NULL AND acknowledgment_operation_id IS NOT NULL AND presentation_kind IS NOT NULL AND presentation_kind='present_body' AND acknowledgment_kind IS NOT NULL AND acknowledgment_kind='acknowledge' AND handled AND ((kind='continue_naming' AND clarified_at IS NULL) OR (kind='clarify_exaggeration' AND clarified_at IS NOT NULL AND clarified_at=created_at))))
);
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='platform_companion_name_safety_followup_states'::regclass AND conname='name_followup_state_head') THEN
    ALTER TABLE platform_companion_name_safety_followup_states ADD CONSTRAINT name_followup_state_head
      FOREIGN KEY(user_id,latest_operation_id,publication_id,revision)
      REFERENCES platform_companion_name_safety_followups(user_id,operation_id,publication_id,applied_revision) DEFERRABLE INITIALLY DEFERRED;
  END IF;
END $$;
CREATE TABLE IF NOT EXISTS platform_companion_name_safety_handled (
  submission_id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES platform_users(id) ON DELETE CASCADE,
  source_generation integer NOT NULL, detector_revision integer NOT NULL,
  level text NOT NULL CHECK(level IN ('L1','L2')), detector_mode text NOT NULL CHECK(detector_mode IN ('full','keyword_only')),
  publication_id uuid NOT NULL, operation_id uuid NOT NULL,
  kind text NOT NULL CHECK(kind IN ('continue_naming','clarify_exaggeration')),
  FOREIGN KEY(submission_id,user_id,source_generation,detector_revision,level,detector_mode)
    REFERENCES platform_companion_name_submissions(id,user_id,generation,detector_revision,level,detector_mode) ON DELETE CASCADE,
  FOREIGN KEY(user_id,operation_id,publication_id,submission_id,source_generation,kind)
    REFERENCES platform_companion_name_safety_followups(user_id,operation_id,publication_id,submission_id,source_generation,kind) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS platform_safety_question_scopes (
  user_id uuid NOT NULL REFERENCES platform_users(id) ON DELETE CASCADE,
  draft_id uuid NOT NULL REFERENCES platform_onboarding_drafts(id) ON DELETE CASCADE,
  revision integer NOT NULL CHECK(revision BETWEEN 0 AND 2147483647), latest_operation_id uuid,
  journal_digest text NOT NULL CHECK(journal_digest ~ '^[0-9a-f]{64}$'),
  payload_ciphertext bytea NOT NULL CHECK(octet_length(payload_ciphertext) BETWEEN 29 AND 131101),
  PRIMARY KEY(user_id,draft_id),
  FOREIGN KEY(draft_id,user_id) REFERENCES platform_onboarding_drafts(id,user_id) ON DELETE CASCADE,
  CHECK((revision=0 AND latest_operation_id IS NULL) OR (revision>0 AND latest_operation_id IS NOT NULL))
);
CREATE TABLE IF NOT EXISTS platform_safety_question_occurrences (
  id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES platform_users(id) ON DELETE CASCADE,
  draft_id uuid NOT NULL, publication_id uuid NOT NULL, submission_id uuid NOT NULL, source_generation integer NOT NULL,
  occurrence integer NOT NULL CHECK(occurrence>0), generation integer NOT NULL CHECK(generation>0),
  phase text NOT NULL CHECK(phase IN ('reserved','claimed','declared')),
  reservation_id uuid NOT NULL, reservation_digest text NOT NULL CHECK(reservation_digest ~ '^[0-9a-f]{64}$'),
  session_hash text NOT NULL CHECK(session_hash ~ '^[0-9a-f]{64}$'), render_owner_id uuid NOT NULL,
  reserved_until timestamptz NOT NULL, display_until timestamptz, evidence_until timestamptz,
  grant_id uuid, grant_digest text CHECK(grant_digest ~ '^[0-9a-f]{64}$'),
  question_digest text NOT NULL CHECK(question_digest ~ '^[0-9a-f]{64}$'),
  claimed_at timestamptz, receipt_received_at timestamptz,
  UNIQUE(submission_id,source_generation,occurrence),
  UNIQUE(id,user_id,draft_id),
  FOREIGN KEY(user_id,draft_id) REFERENCES platform_safety_question_scopes(user_id,draft_id) ON DELETE CASCADE,
  FOREIGN KEY(publication_id,user_id,submission_id,source_generation)
    REFERENCES platform_companion_name_safety_publications(id,user_id,submission_id,source_generation) ON DELETE CASCADE,
  FOREIGN KEY(publication_id,user_id,submission_id,source_generation,draft_id,question_digest)
    REFERENCES platform_companion_name_safety_publications(id,user_id,submission_id,source_generation,logical_draft_id,question_digest) ON DELETE CASCADE,
  CHECK((phase='reserved' AND display_until IS NULL AND evidence_until IS NULL AND grant_id IS NULL AND grant_digest IS NULL AND claimed_at IS NULL AND receipt_received_at IS NULL)
    OR (phase='claimed' AND display_until IS NOT NULL AND evidence_until IS NOT NULL AND grant_id IS NOT NULL AND grant_digest IS NOT NULL AND claimed_at IS NOT NULL AND receipt_received_at IS NULL)
    OR (phase='declared' AND display_until IS NOT NULL AND evidence_until IS NOT NULL AND grant_id IS NOT NULL AND grant_digest IS NOT NULL AND claimed_at IS NOT NULL AND receipt_received_at IS NOT NULL AND receipt_received_at>=claimed_at))
);
CREATE TABLE IF NOT EXISTS platform_safety_question_operations (
  user_id uuid NOT NULL REFERENCES platform_users(id) ON DELETE CASCADE,
  operation_id uuid NOT NULL, draft_id uuid NOT NULL, occurrence_id uuid NOT NULL,
  kind text NOT NULL CHECK(kind IN ('reserve','claim','present')),
  expected_revision integer NOT NULL CHECK(expected_revision BETWEEN 0 AND 2147483646),
  applied_revision integer NOT NULL CHECK(applied_revision=expected_revision+1),
  session_hash text NOT NULL CHECK(session_hash ~ '^[0-9a-f]{64}$'), render_owner_id uuid NOT NULL,
  previous_digest text NOT NULL CHECK(previous_digest ~ '^[0-9a-f]{64}$'),
  journal_digest text NOT NULL CHECK(journal_digest ~ '^[0-9a-f]{64}$'),
  payload_ciphertext bytea NOT NULL CHECK(octet_length(payload_ciphertext) BETWEEN 29 AND 131101),
  created_at timestamptz NOT NULL,
  PRIMARY KEY(user_id,operation_id), UNIQUE(user_id,draft_id,applied_revision),
  UNIQUE(user_id,operation_id,draft_id,applied_revision),
  FOREIGN KEY(occurrence_id,user_id,draft_id) REFERENCES platform_safety_question_occurrences(id,user_id,draft_id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY(user_id,draft_id) REFERENCES platform_safety_question_scopes(user_id,draft_id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS safety_question_one_declaration ON platform_safety_question_operations(occurrence_id) WHERE kind='present';
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='platform_safety_question_scopes'::regclass AND conname='safety_question_scope_head') THEN
    ALTER TABLE platform_safety_question_scopes ADD CONSTRAINT safety_question_scope_head
      FOREIGN KEY(user_id,latest_operation_id,draft_id,revision)
      REFERENCES platform_safety_question_operations(user_id,operation_id,draft_id,applied_revision) DEFERRABLE INITIALLY DEFERRED;
  END IF;
END $$;
CREATE TABLE IF NOT EXISTS platform_safety_legacy_exposures (
  user_id uuid NOT NULL REFERENCES platform_users(id) ON DELETE CASCADE,
  draft_id uuid NOT NULL REFERENCES platform_onboarding_drafts(id) ON DELETE CASCADE,
  publication_id uuid NOT NULL, recorded_at timestamptz NOT NULL,
  payload_ciphertext bytea NOT NULL CHECK(octet_length(payload_ciphertext) BETWEEN 29 AND 65565),
  PRIMARY KEY(user_id,publication_id),
  FOREIGN KEY(publication_id,user_id,draft_id) REFERENCES platform_onboarding_safety_publications(id,user_id,draft_id) ON DELETE CASCADE
);

-- Independent, one-way anchors on the authentic roots. Legacy NULL is not
-- backfilled; only the first real same-transaction publication/scope sets it.
-- Deleting new sidecars or resetting a plaintext pointer cannot erase history.
ALTER TABLE platform_companion_name_submissions ADD COLUMN IF NOT EXISTS first_safety_publication_id uuid;
ALTER TABLE platform_onboarding_drafts ADD COLUMN IF NOT EXISTS name_question_scope_draft_id uuid;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='platform_companion_name_submissions'::regclass AND conname='name_first_safety_publication') THEN
    ALTER TABLE platform_companion_name_submissions ADD CONSTRAINT name_first_safety_publication
      FOREIGN KEY(first_safety_publication_id,user_id,id,generation)
      REFERENCES platform_companion_name_safety_publications(id,user_id,submission_id,source_generation) DEFERRABLE INITIALLY DEFERRED;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='platform_onboarding_drafts'::regclass AND conname='name_question_scope_anchor') THEN
    ALTER TABLE platform_onboarding_drafts ADD CONSTRAINT name_question_scope_anchor
      FOREIGN KEY(user_id,name_question_scope_draft_id) REFERENCES platform_safety_question_scopes(user_id,draft_id) DEFERRABLE INITIALLY DEFERRED;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='platform_onboarding_drafts'::regclass AND conname='name_question_scope_same_draft') THEN
    ALTER TABLE platform_onboarding_drafts ADD CONSTRAINT name_question_scope_same_draft CHECK(name_question_scope_draft_id IS NULL OR name_question_scope_draft_id=id);
  END IF;
END $$;
CREATE OR REPLACE FUNCTION platform_preserve_name_publication_anchor() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  IF OLD.first_safety_publication_id IS NOT NULL AND NEW.first_safety_publication_id IS DISTINCT FROM OLD.first_safety_publication_id THEN
    RAISE EXCEPTION 'Name resource history anchor is immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION platform_preserve_name_question_anchor() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  IF OLD.name_question_scope_draft_id IS NOT NULL AND NEW.name_question_scope_draft_id IS DISTINCT FROM OLD.name_question_scope_draft_id THEN
    RAISE EXCEPTION 'Question scope history anchor is immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid='platform_companion_name_submissions'::regclass AND tgname='preserve_name_publication_anchor' AND NOT tgisinternal) THEN
    CREATE TRIGGER preserve_name_publication_anchor BEFORE UPDATE ON platform_companion_name_submissions FOR EACH ROW EXECUTE FUNCTION platform_preserve_name_publication_anchor();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid='platform_onboarding_drafts'::regclass AND tgname='preserve_name_question_anchor' AND NOT tgisinternal) THEN
    CREATE TRIGGER preserve_name_question_anchor BEFORE UPDATE ON platform_onboarding_drafts FOR EACH ROW EXECUTE FUNCTION platform_preserve_name_question_anchor();
  END IF;
END $$;
