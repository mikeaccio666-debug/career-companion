-- Coordinates survive account deletion until acknowledged writes are gone.
-- Unknown writes cannot be declared erased merely because HEAD returned 404.
CREATE TABLE platform_upload_writes (
 id uuid PRIMARY KEY,user_id uuid NOT NULL,status text NOT NULL CHECK(status IN ('writing','ready','cleanup')),
 revision integer NOT NULL CHECK(revision>0),last_event_id uuid NOT NULL,
 publish_until timestamptz NOT NULL,lease_until timestamptz,record_ciphertext bytea NOT NULL
);
CREATE TABLE platform_upload_write_events (
 write_id uuid NOT NULL REFERENCES platform_upload_writes(id) ON DELETE CASCADE,
 id uuid NOT NULL,revision integer NOT NULL,ciphertext bytea NOT NULL,
 PRIMARY KEY(write_id,revision),UNIQUE(write_id,id,revision)
);
ALTER TABLE platform_upload_writes ADD CONSTRAINT upload_write_latest_event
 FOREIGN KEY(id,last_event_id,revision) REFERENCES platform_upload_write_events(write_id,id,revision) DEFERRABLE INITIALLY DEFERRED;
CREATE FUNCTION upload_write_keep_event() RETURNS trigger AS $$ BEGIN
 IF TG_OP='DELETE' AND NOT EXISTS(SELECT 1 FROM platform_upload_writes WHERE id=OLD.write_id) THEN RETURN OLD; END IF;
 RAISE EXCEPTION 'Upload write history is immutable' USING ERRCODE='42501';
END $$ LANGUAGE plpgsql;
CREATE TRIGGER upload_write_event_immutable BEFORE UPDATE OR DELETE ON platform_upload_write_events
 FOR EACH ROW EXECUTE FUNCTION upload_write_keep_event();
CREATE INDEX upload_write_recovery ON platform_upload_writes(lease_until,publish_until,id);
CREATE INDEX upload_write_owner ON platform_upload_writes(user_id);
