-- Owner-confirmed structured career facts only. No intake backfill or model grant.
CREATE TABLE platform_career_profile_operations (
 user_id uuid NOT NULL REFERENCES platform_users(id) ON DELETE CASCADE,
 operation_id uuid NOT NULL, action text NOT NULL CHECK(action IN ('save','delete')),
 applied_revision integer NOT NULL CHECK(applied_revision>0), created_at timestamptz NOT NULL,
 receipt_ciphertext bytea NOT NULL CHECK(octet_length(receipt_ciphertext)>=29),
 PRIMARY KEY(user_id,operation_id), UNIQUE(user_id,applied_revision), UNIQUE(user_id,operation_id,applied_revision)
);
CREATE TABLE platform_career_profiles (
 user_id uuid PRIMARY KEY REFERENCES platform_users(id) ON DELETE CASCADE,
 revision integer NOT NULL CHECK(revision>0), last_operation_id uuid NOT NULL,
 record_ciphertext bytea NOT NULL CHECK(octet_length(record_ciphertext)>=29),
 created_at timestamptz NOT NULL,updated_at timestamptz NOT NULL CHECK(updated_at>=created_at),
 FOREIGN KEY(user_id,last_operation_id,revision) REFERENCES platform_career_profile_operations(user_id,operation_id,applied_revision)
);
-- Coordinate/digest receipts survive deletion of the current content. They
-- preserve revision monotonicity and prevent delayed saves from recreating it.
CREATE TRIGGER career_profile_operation_immutable BEFORE UPDATE OR DELETE ON platform_career_profile_operations
 FOR EACH ROW EXECUTE FUNCTION shared_memory_keep_receipt();
