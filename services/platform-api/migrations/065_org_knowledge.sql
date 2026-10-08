-- P0 licensed question/method/pattern content. No production license or cohort is seeded.
CREATE TABLE IF NOT EXISTS platform_content_licenses (
 id uuid PRIMARY KEY,org_id uuid NOT NULL REFERENCES platform_orgs(id) ON DELETE CASCADE,
 asset_class text NOT NULL CHECK(asset_class IN ('question','method_card','conversation_pattern')),
 agreement_ref uuid NOT NULL,
 allowed_uses text[] NOT NULL,audience text NOT NULL CHECK(audience IN ('all_users','cohort','entitled','staff_only')),
 valid_from timestamptz NOT NULL,valid_until timestamptz NOT NULL CHECK(valid_until>valid_from),
 revoked_at timestamptz,revision integer NOT NULL CHECK(revision>=1),payload_ciphertext bytea NOT NULL,
 UNIQUE(id,org_id));
CREATE TABLE IF NOT EXISTS platform_user_entitlements (
 id uuid PRIMARY KEY,user_id uuid NOT NULL REFERENCES platform_users(id) ON DELETE CASCADE,
 org_id uuid NOT NULL REFERENCES platform_orgs(id) ON DELETE CASCADE,audience_grants text[] NOT NULL,
 granted_at timestamptz NOT NULL,expires_at timestamptz NOT NULL CHECK(expires_at>granted_at),
 revoked_at timestamptz,revision integer NOT NULL CHECK(revision>=1),payload_ciphertext bytea NOT NULL,
 UNIQUE(user_id,org_id));
CREATE TABLE IF NOT EXISTS platform_org_knowledge_batches (
 id uuid PRIMARY KEY,org_id uuid NOT NULL REFERENCES platform_orgs(id) ON DELETE CASCADE,
 license_id uuid NOT NULL,created_at timestamptz NOT NULL,
 FOREIGN KEY(license_id,org_id) REFERENCES platform_content_licenses(id,org_id));
CREATE SEQUENCE IF NOT EXISTS platform_org_publish_sequence AS integer START 1;
CREATE TABLE IF NOT EXISTS platform_org_knowledge_sources (
 id uuid PRIMARY KEY,org_id uuid NOT NULL REFERENCES platform_orgs(id) ON DELETE CASCADE,
 batch_id uuid NOT NULL REFERENCES platform_org_knowledge_batches(id) ON DELETE CASCADE,
 asset_class text NOT NULL CHECK(asset_class IN ('question','method_card','conversation_pattern')),
 title text NOT NULL,body text NOT NULL CHECK(octet_length(body)<=65536),structured jsonb NOT NULL,
 language text NOT NULL CHECK(language IN ('en','zh','mixed')),role_families text[] NOT NULL,tags text[] NOT NULL,
 license_id uuid NOT NULL,deid_status text NOT NULL CHECK(deid_status='passed'),deid_version integer NOT NULL,
 review_status text NOT NULL CHECK(review_status IN ('in_review','published','retired','withdrawn')),
 editor_id uuid REFERENCES platform_users(id) ON DELETE SET NULL,reviewer_id uuid REFERENCES platform_users(id) ON DELETE SET NULL,
 reviewed_at timestamptz,valid_until timestamptz NOT NULL,revision integer NOT NULL CHECK(revision>=1),
 content_hash text NOT NULL CHECK(content_hash~'^[0-9a-f]{64}$'),publish_batch integer,
 retired_at timestamptz,withdrawn_at timestamptz,created_at timestamptz NOT NULL,updated_at timestamptz NOT NULL,
 receipt_ciphertext bytea NOT NULL,CHECK(editor_id IS NULL OR reviewer_id IS NULL OR editor_id<>reviewer_id),
 FOREIGN KEY(license_id,org_id) REFERENCES platform_content_licenses(id,org_id),UNIQUE(id,revision));
CREATE TABLE IF NOT EXISTS platform_org_knowledge_passages (
 source_id uuid NOT NULL REFERENCES platform_org_knowledge_sources(id) ON DELETE CASCADE,
 revision integer NOT NULL,passage_id text NOT NULL,passage_index integer NOT NULL,content text NOT NULL,
 search_vector tsvector NOT NULL DEFAULT ''::tsvector,PRIMARY KEY(source_id,revision,passage_id));
