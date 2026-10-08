-- Owner recording only. No packet, execution authority or invented overlay.
CREATE TABLE IF NOT EXISTS platform_career_application_operations (
 user_id uuid NOT NULL REFERENCES platform_users(id) ON DELETE CASCADE,
 operation_id uuid NOT NULL,application_id uuid NOT NULL,action text NOT NULL CHECK(action IN ('create','stage','edit','delete')),
 applied_revision integer NOT NULL CHECK(applied_revision>=1),created_at timestamptz NOT NULL,
 receipt_ciphertext bytea NOT NULL CHECK(octet_length(receipt_ciphertext)>=29),
 PRIMARY KEY(user_id,operation_id),UNIQUE(user_id,application_id,applied_revision),UNIQUE(user_id,operation_id,application_id,applied_revision));
CREATE TABLE IF NOT EXISTS platform_career_application_events (
 user_id uuid NOT NULL REFERENCES platform_users(id) ON DELETE CASCADE,id uuid NOT NULL,application_id uuid NOT NULL,
 revision integer NOT NULL CHECK(revision>=1),action text NOT NULL CHECK(action IN ('create','stage','edit','delete')),
 created_at timestamptz NOT NULL,care_until timestamptz CHECK(care_until IS NULL OR care_until=created_at+interval '48 hours'),
 event_ciphertext bytea NOT NULL CHECK(octet_length(event_ciphertext)>=29),
 PRIMARY KEY(user_id,id),UNIQUE(user_id,application_id,revision),
 FOREIGN KEY(user_id,id,application_id,revision) REFERENCES platform_career_application_operations(user_id,operation_id,application_id,applied_revision));
CREATE TABLE IF NOT EXISTS platform_career_applications (
 id uuid PRIMARY KEY,user_id uuid NOT NULL REFERENCES platform_users(id) ON DELETE CASCADE,
 job_observation_id uuid NOT NULL,revision integer NOT NULL CHECK(revision>=1),last_operation_id uuid NOT NULL,
 stage text NOT NULL CHECK(stage IN ('saved','applied','oa','interview','offer','closed')),
 created_at timestamptz NOT NULL,updated_at timestamptz NOT NULL CHECK(updated_at>=created_at),
 record_ciphertext bytea NOT NULL CHECK(octet_length(record_ciphertext)>=29),UNIQUE(id,user_id),UNIQUE(user_id,job_observation_id),
 FOREIGN KEY(user_id,last_operation_id,id,revision) REFERENCES platform_career_application_operations(user_id,operation_id,application_id,applied_revision));
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgname='career_application_operation_immutable' AND tgrelid='platform_career_application_operations'::regclass) THEN
  CREATE TRIGGER career_application_operation_immutable BEFORE UPDATE OR DELETE ON platform_career_application_operations FOR EACH ROW EXECUTE FUNCTION shared_memory_keep_receipt();
 END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgname='career_application_event_immutable' AND tgrelid='platform_career_application_events'::regclass) THEN
  CREATE TRIGGER career_application_event_immutable BEFORE UPDATE OR DELETE ON platform_career_application_events FOR EACH ROW EXECUTE FUNCTION shared_memory_keep_receipt();
 END IF;
END $$;
CREATE INDEX IF NOT EXISTS career_application_owner_page ON platform_career_applications(user_id,created_at DESC,id DESC);
CREATE INDEX IF NOT EXISTS career_application_care_sources ON platform_career_application_events(user_id,care_until) WHERE care_until IS NOT NULL;
COMMENT ON COLUMN platform_career_applications.job_observation_id IS 'Original owned snapshot coordinate, independent after source deletion. Not a current JD or tool grant.';
COMMENT ON TABLE platform_career_application_events IS 'Minimal encrypted append-only events and care sources, without job body or private notes. Physical application deletion keeps inaccessible tombstones/care proof until account deletion.';
