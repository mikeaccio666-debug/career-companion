-- Actual owner-entered interview schedules; payloads remain encrypted.
CREATE TABLE IF NOT EXISTS platform_career_interview_operations (
 user_id uuid NOT NULL REFERENCES platform_users(id) ON DELETE CASCADE,
 operation_id uuid NOT NULL,interview_id uuid NOT NULL,
 action text NOT NULL CHECK(action IN ('create','edit','reschedule','status','delete')),
 applied_revision integer NOT NULL CHECK(applied_revision>=1),created_at timestamptz NOT NULL,
 receipt_ciphertext bytea NOT NULL CHECK(octet_length(receipt_ciphertext)>=29),
 PRIMARY KEY(user_id,operation_id),UNIQUE(user_id,interview_id,applied_revision),
 UNIQUE(user_id,operation_id,interview_id,applied_revision));
CREATE TABLE IF NOT EXISTS platform_career_interviews (
 id uuid PRIMARY KEY,user_id uuid NOT NULL REFERENCES platform_users(id) ON DELETE CASCADE,
 application_id uuid NOT NULL,revision integer NOT NULL CHECK(revision>=1),last_operation_id uuid NOT NULL,
 status text NOT NULL CHECK(status IN ('scheduled','rescheduled','done','cancelled')),
 created_at timestamptz NOT NULL,updated_at timestamptz NOT NULL CHECK(updated_at>=created_at),
 record_ciphertext bytea NOT NULL CHECK(octet_length(record_ciphertext)>=29),UNIQUE(id,user_id),
 FOREIGN KEY(user_id,last_operation_id,id,revision) REFERENCES platform_career_interview_operations(user_id,operation_id,interview_id,applied_revision));
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgname='career_interview_operation_immutable' AND tgrelid='platform_career_interview_operations'::regclass) THEN
  CREATE TRIGGER career_interview_operation_immutable BEFORE UPDATE OR DELETE ON platform_career_interview_operations FOR EACH ROW EXECUTE FUNCTION shared_memory_keep_receipt();
 END IF;
END $$;
CREATE INDEX IF NOT EXISTS career_interview_owner_page ON platform_career_interviews(user_id,created_at DESC,id DESC);
COMMENT ON COLUMN platform_career_interviews.application_id IS 'Verified owned application coordinate at creation. Encrypted minimal historical company/role reference remains independent of later application removal; no JD body or private note.';
COMMENT ON TABLE platform_career_interview_operations IS 'Immutable encrypted content-free coordinates/digests only. Observing or replaying a removed interview never restores payloads. Account deletion cascades receipts.';
