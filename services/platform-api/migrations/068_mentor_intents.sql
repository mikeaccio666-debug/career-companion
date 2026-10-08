-- Owner-authored P0 intents. No match, quote, order, payment, free grant or notification is fabricated.
CREATE TABLE IF NOT EXISTS platform_mentor_sessions (
 id uuid PRIMARY KEY,user_id uuid NOT NULL REFERENCES platform_users(id) ON DELETE CASCADE,
 org_id uuid NOT NULL REFERENCES platform_orgs(id) ON DELETE CASCADE,
 offer_id uuid NOT NULL,offer_revision integer NOT NULL CHECK(offer_revision>=1),
 kind text NOT NULL CHECK(kind IN ('free_diagnosis','mock_interview','resume_direction','offer_negotiation')),
 duration_min integer NOT NULL CHECK(duration_min BETWEEN 1 AND 240),
 status text NOT NULL CHECK(status IN ('requested','matched','scheduled','completed','cancelled')),
 mentor_id uuid,order_id uuid,packet_id uuid,scheduled_at timestamptz,review_id uuid,
 revision integer NOT NULL CHECK(revision>=1),last_operation_id uuid NOT NULL,
 created_at timestamptz NOT NULL,updated_at timestamptz NOT NULL,
 payload_ciphertext bytea NOT NULL,
 FOREIGN KEY(org_id,offer_id,offer_revision) REFERENCES platform_service_offer_proofs(org_id,offer_id,revision)
);
CREATE INDEX IF NOT EXISTS mentor_session_owner ON platform_mentor_sessions(user_id,created_at DESC,id DESC);
CREATE INDEX IF NOT EXISTS mentor_session_ops ON platform_mentor_sessions(org_id,created_at DESC,id DESC);
CREATE TABLE IF NOT EXISTS platform_mentor_intent_operations (
 user_id uuid NOT NULL REFERENCES platform_users(id) ON DELETE CASCADE,
 org_id uuid NOT NULL REFERENCES platform_orgs(id) ON DELETE CASCADE,
 operation_id uuid NOT NULL,session_id uuid NOT NULL REFERENCES platform_mentor_sessions(id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
 action text NOT NULL CHECK(action IN ('create','cancel')),applied_revision integer NOT NULL CHECK(applied_revision IN (1,2)),
 created_at timestamptz NOT NULL,receipt_ciphertext bytea NOT NULL,
 PRIMARY KEY(user_id,operation_id),UNIQUE(session_id,applied_revision)
);
CREATE OR REPLACE FUNCTION mentor_intent_keep_operation() RETURNS trigger AS $$ BEGIN
 IF TG_OP='DELETE' AND (NOT EXISTS(SELECT 1 FROM platform_users WHERE id=OLD.user_id)
   OR NOT EXISTS(SELECT 1 FROM platform_orgs WHERE id=OLD.org_id)) THEN RETURN OLD; END IF;
 RAISE EXCEPTION 'Mentor intent receipt is immutable' USING ERRCODE='42501';
END; $$ LANGUAGE plpgsql;
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgname='mentor_intent_operation_immutable' AND tgrelid='platform_mentor_intent_operations'::regclass) THEN
 CREATE TRIGGER mentor_intent_operation_immutable BEFORE UPDATE OR DELETE ON platform_mentor_intent_operations FOR EACH ROW EXECUTE FUNCTION mentor_intent_keep_operation(); END IF;
END $$;
ALTER TABLE platform_staff_audit DROP CONSTRAINT IF EXISTS platform_staff_audit_action_check;
ALTER TABLE platform_staff_audit ADD CONSTRAINT platform_staff_audit_action_check CHECK(action IN (
 'organization_viewed','staff_memberships_viewed','provider_details_viewed','org_license_registered','org_license_revoked',
 'org_entitlement_changed','org_content_imported','org_content_published','org_content_withdrawn','org_sources_viewed',
 'service_offer_set','service_offer_withdrawn','service_offers_viewed','mentor_intents_viewed'));
