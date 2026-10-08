-- P0 owner-authored originals. No expert drafts or delivery executors.
CREATE TABLE IF NOT EXISTS platform_pending_item_operations (
 user_id uuid NOT NULL REFERENCES platform_users(id) ON DELETE CASCADE,operation_id uuid NOT NULL,item_id uuid NOT NULL,
 action text NOT NULL CHECK(action IN ('create','edit','approve','decline','reopen','archive','delete','expire','supersede')),
 generation integer NOT NULL CHECK(generation>0),created_at timestamptz NOT NULL,receipt_ciphertext bytea NOT NULL CHECK(octet_length(receipt_ciphertext)>=29),
 PRIMARY KEY(user_id,operation_id),UNIQUE(user_id,item_id,generation),UNIQUE(user_id,operation_id,item_id,generation));
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgname='pending_operation_immutable' AND tgrelid='platform_pending_item_operations'::regclass) THEN
 CREATE TRIGGER pending_operation_immutable BEFORE UPDATE OR DELETE ON platform_pending_item_operations FOR EACH ROW EXECUTE FUNCTION shared_memory_keep_receipt(); END IF;
END $$;
CREATE TABLE IF NOT EXISTS platform_pending_items (
 id uuid PRIMARY KEY,user_id uuid NOT NULL REFERENCES platform_users(id) ON DELETE CASCADE,kind text NOT NULL CHECK(kind='resume_version'),
 status text NOT NULL CHECK(status IN ('pending','approved','declined','expired','superseded')),final_action text NOT NULL CHECK(final_action='none'),
 track text NOT NULL CHECK(track IN ('swe','mle','ds','da','de','hw','other')),current_revision integer NOT NULL CHECK(current_revision>0),
 generation integer NOT NULL CHECK(generation>=current_revision),last_operation_id uuid NOT NULL,record_ciphertext bytea NOT NULL CHECK(octet_length(record_ciphertext)>=29),
 created_at timestamptz NOT NULL,updated_at timestamptz NOT NULL CHECK(updated_at>=created_at),expires_at timestamptz NOT NULL,
 UNIQUE(user_id,id),FOREIGN KEY(user_id,last_operation_id,id,generation) REFERENCES platform_pending_item_operations(user_id,operation_id,item_id,generation) DEFERRABLE INITIALLY DEFERRED);
CREATE TABLE IF NOT EXISTS platform_pending_item_revisions (
 user_id uuid NOT NULL,item_id uuid NOT NULL,revision integer NOT NULL CHECK(revision>0),ciphertext bytea NOT NULL CHECK(octet_length(ciphertext)>=29),
 payload_digest text NOT NULL CHECK(payload_digest ~ '^[0-9a-f]{64}$'),author text NOT NULL CHECK(author='user'),base_revision integer,created_at timestamptz NOT NULL,
 PRIMARY KEY(user_id,item_id,revision),FOREIGN KEY(user_id,item_id) REFERENCES platform_pending_items(user_id,id) ON DELETE CASCADE);
CREATE TABLE IF NOT EXISTS platform_pending_item_decisions (
 user_id uuid NOT NULL,item_id uuid NOT NULL,operation_id uuid NOT NULL,generation integer NOT NULL,
 revision integer NOT NULL CHECK(revision>0),payload_digest text NOT NULL CHECK(payload_digest ~ '^[0-9a-f]{64}$'),
 decision text NOT NULL CHECK(decision IN ('approved','declined')),channel text NOT NULL CHECK(channel='web'),created_at timestamptz NOT NULL,
 PRIMARY KEY(user_id,operation_id),FOREIGN KEY(user_id,item_id) REFERENCES platform_pending_items(user_id,id) ON DELETE CASCADE,
 FOREIGN KEY(user_id,operation_id,item_id,generation) REFERENCES platform_pending_item_operations(user_id,operation_id,item_id,generation) DEFERRABLE INITIALLY DEFERRED);
CREATE OR REPLACE FUNCTION pending_revision_immutable() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF TG_OP='UPDATE' OR EXISTS(SELECT 1 FROM platform_pending_items WHERE id=OLD.item_id AND user_id=OLD.user_id) THEN
 RAISE EXCEPTION 'Pending history is immutable'; END IF; RETURN OLD; END $$;
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgname='pending_revision_immutable' AND tgrelid='platform_pending_item_revisions'::regclass) THEN
 CREATE TRIGGER pending_revision_immutable BEFORE UPDATE OR DELETE ON platform_pending_item_revisions FOR EACH ROW EXECUTE FUNCTION pending_revision_immutable(); END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgname='pending_decision_immutable' AND tgrelid='platform_pending_item_decisions'::regclass) THEN
 CREATE TRIGGER pending_decision_immutable BEFORE UPDATE OR DELETE ON platform_pending_item_decisions FOR EACH ROW EXECUTE FUNCTION pending_revision_immutable(); END IF;
END $$;
CREATE TABLE IF NOT EXISTS platform_career_resume_counters (
 user_id uuid NOT NULL REFERENCES platform_users(id) ON DELETE CASCADE,track text NOT NULL,sequence integer NOT NULL CHECK(sequence>0),PRIMARY KEY(user_id,track));
CREATE TABLE IF NOT EXISTS platform_career_resume_versions (
 id uuid PRIMARY KEY,user_id uuid NOT NULL REFERENCES platform_users(id) ON DELETE CASCADE,pending_item_id uuid NOT NULL UNIQUE,
 track text NOT NULL CHECK(track IN ('swe','mle','ds','da','de','hw','other')),status text NOT NULL CHECK(status IN ('draft','active','archived')),
 source text NOT NULL CHECK(source IN ('paste','derived')),upload_id uuid CHECK(upload_id IS NULL),revision integer NOT NULL CHECK(revision>0),
 content_digest text NOT NULL CHECK(content_digest ~ '^[0-9a-f]{64}$'),created_at timestamptz NOT NULL,updated_at timestamptz NOT NULL,
 FOREIGN KEY(user_id,pending_item_id) REFERENCES platform_pending_items(user_id,id) ON DELETE CASCADE);
CREATE INDEX IF NOT EXISTS pending_owner_page ON platform_pending_items(user_id,created_at DESC,id DESC);
CREATE INDEX IF NOT EXISTS resume_owner_track ON platform_career_resume_versions(user_id,track,created_at DESC,id DESC);
