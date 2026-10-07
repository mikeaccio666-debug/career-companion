-- A committed intent only retains possible expenditure across dispatch COMMIT
-- failure or process death. It is neither provider admission nor execution authority.
ALTER TABLE platform_cost_reservations ADD COLUMN dispatch_intent_at timestamptz;
ALTER TABLE platform_cost_reservations ADD CONSTRAINT platform_cost_dispatch_risk_state
  CHECK (dispatch_intent_at IS NULL OR status IN ('reserved','admitted','committed'));
COMMENT ON COLUMN platform_cost_reservations.dispatch_intent_at IS
  'Accounting-only durable dispatch risk. Not a provider receipt, admission proof or execution permission.';
CREATE INDEX platform_cost_reservations_dispatch_risk ON platform_cost_reservations(expires_at)
  WHERE status='reserved' AND dispatch_intent_at IS NOT NULL;
ALTER TABLE platform_cost_ledger DROP CONSTRAINT platform_cost_ledger_usage_status_check;
ALTER TABLE platform_cost_ledger ADD CONSTRAINT platform_cost_ledger_usage_status_check
  CHECK (usage_status IN ('reported','missing','invalid','expired','dispatch_uncertain'));
