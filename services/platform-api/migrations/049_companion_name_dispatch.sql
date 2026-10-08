-- New accepted raw naming intents only. No legacy adoption, live-session FK,
-- detector/review seed, decision, model usage or execution permission is minted.
ALTER TABLE platform_companion_name_submissions ADD COLUMN IF NOT EXISTS first_name_dispatch_id uuid;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='companion_name_dispatch_source_coordinates' AND conrelid='platform_companion_name_submissions'::regclass) THEN
    ALTER TABLE platform_companion_name_submissions ADD CONSTRAINT companion_name_dispatch_source_coordinates
      UNIQUE(id,user_id,operation_id,entry_id,task_id,companion_id,preview_revision,submitted_revision,expected_identity_revision,submitted_auth_version,application_operation_id);
  END IF;
END $$;
CREATE TABLE IF NOT EXISTS platform_companion_name_dispatches (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES platform_users(id) ON DELETE CASCADE,
  submission_id uuid NOT NULL UNIQUE, operation_id uuid NOT NULL,
  entry_id uuid NOT NULL, task_id uuid NOT NULL, companion_id uuid NOT NULL,
  preview_revision integer NOT NULL CHECK(preview_revision=1),
  submitted_revision integer NOT NULL CHECK(submitted_revision BETWEEN 1 AND 2147483647),
  expected_identity_revision integer NOT NULL CHECK(expected_identity_revision BETWEEN 0 AND 2147483646),
  submitted_auth_version bigint NOT NULL CHECK(submitted_auth_version>=0), application_operation_id uuid NOT NULL,
  payload_digest text NOT NULL CHECK(payload_digest ~ '^[0-9a-f]{64}$'),
  payload_ciphertext bytea NOT NULL CHECK(octet_length(payload_ciphertext) BETWEEN 29 AND 65565),
  revision integer NOT NULL DEFAULT 0 CHECK(revision BETWEEN 0 AND 2147483647),
  last_operation_id uuid, state_ciphertext bytea NOT NULL CHECK(octet_length(state_ciphertext) BETWEEN 29 AND 65565),
  accepted_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(user_id,operation_id), UNIQUE(id,user_id,task_id,submission_id), UNIQUE(id,user_id,submission_id),
  FOREIGN KEY(submission_id,user_id,operation_id,entry_id,task_id,companion_id,preview_revision,submitted_revision,expected_identity_revision,submitted_auth_version,application_operation_id)
    REFERENCES platform_companion_name_submissions(id,user_id,operation_id,entry_id,task_id,companion_id,preview_revision,submitted_revision,expected_identity_revision,submitted_auth_version,application_operation_id) ON DELETE CASCADE,
  CHECK((revision=0 AND last_operation_id IS NULL) OR (revision>0 AND last_operation_id IS NOT NULL))
);
CREATE TABLE IF NOT EXISTS platform_companion_name_dispatch_outbox (
  dispatch_id uuid PRIMARY KEY, user_id uuid NOT NULL, task_id uuid NOT NULL, submission_id uuid NOT NULL,
  dispatched_at timestamptz, held_reason text CHECK(held_reason IN ('authorization','configuration','requires_review','storage','terminal')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY(dispatch_id,user_id,task_id,submission_id)
    REFERENCES platform_companion_name_dispatches(id,user_id,task_id,submission_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS companion_name_dispatch_pending ON platform_companion_name_dispatch_outbox(dispatched_at,dispatch_id);
CREATE TABLE IF NOT EXISTS platform_companion_name_dispatch_operations (
  id uuid PRIMARY KEY, dispatch_id uuid NOT NULL, user_id uuid NOT NULL, submission_id uuid NOT NULL,
  revision integer NOT NULL CHECK(revision BETWEEN 1 AND 2147483647),
  kind text NOT NULL CHECK(kind IN ('claim','recover','start','hold','detected','application','resource')),
  generation integer, lease_token uuid, execution_token uuid,
  previous_digest text NOT NULL CHECK(previous_digest ~ '^[0-9a-f]{64}$'),
  payload_digest text NOT NULL CHECK(payload_digest ~ '^[0-9a-f]{64}$'),
  payload_ciphertext bytea NOT NULL CHECK(octet_length(payload_ciphertext) BETWEEN 29 AND 65565),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(dispatch_id,revision), UNIQUE(id,dispatch_id,user_id,revision),
  FOREIGN KEY(dispatch_id,user_id,submission_id) REFERENCES platform_companion_name_dispatches(id,user_id,submission_id) ON DELETE CASCADE,
  FOREIGN KEY(submission_id,user_id,generation) REFERENCES platform_companion_name_submissions(id,user_id,generation) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
  CHECK((kind IN ('claim','recover') AND generation IS NOT NULL AND generation>0 AND lease_token IS NOT NULL AND execution_token IS NULL)
    OR (kind='start' AND generation IS NOT NULL AND generation>0 AND lease_token IS NOT NULL AND execution_token IS NOT NULL)
    OR (kind IN ('hold','detected','application','resource') AND generation IS NULL AND lease_token IS NULL AND execution_token IS NULL))
);
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='companion_name_first_dispatch_anchor' AND conrelid='platform_companion_name_submissions'::regclass) THEN
    ALTER TABLE platform_companion_name_submissions ADD CONSTRAINT companion_name_first_dispatch_anchor
      FOREIGN KEY(first_name_dispatch_id,user_id,id) REFERENCES platform_companion_name_dispatches(id,user_id,submission_id) DEFERRABLE INITIALLY DEFERRED;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='companion_name_dispatch_actual_tip' AND conrelid='platform_companion_name_dispatches'::regclass) THEN
    ALTER TABLE platform_companion_name_dispatches ADD CONSTRAINT companion_name_dispatch_actual_tip
      FOREIGN KEY(last_operation_id,id,user_id,revision) REFERENCES platform_companion_name_dispatch_operations(id,dispatch_id,user_id,revision) DEFERRABLE INITIALLY DEFERRED;
  END IF;
END $$;
CREATE OR REPLACE FUNCTION companion_name_dispatch_source_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS(SELECT 1 FROM platform_users WHERE id=OLD.user_id) AND OLD.first_name_dispatch_id IS NOT NULL
    AND (TG_OP='DELETE' OR NEW.first_name_dispatch_id IS DISTINCT FROM OLD.first_name_dispatch_id) THEN
    RAISE EXCEPTION 'Accepted name dispatch anchor is immutable' USING ERRCODE='23514';
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF; RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION companion_name_dispatch_history_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS(SELECT 1 FROM platform_users WHERE id=OLD.user_id) THEN
    IF TG_OP='DELETE' OR TG_TABLE_NAME='platform_companion_name_dispatch_operations' THEN
      RAISE EXCEPTION 'Accepted name dispatch history is immutable' USING ERRCODE='23514';
    END IF;
    IF ROW(NEW.id,NEW.user_id,NEW.submission_id,NEW.operation_id,NEW.entry_id,NEW.task_id,NEW.companion_id,NEW.preview_revision,NEW.submitted_revision,NEW.expected_identity_revision,NEW.submitted_auth_version,NEW.application_operation_id,NEW.payload_digest,NEW.payload_ciphertext,NEW.accepted_at)
      IS DISTINCT FROM ROW(OLD.id,OLD.user_id,OLD.submission_id,OLD.operation_id,OLD.entry_id,OLD.task_id,OLD.companion_id,OLD.preview_revision,OLD.submitted_revision,OLD.expected_identity_revision,OLD.submitted_auth_version,OLD.application_operation_id,OLD.payload_digest,OLD.payload_ciphertext,OLD.accepted_at)
      OR NEW.revision<>OLD.revision+1 OR NEW.last_operation_id IS NULL OR NEW.last_operation_id IS NOT DISTINCT FROM OLD.last_operation_id THEN
      RAISE EXCEPTION 'Accepted name dispatch revision is not append only' USING ERRCODE='23514';
    END IF;
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF; RETURN NEW;
END $$;
-- Separate operation guard avoids accessing dispatch-only fields in a row trigger.
CREATE OR REPLACE FUNCTION companion_name_dispatch_operation_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS(SELECT 1 FROM platform_users WHERE id=OLD.user_id) THEN
    RAISE EXCEPTION 'Accepted name dispatch operation is immutable' USING ERRCODE='23514';
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF; RETURN NEW;
END $$;
DO $$ BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgname='companion_name_dispatch_source_anchor_guard' AND tgrelid='platform_companion_name_submissions'::regclass) THEN
    CREATE TRIGGER companion_name_dispatch_source_anchor_guard BEFORE UPDATE OR DELETE ON platform_companion_name_submissions FOR EACH ROW EXECUTE FUNCTION companion_name_dispatch_source_guard();
  END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgname='companion_name_dispatch_append_guard' AND tgrelid='platform_companion_name_dispatches'::regclass) THEN
    CREATE TRIGGER companion_name_dispatch_append_guard BEFORE UPDATE OR DELETE ON platform_companion_name_dispatches FOR EACH ROW EXECUTE FUNCTION companion_name_dispatch_history_guard();
  END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgname='companion_name_dispatch_operation_append_guard' AND tgrelid='platform_companion_name_dispatch_operations'::regclass) THEN
    CREATE TRIGGER companion_name_dispatch_operation_append_guard BEFORE UPDATE OR DELETE ON platform_companion_name_dispatch_operations FOR EACH ROW EXECUTE FUNCTION companion_name_dispatch_operation_guard();
  END IF;
END $$;
