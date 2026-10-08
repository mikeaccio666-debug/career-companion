-- Retain cleanup coordinates after account deletion until the actual file is gone.
-- No original bytes are stored; source coordinates and names are encrypted.
CREATE TABLE IF NOT EXISTS platform_upload_removals (
 upload_id uuid PRIMARY KEY,user_id uuid NOT NULL,operation_id uuid NOT NULL,
 status text NOT NULL CHECK(status IN ('pending','removed')),generation integer NOT NULL CHECK(generation>0),
 last_event_id uuid NOT NULL,lease_until timestamptz,record_ciphertext bytea NOT NULL CHECK(octet_length(record_ciphertext)>=29),
 requested_at timestamptz NOT NULL,removed_at timestamptz,
 UNIQUE(user_id,operation_id),CHECK((status='removed')=(removed_at IS NOT NULL)));
CREATE TABLE IF NOT EXISTS platform_upload_removal_events (
 upload_id uuid NOT NULL REFERENCES platform_upload_removals(upload_id) ON DELETE CASCADE,user_id uuid NOT NULL,
 id uuid NOT NULL,generation integer NOT NULL CHECK(generation>0),ciphertext bytea NOT NULL CHECK(octet_length(ciphertext)>=29),
 created_at timestamptz NOT NULL,PRIMARY KEY(upload_id,generation),UNIQUE(upload_id,id,generation));
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conname='upload_removal_latest_event' AND conrelid='platform_upload_removals'::regclass) THEN
 ALTER TABLE platform_upload_removals ADD CONSTRAINT upload_removal_latest_event FOREIGN KEY(upload_id,last_event_id,generation)
 REFERENCES platform_upload_removal_events(upload_id,id,generation) DEFERRABLE INITIALLY DEFERRED;END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgname='upload_removal_event_immutable' AND tgrelid='platform_upload_removal_events'::regclass) THEN
 CREATE TRIGGER upload_removal_event_immutable BEFORE UPDATE OR DELETE ON platform_upload_removal_events FOR EACH ROW EXECUTE FUNCTION shared_memory_keep_receipt();END IF;
END $$;
CREATE INDEX IF NOT EXISTS upload_removal_recovery ON platform_upload_removals(status,lease_until,requested_at);
CREATE INDEX IF NOT EXISTS upload_removal_owner_page ON platform_upload_removals(user_id,requested_at DESC,upload_id DESC);
