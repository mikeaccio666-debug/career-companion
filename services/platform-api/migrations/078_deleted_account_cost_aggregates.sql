-- Product 06 §11.3: deleted accounts leave aggregate costs, not per-call source IDs.
-- No prices, approvals or execution authority are introduced.
CREATE TABLE IF NOT EXISTS platform_deleted_account_cost_daily (
 day date NOT NULL,capability text NOT NULL CHECK(capability IN ('chat','background')),
 cost_micros bigint NOT NULL CHECK(cost_micros>=0),
 estimated_micros bigint NOT NULL CHECK(estimated_micros>=0 AND estimated_micros<=cost_micros),
 calls bigint NOT NULL CHECK(calls>0),estimated_calls bigint NOT NULL CHECK(estimated_calls>=0 AND estimated_calls<=calls),
 PRIMARY KEY(day,capability)
);

-- Source calls disappear through their real owner's cascade later in the same
-- transaction. Keep the FK check; only defer its timing until COMMIT.
ALTER TABLE platform_companion_generation_calls
 ALTER CONSTRAINT platform_companion_generation_calls_reservation_id_fkey DEFERRABLE INITIALLY DEFERRED;

CREATE OR REPLACE FUNCTION privacy_aggregate_account_costs(owner_id uuid) RETURNS void AS $$ BEGIN
 -- Same lock as reserve/admit/settle/reconcile: moving amounts must never create
 -- a budget gap or race a late settlement into a duplicate charge.
 PERFORM pg_advisory_xact_lock(hashtext('companion-cost-guard'));
 INSERT INTO platform_deleted_account_cost_daily(day,capability,cost_micros,estimated_micros,calls,estimated_calls)
 SELECT (coalesce(l.created_at,r.admitted_at,r.dispatch_intent_at) AT TIME ZONE 'UTC')::date,r.capability,
   sum(coalesce(l.cost_micros,r.estimate_micros)),
   sum(CASE WHEN coalesce(l.estimated,true) THEN coalesce(l.cost_micros,r.estimate_micros) ELSE 0 END),
   count(*),count(*) FILTER(WHERE coalesce(l.estimated,true))
 FROM platform_cost_reservations r LEFT JOIN platform_cost_ledger l ON l.reservation_id=r.id
 WHERE r.user_id IS NOT DISTINCT FROM owner_id
   AND (l.reservation_id IS NOT NULL OR r.admitted_at IS NOT NULL OR r.dispatch_intent_at IS NOT NULL)
 GROUP BY 1,2
 ON CONFLICT(day,capability) DO UPDATE SET
   cost_micros=platform_deleted_account_cost_daily.cost_micros+EXCLUDED.cost_micros,
   estimated_micros=platform_deleted_account_cost_daily.estimated_micros+EXCLUDED.estimated_micros,
   calls=platform_deleted_account_cost_daily.calls+EXCLUDED.calls,
   estimated_calls=platform_deleted_account_cost_daily.estimated_calls+EXCLUDED.estimated_calls;
 -- A never-dispatched reservation is released by erasure; an admitted or
 -- possibly dispatched call contributes its conservative estimate above.
 DELETE FROM platform_cost_ledger l USING platform_cost_reservations r
   WHERE l.reservation_id=r.id AND r.user_id IS NOT DISTINCT FROM owner_id;
 DELETE FROM platform_cost_reservations WHERE user_id IS NOT DISTINCT FROM owner_id;
END; $$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION privacy_delete_account_costs() RETURNS trigger AS $$ BEGIN
 PERFORM privacy_aggregate_account_costs(OLD.id); RETURN OLD;
END; $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS privacy_delete_account_costs ON platform_users;
CREATE TRIGGER privacy_delete_account_costs BEFORE DELETE ON platform_users
 FOR EACH ROW EXECUTE FUNCTION privacy_delete_account_costs();

-- Also compact already orphaned legacy records; reruns see no source rows and
-- cannot add their amounts twice. Any remaining source FK blocks COMMIT.
SELECT privacy_aggregate_account_costs(NULL);