CREATE TABLE IF NOT EXISTS platform_knowledge_access_log (
 id uuid PRIMARY KEY,user_id uuid NOT NULL REFERENCES platform_users(id) ON DELETE CASCADE,
 source_id uuid NOT NULL REFERENCES platform_org_knowledge_sources(id) ON DELETE CASCADE,
 revision integer NOT NULL,passage_id text NOT NULL,asset_class text NOT NULL,
 speaker text NOT NULL,purpose text NOT NULL,conversation_id uuid REFERENCES platform_conversations(id) ON DELETE CASCADE,
 message_id uuid REFERENCES platform_messages(id) ON DELETE SET NULL,
 created_at timestamptz NOT NULL,retention_until timestamptz NOT NULL);
CREATE INDEX IF NOT EXISTS org_knowledge_source_filter ON platform_org_knowledge_sources(org_id,asset_class,review_status);
CREATE INDEX IF NOT EXISTS org_knowledge_access_owner ON platform_knowledge_access_log(user_id,created_at);
ALTER TABLE platform_staff_audit DROP CONSTRAINT IF EXISTS platform_staff_audit_action_check;
ALTER TABLE platform_staff_audit ADD CONSTRAINT platform_staff_audit_action_check CHECK(action IN (
 'organization_viewed','staff_memberships_viewed','provider_details_viewed','org_license_registered','org_license_revoked',
 'org_entitlement_changed','org_content_imported','org_content_published','org_content_withdrawn','org_sources_viewed'));

CREATE TABLE IF NOT EXISTS platform_org_content_state_proofs (
 org_id uuid NOT NULL REFERENCES platform_orgs(id) ON DELETE CASCADE,
 kind text NOT NULL CHECK(kind IN ('license','entitlement','source')),object_id uuid NOT NULL,
 revision integer NOT NULL CHECK(revision>=1),user_id uuid REFERENCES platform_users(id) ON DELETE CASCADE,
 proof_ciphertext bytea NOT NULL,PRIMARY KEY(org_id,kind,object_id,revision));
CREATE TABLE IF NOT EXISTS platform_org_content_operations (
 org_id uuid NOT NULL REFERENCES platform_orgs(id) ON DELETE CASCADE,operation_id uuid NOT NULL,
 receipt_ciphertext bytea NOT NULL,PRIMARY KEY(org_id,operation_id));
CREATE OR REPLACE FUNCTION org_content_keep_proof() RETURNS trigger AS $$ BEGIN
 IF TG_OP='DELETE' AND NOT EXISTS(SELECT 1 FROM platform_orgs WHERE id=OLD.org_id) THEN RETURN OLD; END IF;
 IF TG_OP='DELETE' AND TG_TABLE_NAME='platform_org_content_state_proofs'
    AND (to_jsonb(OLD)->>'user_id') IS NOT NULL
    AND NOT EXISTS(SELECT 1 FROM platform_users WHERE id=(to_jsonb(OLD)->>'user_id')::uuid) THEN RETURN OLD; END IF;
 RAISE EXCEPTION 'Organization content proof is immutable' USING ERRCODE='42501';
END; $$ LANGUAGE plpgsql;
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgname='org_content_state_proof_immutable' AND tgrelid='platform_org_content_state_proofs'::regclass) THEN
 CREATE TRIGGER org_content_state_proof_immutable BEFORE UPDATE OR DELETE ON platform_org_content_state_proofs FOR EACH ROW EXECUTE FUNCTION org_content_keep_proof(); END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgname='org_content_operation_immutable' AND tgrelid='platform_org_content_operations'::regclass) THEN
 CREATE TRIGGER org_content_operation_immutable BEFORE UPDATE OR DELETE ON platform_org_content_operations FOR EACH ROW EXECUTE FUNCTION org_content_keep_proof(); END IF;
END $$;

ALTER TABLE platform_request_limits DROP CONSTRAINT IF EXISTS platform_request_limits_scope_check;
ALTER TABLE platform_request_limits DROP CONSTRAINT IF EXISTS platform_request_limits_check;
ALTER TABLE platform_request_limits ADD CONSTRAINT platform_request_limits_scope_check
  CHECK(scope IN ('api','chat','speech','transcription','realtime','control','org-knowledge','auth-login','auth-register','auth-email-request','auth-email-consume','public'));
ALTER TABLE platform_request_limits ADD CONSTRAINT platform_request_limits_check
  CHECK ((subject_type='user' AND subject_key ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      AND scope IN ('api','chat','speech','transcription','realtime','control','org-knowledge'))
    OR (subject_type='ip' AND subject_key ~ '^[0-9a-f]{64}$'
      AND scope IN ('auth-login','auth-register','auth-email-request','auth-email-consume','public')));
