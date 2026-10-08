-- Reviewed operator configuration only: no seeded prices, slots, partner relationship or free eligibility.
CREATE TABLE IF NOT EXISTS platform_service_offers (
 id uuid PRIMARY KEY, org_id uuid NOT NULL REFERENCES platform_orgs(id) ON DELETE CASCADE,
 service_kind text NOT NULL CHECK(service_kind IN ('mock_interview','resume_direction','offer_negotiation')),
 duration_min integer NOT NULL CHECK(duration_min BETWEEN 1 AND 240),
 price_cents integer NOT NULL CHECK(price_cents>0), currency text NOT NULL CHECK(currency='USD'),
 status text NOT NULL CHECK(status IN ('active','withdrawn')),
 revision integer NOT NULL CHECK(revision>=1),
 valid_from timestamptz NOT NULL, valid_until timestamptz NOT NULL CHECK(valid_until>valid_from),
 earliest_slot_at timestamptz CHECK(earliest_slot_at IS NULL OR (earliest_slot_at>=valid_from AND earliest_slot_at<valid_until)),
 updated_at timestamptz NOT NULL,payload_ciphertext bytea NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS service_offer_active_kind ON platform_service_offers(org_id,service_kind) WHERE status='active';
CREATE TABLE IF NOT EXISTS platform_service_offer_proofs (
 org_id uuid NOT NULL REFERENCES platform_orgs(id) ON DELETE CASCADE,
 offer_id uuid NOT NULL REFERENCES platform_service_offers(id) ON DELETE CASCADE,
 revision integer NOT NULL CHECK(revision>=1),proof_ciphertext bytea NOT NULL,
 PRIMARY KEY(org_id,offer_id,revision)
);
CREATE TABLE IF NOT EXISTS platform_service_offer_operations (
 org_id uuid NOT NULL REFERENCES platform_orgs(id) ON DELETE CASCADE,
 operation_id uuid NOT NULL,receipt_ciphertext bytea NOT NULL,PRIMARY KEY(org_id,operation_id)
);
CREATE OR REPLACE FUNCTION service_offer_keep_proof() RETURNS trigger AS $$ BEGIN
 IF TG_OP='DELETE' AND NOT EXISTS(SELECT 1 FROM platform_orgs WHERE id=OLD.org_id) THEN RETURN OLD; END IF;
 RAISE EXCEPTION 'Service offer proof is immutable' USING ERRCODE='42501';
END; $$ LANGUAGE plpgsql;
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgname='service_offer_proof_immutable' AND tgrelid='platform_service_offer_proofs'::regclass) THEN
 CREATE TRIGGER service_offer_proof_immutable BEFORE UPDATE OR DELETE ON platform_service_offer_proofs FOR EACH ROW EXECUTE FUNCTION service_offer_keep_proof(); END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgname='service_offer_operation_immutable' AND tgrelid='platform_service_offer_operations'::regclass) THEN
 CREATE TRIGGER service_offer_operation_immutable BEFORE UPDATE OR DELETE ON platform_service_offer_operations FOR EACH ROW EXECUTE FUNCTION service_offer_keep_proof(); END IF;
END $$;
ALTER TABLE platform_staff_audit DROP CONSTRAINT IF EXISTS platform_staff_audit_action_check;
ALTER TABLE platform_staff_audit ADD CONSTRAINT platform_staff_audit_action_check CHECK(action IN (
 'organization_viewed','staff_memberships_viewed','provider_details_viewed','org_license_registered','org_license_revoked',
 'org_entitlement_changed','org_content_imported','org_content_published','org_content_withdrawn','org_sources_viewed',
 'service_offer_set','service_offer_withdrawn','service_offers_viewed'));
