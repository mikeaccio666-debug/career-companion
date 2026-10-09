-- User choices are immutable encrypted revisions, never inferred browser defaults.
CREATE TABLE IF NOT EXISTS platform_today_rest (
 user_id uuid NOT NULL REFERENCES platform_users(id) ON DELETE CASCADE,
 companion_id uuid NOT NULL, revision integer NOT NULL CHECK(revision>0), operation_id uuid NOT NULL,
 record_ciphertext bytea NOT NULL CHECK(octet_length(record_ciphertext)>=29), created_at timestamptz NOT NULL,
 PRIMARY KEY(user_id,companion_id,revision), UNIQUE(user_id,operation_id),
 FOREIGN KEY(companion_id,user_id) REFERENCES platform_companions(id,user_id) ON DELETE CASCADE
);
DROP TRIGGER IF EXISTS today_rest_immutable ON platform_today_rest;
CREATE TRIGGER today_rest_immutable BEFORE UPDATE OR DELETE ON platform_today_rest
 FOR EACH ROW EXECUTE FUNCTION shared_memory_keep_receipt();
