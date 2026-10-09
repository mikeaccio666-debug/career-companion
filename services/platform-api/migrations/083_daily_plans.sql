-- Owner-created daily tasks. Static identities and immutable encrypted snapshots.
CREATE TABLE platform_daily_plans (
 id uuid PRIMARY KEY,user_id uuid NOT NULL REFERENCES platform_users(id) ON DELETE CASCADE,
 companion_id uuid NOT NULL,local_date date NOT NULL,created_at timestamptz NOT NULL,
 UNIQUE(user_id,local_date),UNIQUE(id,user_id),
 FOREIGN KEY(companion_id,user_id) REFERENCES platform_companions(id,user_id) ON DELETE CASCADE
);
CREATE TABLE platform_daily_plan_items (
 id uuid PRIMARY KEY,user_id uuid NOT NULL REFERENCES platform_users(id) ON DELETE CASCADE,
 plan_id uuid NOT NULL,candidate_id uuid NOT NULL,created_at timestamptz NOT NULL,
 UNIQUE(plan_id,candidate_id),FOREIGN KEY(plan_id,user_id) REFERENCES platform_daily_plans(id,user_id) ON DELETE CASCADE
);
CREATE TABLE platform_daily_plan_operations (
 user_id uuid NOT NULL REFERENCES platform_users(id) ON DELETE CASCADE,plan_id uuid NOT NULL,
 revision integer NOT NULL CHECK(revision>0),operation_id uuid NOT NULL,created_at timestamptz NOT NULL,
 record_ciphertext bytea NOT NULL CHECK(octet_length(record_ciphertext)>=29),
 PRIMARY KEY(plan_id,revision),UNIQUE(user_id,operation_id,plan_id),
 FOREIGN KEY(plan_id,user_id) REFERENCES platform_daily_plans(id,user_id) ON DELETE CASCADE
);
CREATE TRIGGER daily_plans_immutable BEFORE UPDATE OR DELETE ON platform_daily_plans FOR EACH ROW EXECUTE FUNCTION shared_memory_keep_receipt();
CREATE TRIGGER daily_plan_items_immutable BEFORE UPDATE OR DELETE ON platform_daily_plan_items FOR EACH ROW EXECUTE FUNCTION shared_memory_keep_receipt();
CREATE TRIGGER daily_plan_operations_immutable BEFORE UPDATE OR DELETE ON platform_daily_plan_operations FOR EACH ROW EXECUTE FUNCTION shared_memory_keep_receipt();
