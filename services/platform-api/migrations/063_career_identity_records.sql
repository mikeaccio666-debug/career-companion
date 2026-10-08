-- P0 owner-confirmed values only; no dates or identity status are seeded.
CREATE TABLE IF NOT EXISTS platform_career_identity_dates (
 id uuid PRIMARY KEY,user_id uuid NOT NULL REFERENCES platform_users(id) ON DELETE CASCADE,
 field text NOT NULL CHECK(field IN ('program_end_date','stem_designated','opt_status','opt_start_date','opt_end_date','stem_opt_start_date','stem_opt_end_date','unemployment_days_reported','employment_reported','h1b_registration','custom_status_date')),
 sensitivity text NOT NULL CHECK(sensitivity=CASE WHEN field IN ('program_end_date','stem_designated') THEN 'sensitive' ELSE 'restricted' END),
 source text NOT NULL CHECK(source='user_entered'),revision integer NOT NULL CHECK(revision>0),last_operation_id uuid NOT NULL,
 value_ciphertext bytea NOT NULL CHECK(octet_length(value_ciphertext)>=29),
 created_at timestamptz NOT NULL,updated_at timestamptz NOT NULL CHECK(updated_at>=created_at),confirmed_at timestamptz NOT NULL CHECK(confirmed_at=updated_at),
 UNIQUE(id,user_id));
CREATE INDEX IF NOT EXISTS career_identity_owner ON platform_career_identity_dates(user_id,created_at,id);
CREATE UNIQUE INDEX IF NOT EXISTS career_identity_singleton_field ON platform_career_identity_dates(user_id,field)
 WHERE field NOT IN ('h1b_registration','custom_status_date');
-- H1B year and custom label stay inside authenticated ciphertext. Per-year
-- uniqueness is checked while holding the actual account row lock.
CREATE TABLE IF NOT EXISTS platform_career_identity_operations (
 user_id uuid NOT NULL REFERENCES platform_users(id) ON DELETE CASCADE,operation_id uuid NOT NULL,
 record_id uuid NOT NULL,action text NOT NULL CHECK(action IN ('create','edit','delete')),
 applied_revision integer NOT NULL CHECK(applied_revision>0),created_at timestamptz NOT NULL,
 receipt_ciphertext bytea NOT NULL CHECK(octet_length(receipt_ciphertext)>=29),
 PRIMARY KEY(user_id,operation_id),UNIQUE(user_id,record_id,applied_revision),
 UNIQUE(user_id,operation_id,record_id,applied_revision));
ALTER TABLE platform_career_identity_dates DROP CONSTRAINT IF EXISTS career_identity_real_operation;
ALTER TABLE platform_career_identity_dates ADD CONSTRAINT career_identity_real_operation
 FOREIGN KEY(user_id,last_operation_id,id,revision) REFERENCES platform_career_identity_operations(user_id,operation_id,record_id,applied_revision);
DROP TRIGGER IF EXISTS career_identity_operation_immutable ON platform_career_identity_operations;
CREATE TRIGGER career_identity_operation_immutable BEFORE UPDATE OR DELETE ON platform_career_identity_operations
 FOR EACH ROW EXECUTE FUNCTION shared_memory_keep_receipt();
