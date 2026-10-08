-- Owner-entered facts and stories; no model proposal or mentor review is seeded.
CREATE TABLE IF NOT EXISTS platform_career_library_operations (
 user_id uuid NOT NULL REFERENCES platform_users(id) ON DELETE CASCADE,operation_id uuid NOT NULL,
 record_kind text NOT NULL CHECK(record_kind IN ('project','story')),record_id uuid NOT NULL,
 action text NOT NULL CHECK(action IN ('create','edit','confirm','withdraw','delete')),
 applied_revision integer NOT NULL CHECK(applied_revision>0),created_at timestamptz NOT NULL,
 receipt_ciphertext bytea NOT NULL CHECK(octet_length(receipt_ciphertext)>=29),
 PRIMARY KEY(user_id,operation_id),UNIQUE(user_id,record_kind,record_id,applied_revision),
 UNIQUE(user_id,operation_id,record_kind,record_id,applied_revision));
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgname='career_library_operation_immutable' AND tgrelid='platform_career_library_operations'::regclass) THEN
 CREATE TRIGGER career_library_operation_immutable BEFORE UPDATE OR DELETE ON platform_career_library_operations FOR EACH ROW EXECUTE FUNCTION shared_memory_keep_receipt();
 END IF;
END $$;
CREATE TABLE IF NOT EXISTS platform_career_evidence (
 id uuid PRIMARY KEY,user_id uuid NOT NULL REFERENCES platform_users(id) ON DELETE CASCADE,
 record_kind text NOT NULL DEFAULT 'project' CHECK(record_kind='project'),kind text NOT NULL CHECK(kind='project'),
 state text NOT NULL CHECK(state IN ('active','withdrawn')),withdrawn_at timestamptz,
 mentor_review jsonb CHECK(mentor_review IS NULL),CHECK((state='active' AND withdrawn_at IS NULL) OR (state='withdrawn' AND withdrawn_at IS NOT NULL)),
 verification text NOT NULL CHECK(verification IN ('self_reported','user_confirmed')),
 sensitivity text NOT NULL CHECK(sensitivity IN ('normal','sensitive','restricted')),
 revision integer NOT NULL CHECK(revision>0),last_operation_id uuid NOT NULL,
 record_ciphertext bytea NOT NULL CHECK(octet_length(record_ciphertext)>=29),created_at timestamptz NOT NULL,updated_at timestamptz NOT NULL CHECK(updated_at>=created_at),
 FOREIGN KEY(user_id,last_operation_id,record_kind,id,revision) REFERENCES platform_career_library_operations(user_id,operation_id,record_kind,record_id,applied_revision));
CREATE INDEX IF NOT EXISTS career_project_owner_page ON platform_career_evidence(user_id,created_at DESC,id DESC);
CREATE TABLE IF NOT EXISTS platform_career_stories (
 id uuid PRIMARY KEY,user_id uuid NOT NULL REFERENCES platform_users(id) ON DELETE CASCADE,
 record_kind text NOT NULL DEFAULT 'story' CHECK(record_kind='story'),status text NOT NULL CHECK(status IN ('draft','confirmed')),
 sensitivity text NOT NULL CHECK(sensitivity IN ('normal','sensitive','restricted')),
 revision integer NOT NULL CHECK(revision>0),last_operation_id uuid NOT NULL,
 record_ciphertext bytea NOT NULL CHECK(octet_length(record_ciphertext)>=29),created_at timestamptz NOT NULL,updated_at timestamptz NOT NULL CHECK(updated_at>=created_at),
 FOREIGN KEY(user_id,last_operation_id,record_kind,id,revision) REFERENCES platform_career_library_operations(user_id,operation_id,record_kind,record_id,applied_revision));
CREATE INDEX IF NOT EXISTS career_story_owner_page ON platform_career_stories(user_id,created_at DESC,id DESC);
