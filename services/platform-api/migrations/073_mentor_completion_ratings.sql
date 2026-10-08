-- Actual completed fulfillment and a single private owner feedback decision. No public ratings.
ALTER TABLE platform_mentor_intent_operations DROP CONSTRAINT IF EXISTS platform_mentor_intent_operations_action_check;
ALTER TABLE platform_mentor_intent_operations ADD CONSTRAINT platform_mentor_intent_operations_action_check CHECK(action IN ('create','cancel','match','schedule','cancel_scheduled','complete'));
DROP INDEX IF EXISTS mentor_scheduling_operation_org_unique;
CREATE UNIQUE INDEX mentor_scheduling_operation_org_unique ON platform_mentor_intent_operations(org_id,operation_id) WHERE action IN ('schedule','cancel_scheduled','complete');
ALTER TABLE platform_mentor_sessions DROP CONSTRAINT IF EXISTS mentor_scheduled_state_check;
ALTER TABLE platform_mentor_sessions ADD CONSTRAINT mentor_scheduled_state_check CHECK(
 (status IN ('requested','matched') AND scheduled_at IS NULL) OR
 (status='scheduled' AND scheduled_at IS NOT NULL AND revision=3) OR
 (status='completed' AND scheduled_at IS NOT NULL AND revision=4) OR status='cancelled');
CREATE TABLE IF NOT EXISTS platform_mentor_ratings (
 session_id uuid PRIMARY KEY,user_id uuid NOT NULL REFERENCES platform_users(id) ON DELETE CASCADE,
 org_id uuid NOT NULL REFERENCES platform_orgs(id) ON DELETE CASCADE,operation_id uuid NOT NULL,
 created_at timestamptz NOT NULL,payload_ciphertext bytea NOT NULL,
 UNIQUE(user_id,operation_id),FOREIGN KEY(session_id,user_id,org_id) REFERENCES platform_mentor_sessions(id,user_id,org_id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED
);
CREATE OR REPLACE FUNCTION mentor_rating_keep_decision() RETURNS trigger AS $$ BEGIN
 IF TG_OP='DELETE' AND (NOT EXISTS(SELECT 1 FROM platform_users WHERE id=OLD.user_id) OR NOT EXISTS(SELECT 1 FROM platform_orgs WHERE id=OLD.org_id)) THEN RETURN OLD; END IF;
 RAISE EXCEPTION 'Mentor feedback is immutable' USING ERRCODE='42501';
END; $$ LANGUAGE plpgsql;
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgname='mentor_rating_immutable' AND tgrelid='platform_mentor_ratings'::regclass) THEN
 CREATE TRIGGER mentor_rating_immutable BEFORE UPDATE OR DELETE ON platform_mentor_ratings FOR EACH ROW EXECUTE FUNCTION mentor_rating_keep_decision(); END IF;
END $$;
