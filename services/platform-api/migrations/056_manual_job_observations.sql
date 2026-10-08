-- Manual text is never evidence of a live posting or a model classification.
CREATE TABLE IF NOT EXISTS platform_career_job_observation_operations (
 user_id uuid NOT NULL REFERENCES platform_users(id) ON DELETE CASCADE,
 operation_id uuid NOT NULL,observation_id uuid NOT NULL,
 action text NOT NULL CHECK(action IN ('create','delete')),
 applied_revision integer NOT NULL CHECK(applied_revision IN (1,2)),created_at timestamptz NOT NULL,
 receipt_ciphertext bytea NOT NULL CHECK(octet_length(receipt_ciphertext)>=29),
 PRIMARY KEY(user_id,operation_id),UNIQUE(user_id,observation_id,applied_revision),
 UNIQUE(user_id,operation_id,observation_id,applied_revision));
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgname='manual_job_operation_immutable' AND tgrelid='platform_career_job_observation_operations'::regclass) THEN
  CREATE TRIGGER manual_job_operation_immutable BEFORE UPDATE OR DELETE ON platform_career_job_observation_operations
   FOR EACH ROW EXECUTE FUNCTION shared_memory_keep_receipt();
 END IF;
END $$;
CREATE TABLE IF NOT EXISTS platform_career_job_observations (
 id uuid PRIMARY KEY,user_id uuid NOT NULL REFERENCES platform_users(id) ON DELETE CASCADE,
 source text NOT NULL CHECK(source='manual'),state text NOT NULL CHECK(state='unknown'),
 revision integer NOT NULL CHECK(revision=1),last_operation_id uuid NOT NULL,
 observed_at timestamptz NOT NULL,checked_at timestamptz NOT NULL CHECK(checked_at=observed_at),
 created_at timestamptz NOT NULL CHECK(created_at=observed_at),updated_at timestamptz NOT NULL CHECK(updated_at=created_at),
 record_ciphertext bytea NOT NULL CHECK(octet_length(record_ciphertext)>=29),UNIQUE(id,user_id),
 FOREIGN KEY(user_id,last_operation_id,id,revision) REFERENCES platform_career_job_observation_operations(user_id,operation_id,observation_id,applied_revision));
CREATE INDEX IF NOT EXISTS manual_job_owner_page ON platform_career_job_observations(user_id,observed_at DESC,id DESC);
