-- Manual offline settlements with real receipt evidence. No external payment is executed.
ALTER TABLE platform_mentor_orders DROP CONSTRAINT IF EXISTS platform_mentor_orders_status_check;
ALTER TABLE platform_mentor_orders ADD CONSTRAINT platform_mentor_orders_status_check CHECK(status IN ('quoted','paid','refunded_partial','refunded_full','void'));
ALTER TABLE platform_mentor_orders DROP CONSTRAINT IF EXISTS platform_mentor_orders_revision_check;
ALTER TABLE platform_mentor_orders ADD CONSTRAINT platform_mentor_orders_revision_check CHECK(revision>=1);
ALTER TABLE platform_mentor_orders DROP CONSTRAINT IF EXISTS platform_mentor_orders_payment_ref_check;
ALTER TABLE platform_mentor_orders DROP CONSTRAINT IF EXISTS platform_mentor_orders_check;
ALTER TABLE platform_mentor_orders DROP CONSTRAINT IF EXISTS platform_mentor_orders_settlement_check;
ALTER TABLE platform_mentor_orders ADD CONSTRAINT platform_mentor_orders_settlement_check CHECK(
 (status='quoted' AND revision=1 AND payment_ref IS NULL AND handoff_code_hash IS NOT NULL AND handoff_code_hash ~ '^[0-9a-f]{64}$') OR
 (status='void' AND revision=2 AND payment_ref IS NULL AND handoff_code_hash IS NULL) OR
 (status='paid' AND revision=2 AND payment_ref IS NOT NULL AND handoff_code_hash IS NOT NULL) OR
 (status IN ('refunded_partial','refunded_full') AND revision>=3 AND payment_ref IS NOT NULL AND handoff_code_hash IS NOT NULL));
ALTER TABLE platform_mentor_orders ADD COLUMN IF NOT EXISTS payment_ref_hash text;
CREATE UNIQUE INDEX IF NOT EXISTS mentor_paid_reference_unique ON platform_mentor_orders(org_id,payment_ref_hash) WHERE payment_ref_hash IS NOT NULL;
ALTER TABLE platform_mentor_order_proofs DROP CONSTRAINT IF EXISTS platform_mentor_order_proofs_revision_check;
ALTER TABLE platform_mentor_order_proofs ADD CONSTRAINT platform_mentor_order_proofs_revision_check CHECK(revision>=1);
ALTER TABLE platform_mentor_order_proofs DROP CONSTRAINT IF EXISTS platform_mentor_order_proofs_user_id_operation_id_fkey;
ALTER TABLE platform_mentor_order_proofs ADD COLUMN IF NOT EXISTS action text;
ALTER TABLE platform_mentor_order_proofs ADD COLUMN IF NOT EXISTS operator_id uuid;
ALTER TABLE platform_mentor_order_proofs ADD COLUMN IF NOT EXISTS external_ref_hash text;
ALTER TABLE platform_mentor_order_proofs DROP CONSTRAINT IF EXISTS mentor_order_proof_actor;
ALTER TABLE platform_mentor_order_proofs ADD CONSTRAINT mentor_order_proof_actor CHECK(
 (action IS NULL AND operator_id IS NULL AND external_ref_hash IS NULL) OR
 (action IN ('pay','refund') AND operator_id IS NOT NULL AND external_ref_hash IS NOT NULL AND external_ref_hash ~ '^[0-9a-f]{64}$'));
CREATE UNIQUE INDEX IF NOT EXISTS mentor_payment_nonce_unique ON platform_mentor_order_proofs(org_id,operation_id) WHERE action IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS mentor_payment_receipt_unique ON platform_mentor_order_proofs(org_id,action,external_ref_hash) WHERE action IS NOT NULL;
CREATE OR REPLACE FUNCTION mentor_order_proof_intent_origin() RETURNS trigger AS $$ BEGIN
 IF NEW.action IS NULL AND NOT EXISTS(SELECT 1 FROM platform_mentor_intent_operations WHERE user_id=NEW.user_id AND operation_id=NEW.operation_id AND session_id=(SELECT session_id FROM platform_mentor_orders WHERE id=NEW.order_id)) THEN
 RAISE EXCEPTION 'Actual intent receipt required' USING ERRCODE='23503'; END IF; RETURN NULL;
END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS mentor_order_proof_origin ON platform_mentor_order_proofs;
CREATE CONSTRAINT TRIGGER mentor_order_proof_origin AFTER INSERT ON platform_mentor_order_proofs DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION mentor_order_proof_intent_origin();
-- Minimal financial records deliberately have no user/org/source-file/actor identity or foreign key to private orders.
CREATE TABLE IF NOT EXISTS platform_mentor_financial_records (
 id uuid PRIMARY KEY,revision integer NOT NULL CHECK(revision>=1),retention_until timestamptz NOT NULL,payload_ciphertext bytea NOT NULL
);
CREATE TABLE IF NOT EXISTS platform_mentor_financial_proofs (
 record_id uuid NOT NULL REFERENCES platform_mentor_financial_records(id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
 revision integer NOT NULL CHECK(revision>=1),action text NOT NULL CHECK(action IN ('pay','refund')),external_ref_hash text NOT NULL CHECK(external_ref_hash ~ '^[0-9a-f]{64}$'),
 proof_ciphertext bytea NOT NULL,PRIMARY KEY(record_id,revision),UNIQUE(action,external_ref_hash)
);
CREATE OR REPLACE FUNCTION mentor_financial_keep_proof() RETURNS trigger AS $$ BEGIN
 IF TG_OP='DELETE' AND NOT EXISTS(SELECT 1 FROM platform_mentor_financial_records WHERE id=OLD.record_id) THEN RETURN OLD; END IF;
 RAISE EXCEPTION 'Financial proof is immutable' USING ERRCODE='42501'; END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS mentor_financial_proof_immutable ON platform_mentor_financial_proofs;
CREATE TRIGGER mentor_financial_proof_immutable BEFORE UPDATE OR DELETE ON platform_mentor_financial_proofs FOR EACH ROW EXECUTE FUNCTION mentor_financial_keep_proof();
CREATE INDEX IF NOT EXISTS mentor_finance_expiry ON platform_mentor_financial_records(retention_until,id);
ALTER TABLE platform_staff_audit DROP CONSTRAINT IF EXISTS platform_staff_audit_action_check;
ALTER TABLE platform_staff_audit ADD CONSTRAINT platform_staff_audit_action_check CHECK(action IN (
 'organization_viewed','staff_memberships_viewed','provider_details_viewed','org_license_registered','org_license_revoked',
 'org_entitlement_changed','org_content_imported','org_content_published','org_content_withdrawn','org_sources_viewed',
 'service_offer_set','service_offer_withdrawn','service_offers_viewed','mentor_intents_viewed','mentor_capacity_set','mentor_capacity_withdrawn','mentor_capacity_viewed',
 'mentor_intent_matched','mentor_orders_viewed','mentor_payment_recorded'));
