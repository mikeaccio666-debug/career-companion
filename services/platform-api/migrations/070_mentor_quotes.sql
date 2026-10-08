-- Actual manual matches, quotes and slot holds. No payment or scheduled/completed transition is enabled here.
CREATE UNIQUE INDEX IF NOT EXISTS mentor_session_owner_org_unique ON platform_mentor_sessions(id,user_id,org_id);
CREATE UNIQUE INDEX IF NOT EXISTS mentor_session_offer_owner_unique ON platform_mentor_sessions(id,user_id,org_id,offer_id,offer_revision);
ALTER TABLE platform_mentor_intent_operations DROP CONSTRAINT IF EXISTS platform_mentor_intent_operations_action_check;
ALTER TABLE platform_mentor_intent_operations ADD CONSTRAINT platform_mentor_intent_operations_action_check CHECK(action IN ('create','cancel','match'));
ALTER TABLE platform_mentor_intent_operations DROP CONSTRAINT IF EXISTS platform_mentor_intent_operations_applied_revision_check;
ALTER TABLE platform_mentor_intent_operations ADD CONSTRAINT platform_mentor_intent_operations_applied_revision_check CHECK(applied_revision BETWEEN 1 AND 3);
CREATE UNIQUE INDEX IF NOT EXISTS mentor_match_operation_org_unique ON platform_mentor_intent_operations(org_id,operation_id) WHERE action='match';
CREATE TABLE IF NOT EXISTS platform_mentor_orders (
 id uuid PRIMARY KEY,session_id uuid NOT NULL UNIQUE,user_id uuid NOT NULL REFERENCES platform_users(id) ON DELETE CASCADE,
 org_id uuid NOT NULL REFERENCES platform_orgs(id) ON DELETE CASCADE,offer_id uuid NOT NULL,offer_revision integer NOT NULL CHECK(offer_revision>=1),
 price_cents integer NOT NULL CHECK(price_cents>0),currency text NOT NULL CHECK(currency='USD'),status text NOT NULL CHECK(status IN ('quoted','void')),
 origin text NOT NULL CHECK(origin='user_request'),suggestion_id uuid CHECK(suggestion_id IS NULL),payment_ref text CHECK(payment_ref IS NULL),
 handoff_code_hash text,revision integer NOT NULL CHECK(revision IN (1,2)),last_operation_id uuid NOT NULL,
 created_at timestamptz NOT NULL,updated_at timestamptz NOT NULL,payload_ciphertext bytea NOT NULL,
 CHECK((status='quoted' AND revision=1 AND handoff_code_hash IS NOT NULL AND handoff_code_hash ~ '^[0-9a-f]{64}$') OR (status='void' AND revision=2 AND handoff_code_hash IS NULL)),
 UNIQUE(id,session_id,user_id,org_id),
 FOREIGN KEY(session_id,user_id,org_id,offer_id,offer_revision) REFERENCES platform_mentor_sessions(id,user_id,org_id,offer_id,offer_revision) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED
);
CREATE UNIQUE INDEX IF NOT EXISTS mentor_order_handoff_unique ON platform_mentor_orders(handoff_code_hash) WHERE handoff_code_hash IS NOT NULL;
ALTER TABLE platform_mentor_sessions DROP CONSTRAINT IF EXISTS mentor_session_order_owner;
ALTER TABLE platform_mentor_sessions ADD CONSTRAINT mentor_session_order_owner FOREIGN KEY(order_id,id,user_id,org_id)
 REFERENCES platform_mentor_orders(id,session_id,user_id,org_id) DEFERRABLE INITIALLY DEFERRED;
