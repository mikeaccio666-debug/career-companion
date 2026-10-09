-- Feedback is explicitly shared with the configured product support organization.
-- Text is encrypted; neither paths/URLs nor a conversation transcript are captured.
CREATE TABLE platform_product_feedback (
 id uuid PRIMARY KEY,
 user_id uuid NOT NULL REFERENCES platform_users(id) ON DELETE CASCADE,
 org_id uuid NOT NULL REFERENCES platform_orgs(id),
 revision integer NOT NULL CHECK(revision BETWEEN 1 AND 101),
 last_operation_id uuid NOT NULL,
 status text NOT NULL CHECK(status IN ('submitted','in_review','resolved','closed')),
 record_ciphertext bytea NOT NULL,
 created_at timestamptz NOT NULL,
 updated_at timestamptz NOT NULL,
 UNIQUE(user_id,id),
 CHECK(updated_at>=created_at)
);
CREATE INDEX platform_product_feedback_inbox ON platform_product_feedback(org_id,status,id);
CREATE INDEX platform_product_feedback_owner ON platform_product_feedback(user_id,id);
CREATE TABLE platform_product_feedback_operations (
 user_id uuid NOT NULL,
 operation_id uuid NOT NULL,
 feedback_id uuid NOT NULL,
 applied_revision integer NOT NULL CHECK(applied_revision BETWEEN 1 AND 101),
 receipt_ciphertext bytea NOT NULL,
 created_at timestamptz NOT NULL,
 PRIMARY KEY(user_id,operation_id),
 UNIQUE(feedback_id,applied_revision),
 FOREIGN KEY(user_id,feedback_id) REFERENCES platform_product_feedback(user_id,id) ON DELETE CASCADE
);
ALTER TABLE platform_staff_audit DROP CONSTRAINT IF EXISTS platform_staff_audit_action_check;
ALTER TABLE platform_staff_audit ADD CONSTRAINT platform_staff_audit_action_check CHECK(action IN (
 'organization_viewed','staff_memberships_viewed','provider_details_viewed','org_license_registered','org_license_revoked',
 'org_entitlement_changed','org_content_imported','org_content_published','org_content_withdrawn','org_sources_viewed',
 'service_offer_set','service_offer_withdrawn','service_offers_viewed','mentor_intents_viewed',
 'mentor_capacity_set','mentor_capacity_withdrawn','mentor_capacity_viewed','mentor_intent_matched','mentor_orders_viewed','mentor_payment_recorded','mentor_schedule_recorded',
 'product_feedback_viewed','product_feedback_updated'));

ALTER TABLE platform_product_events DROP CONSTRAINT platform_product_events_event_check;
ALTER TABLE platform_product_events ADD CONSTRAINT platform_product_events_event_check CHECK(event IN ('application_stage_changed','story_saved','resume_version_created','feedback_submitted'));
ALTER TABLE platform_product_events DROP CONSTRAINT platform_product_events_check;
ALTER TABLE platform_product_events ADD CONSTRAINT platform_product_events_check CHECK (jsonb_typeof(props)='object' AND (
  (event='application_stage_changed'
   AND props ?& ARRAY['from_stage','to_stage','closed_reason']
   AND props - ARRAY['from_stage','to_stage','closed_reason'] = '{}'::jsonb
   AND props->>'from_stage' IN ('saved','applied','oa','interview','offer','closed')
   AND props->>'to_stage' IN ('saved','applied','oa','interview','offer','closed')
   AND props->>'closed_reason' IN ('none','not_advanced','withdrawn','role_closed','no_response','declined','rescinded')
   AND ((props->>'to_stage'='closed') = (props->>'closed_reason'<>'none')))
  OR (event='story_saved' AND props='{"source":"user_entered"}'::jsonb)
  OR (event='resume_version_created' AND props IN ('{"source":"paste"}'::jsonb,'{"source":"upload"}'::jsonb,'{"source":"derived"}'::jsonb))
  OR (event='feedback_submitted' AND props ? 'category' AND props - 'category' = '{}'::jsonb
   AND props->>'category' IN ('incorrect','out_of_character','too_long','sales_pressure','other'))
 ) IS TRUE);
