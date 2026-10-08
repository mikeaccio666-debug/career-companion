-- Ops-confirmed P0 mentor/slot sources, private to the organization. No booking, order or free entitlement.
CREATE TABLE IF NOT EXISTS platform_mentor_capacity_records (
 id uuid PRIMARY KEY,org_id uuid NOT NULL REFERENCES platform_orgs(id) ON DELETE CASCADE,
 mentor_id uuid NOT NULL REFERENCES platform_users(id) ON DELETE CASCADE,
 record_kind text NOT NULL CHECK(record_kind IN ('profile','slot')),
 status text NOT NULL CHECK(status IN ('active','withdrawn')),
 revision integer NOT NULL CHECK(revision>=1),last_operation_id uuid NOT NULL,updated_at timestamptz NOT NULL,
 profile_id uuid,profile_revision integer,profile_kind text,service_kind text,starts_at timestamptz,ends_at timestamptz,
 payload_ciphertext bytea NOT NULL,
 UNIQUE(org_id,id,record_kind,mentor_id),
 CHECK((record_kind='profile' AND profile_id IS NULL AND profile_revision IS NULL AND profile_kind IS NULL
   AND service_kind IS NULL AND starts_at IS NULL AND ends_at IS NULL) OR
  (record_kind='slot' AND profile_id IS NOT NULL AND profile_revision IS NOT NULL AND profile_revision>=1 AND profile_kind IS NOT NULL AND profile_kind='profile'
   AND service_kind IS NOT NULL AND service_kind IN ('mock_interview','resume_direction','offer_negotiation')
   AND starts_at IS NOT NULL AND ends_at IS NOT NULL AND ends_at>=starts_at+interval '1 minute'
   AND ends_at<=starts_at+interval '240 minutes' AND mod(extract(epoch FROM ends_at-starts_at)::numeric,60)=0)),
 FOREIGN KEY(org_id,profile_id,profile_kind,mentor_id) REFERENCES platform_mentor_capacity_records(org_id,id,record_kind,mentor_id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS mentor_capacity_profile_unique ON platform_mentor_capacity_records(org_id,mentor_id) WHERE record_kind='profile';
CREATE INDEX IF NOT EXISTS mentor_capacity_org_list ON platform_mentor_capacity_records(org_id,record_kind,id);
CREATE INDEX IF NOT EXISTS mentor_capacity_times ON platform_mentor_capacity_records(mentor_id,starts_at,ends_at) WHERE record_kind='slot' AND status='active';
CREATE TABLE IF NOT EXISTS platform_mentor_capacity_proofs (
 org_id uuid NOT NULL REFERENCES platform_orgs(id) ON DELETE CASCADE,record_id uuid NOT NULL REFERENCES platform_mentor_capacity_records(id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
 revision integer NOT NULL CHECK(revision>=1),operation_id uuid NOT NULL,action text NOT NULL CHECK(action IN ('profile','slot','withdraw')),
 created_at timestamptz NOT NULL,proof_ciphertext bytea NOT NULL,
 PRIMARY KEY(org_id,record_id,revision),UNIQUE(org_id,operation_id)
);
ALTER TABLE platform_mentor_capacity_records DROP CONSTRAINT IF EXISTS mentor_capacity_profile_revision;
ALTER TABLE platform_mentor_capacity_records ADD CONSTRAINT mentor_capacity_profile_revision FOREIGN KEY(org_id,profile_id,profile_revision)
 REFERENCES platform_mentor_capacity_proofs(org_id,record_id,revision) DEFERRABLE INITIALLY DEFERRED;
CREATE OR REPLACE FUNCTION mentor_capacity_keep_proof() RETURNS trigger AS $$ BEGIN
 IF TG_OP='DELETE' AND (NOT EXISTS(SELECT 1 FROM platform_orgs WHERE id=OLD.org_id)
   OR NOT EXISTS(SELECT 1 FROM platform_mentor_capacity_records WHERE id=OLD.record_id)) THEN RETURN OLD; END IF;
 RAISE EXCEPTION 'Mentor capacity proof is immutable' USING ERRCODE='42501';
END; $$ LANGUAGE plpgsql;
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgname='mentor_capacity_proof_immutable' AND tgrelid='platform_mentor_capacity_proofs'::regclass) THEN
 CREATE TRIGGER mentor_capacity_proof_immutable BEFORE UPDATE OR DELETE ON platform_mentor_capacity_proofs FOR EACH ROW EXECUTE FUNCTION mentor_capacity_keep_proof(); END IF;
END $$;
ALTER TABLE platform_staff_audit DROP CONSTRAINT IF EXISTS platform_staff_audit_action_check;
ALTER TABLE platform_staff_audit ADD CONSTRAINT platform_staff_audit_action_check CHECK(action IN (
 'organization_viewed','staff_memberships_viewed','provider_details_viewed','org_license_registered','org_license_revoked',
 'org_entitlement_changed','org_content_imported','org_content_published','org_content_withdrawn','org_sources_viewed',
 'service_offer_set','service_offer_withdrawn','service_offers_viewed','mentor_intents_viewed',
 'mentor_capacity_set','mentor_capacity_withdrawn','mentor_capacity_viewed'));