CREATE TABLE IF NOT EXISTS platform_mentor_order_proofs (
 order_id uuid NOT NULL REFERENCES platform_mentor_orders(id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
 user_id uuid NOT NULL REFERENCES platform_users(id) ON DELETE CASCADE,org_id uuid NOT NULL REFERENCES platform_orgs(id) ON DELETE CASCADE,
 revision integer NOT NULL CHECK(revision IN (1,2)),operation_id uuid NOT NULL,created_at timestamptz NOT NULL,proof_ciphertext bytea NOT NULL,
 PRIMARY KEY(order_id,revision),FOREIGN KEY(user_id,operation_id) REFERENCES platform_mentor_intent_operations(user_id,operation_id) DEFERRABLE INITIALLY DEFERRED
);
CREATE TABLE IF NOT EXISTS platform_mentor_slot_reservations (
 session_id uuid PRIMARY KEY,user_id uuid NOT NULL REFERENCES platform_users(id) ON DELETE CASCADE,org_id uuid NOT NULL REFERENCES platform_orgs(id) ON DELETE CASCADE,
 mentor_id uuid NOT NULL,slot_id uuid NOT NULL,slot_revision integer NOT NULL CHECK(slot_revision>=1),starts_at timestamptz NOT NULL,ends_at timestamptz NOT NULL,
 status text NOT NULL CHECK(status IN ('held','released')),revision integer NOT NULL CHECK(revision IN (1,2)),last_operation_id uuid NOT NULL,
 updated_at timestamptz NOT NULL,payload_ciphertext bytea NOT NULL,CHECK(starts_at<ends_at),
 FOREIGN KEY(session_id,user_id,org_id) REFERENCES platform_mentor_sessions(id,user_id,org_id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED
);
CREATE UNIQUE INDEX IF NOT EXISTS mentor_slot_held_unique ON platform_mentor_slot_reservations(slot_id) WHERE status='held';
CREATE INDEX IF NOT EXISTS mentor_reservation_windows ON platform_mentor_slot_reservations(mentor_id,starts_at,ends_at);
CREATE TABLE IF NOT EXISTS platform_mentor_reservation_proofs (
 session_id uuid NOT NULL REFERENCES platform_mentor_slot_reservations(session_id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
 user_id uuid NOT NULL REFERENCES platform_users(id) ON DELETE CASCADE,org_id uuid NOT NULL REFERENCES platform_orgs(id) ON DELETE CASCADE,
 revision integer NOT NULL CHECK(revision IN (1,2)),operation_id uuid NOT NULL,created_at timestamptz NOT NULL,proof_ciphertext bytea NOT NULL,
 PRIMARY KEY(session_id,revision),FOREIGN KEY(user_id,operation_id) REFERENCES platform_mentor_intent_operations(user_id,operation_id) DEFERRABLE INITIALLY DEFERRED
);
CREATE OR REPLACE FUNCTION mentor_quote_keep_proof() RETURNS trigger AS $$ BEGIN
 IF TG_OP='DELETE' AND (NOT EXISTS(SELECT 1 FROM platform_users WHERE id=OLD.user_id) OR NOT EXISTS(SELECT 1 FROM platform_orgs WHERE id=OLD.org_id)
   OR NOT EXISTS(SELECT 1 FROM platform_mentor_orders WHERE id=OLD.order_id)) THEN RETURN OLD; END IF;
 RAISE EXCEPTION 'Mentor quote proof is immutable' USING ERRCODE='42501';
END; $$ LANGUAGE plpgsql;
-- Use a separate trigger function because reservation rows do not have order_id.
CREATE OR REPLACE FUNCTION mentor_reservation_keep_proof() RETURNS trigger AS $$ BEGIN
 IF TG_OP='DELETE' AND (NOT EXISTS(SELECT 1 FROM platform_users WHERE id=OLD.user_id) OR NOT EXISTS(SELECT 1 FROM platform_orgs WHERE id=OLD.org_id)
   OR NOT EXISTS(SELECT 1 FROM platform_mentor_slot_reservations WHERE session_id=OLD.session_id)) THEN RETURN OLD; END IF;
 RAISE EXCEPTION 'Mentor reservation proof is immutable' USING ERRCODE='42501';
END; $$ LANGUAGE plpgsql;
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgname='mentor_order_proof_immutable' AND tgrelid='platform_mentor_order_proofs'::regclass) THEN
 CREATE TRIGGER mentor_order_proof_immutable BEFORE UPDATE OR DELETE ON platform_mentor_order_proofs FOR EACH ROW EXECUTE FUNCTION mentor_quote_keep_proof(); END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgname='mentor_reservation_proof_immutable' AND tgrelid='platform_mentor_reservation_proofs'::regclass) THEN
 CREATE TRIGGER mentor_reservation_proof_immutable BEFORE UPDATE OR DELETE ON platform_mentor_reservation_proofs FOR EACH ROW EXECUTE FUNCTION mentor_reservation_keep_proof(); END IF;
END $$;
ALTER TABLE platform_staff_audit DROP CONSTRAINT IF EXISTS platform_staff_audit_action_check;
ALTER TABLE platform_staff_audit ADD CONSTRAINT platform_staff_audit_action_check CHECK(action IN (
 'organization_viewed','staff_memberships_viewed','provider_details_viewed','org_license_registered','org_license_revoked',
 'org_entitlement_changed','org_content_imported','org_content_published','org_content_withdrawn','org_sources_viewed',
 'service_offer_set','service_offer_withdrawn','service_offers_viewed','mentor_intents_viewed',
 'mentor_capacity_set','mentor_capacity_withdrawn','mentor_capacity_viewed','mentor_intent_matched','mentor_orders_viewed'));
