-- User choices are immutable encrypted revisions, never inferred browser defaults.
CREATE TABLE IF NOT EXISTS platform_companion_daily_settings (
 user_id uuid NOT NULL REFERENCES platform_users(id) ON DELETE CASCADE,
 companion_id uuid NOT NULL, revision integer NOT NULL CHECK(revision>0), operation_id uuid NOT NULL,
 record_ciphertext bytea NOT NULL CHECK(octet_length(record_ciphertext)>=29), created_at timestamptz NOT NULL,
 PRIMARY KEY(user_id,companion_id,revision), UNIQUE(user_id,operation_id),
 FOREIGN KEY(companion_id,user_id) REFERENCES platform_companions(id,user_id) ON DELETE CASCADE
);
DROP TRIGGER IF EXISTS companion_daily_settings_immutable ON platform_companion_daily_settings;
CREATE TRIGGER companion_daily_settings_immutable BEFORE UPDATE OR DELETE ON platform_companion_daily_settings
 FOR EACH ROW EXECUTE FUNCTION shared_memory_keep_receipt();
