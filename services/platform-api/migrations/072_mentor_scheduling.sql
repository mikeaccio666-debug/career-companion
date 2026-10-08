-- Manual confirmation of the already matched window. No meeting/calendar is created or contacted.
ALTER TABLE platform_mentor_intent_operations DROP CONSTRAINT IF EXISTS platform_mentor_intent_operations_action_check;
ALTER TABLE platform_mentor_intent_operations ADD CONSTRAINT platform_mentor_intent_operations_action_check CHECK(action IN ('create','cancel','match','schedule','cancel_scheduled'));
ALTER TABLE platform_mentor_intent_operations DROP CONSTRAINT IF EXISTS platform_mentor_intent_operations_applied_revision_check;
ALTER TABLE platform_mentor_intent_operations ADD CONSTRAINT platform_mentor_intent_operations_applied_revision_check CHECK(applied_revision BETWEEN 1 AND 4);
CREATE UNIQUE INDEX IF NOT EXISTS mentor_scheduling_operation_org_unique ON platform_mentor_intent_operations(org_id,operation_id) WHERE action IN ('schedule','cancel_scheduled');
ALTER TABLE platform_mentor_sessions DROP CONSTRAINT IF EXISTS mentor_scheduled_state_check;
ALTER TABLE platform_mentor_sessions ADD CONSTRAINT mentor_scheduled_state_check CHECK(
 (status IN ('requested','matched') AND scheduled_at IS NULL) OR
 (status='scheduled' AND scheduled_at IS NOT NULL AND revision=3) OR
 status IN ('cancelled','completed'));
ALTER TABLE platform_staff_audit DROP CONSTRAINT IF EXISTS platform_staff_audit_action_check;
ALTER TABLE platform_staff_audit ADD CONSTRAINT platform_staff_audit_action_check CHECK(action IN (
 'organization_viewed','staff_memberships_viewed','provider_details_viewed','org_license_registered','org_license_revoked',
 'org_entitlement_changed','org_content_imported','org_content_published','org_content_withdrawn','org_sources_viewed',
 'service_offer_set','service_offer_withdrawn','service_offers_viewed','mentor_intents_viewed',
 'mentor_capacity_set','mentor_capacity_withdrawn','mentor_capacity_viewed','mentor_intent_matched','mentor_orders_viewed','mentor_payment_recorded','mentor_schedule_recorded'));
