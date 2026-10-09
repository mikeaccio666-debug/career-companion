-- Product 07 §7.5. Only the first three real career sources are enabled here.
-- No body, title, URL, provider data, source object identifier or credentials.
CREATE TABLE platform_product_events (
 id uuid PRIMARY KEY,
 user_id uuid NOT NULL REFERENCES platform_users(id) ON DELETE CASCADE,
 event text NOT NULL CHECK (event IN ('application_stage_changed','story_saved','resume_version_created')),
 props jsonb NOT NULL,
 channel text NOT NULL CHECK (channel='web'),
 occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CHECK (jsonb_typeof(props)='object' AND (
  (event='application_stage_changed'
   AND props ?& ARRAY['from_stage','to_stage','closed_reason']
   AND props - ARRAY['from_stage','to_stage','closed_reason'] = '{}'::jsonb
   AND props->>'from_stage' IN ('saved','applied','oa','interview','offer','closed')
   AND props->>'to_stage' IN ('saved','applied','oa','interview','offer','closed')
   AND props->>'closed_reason' IN ('none','not_advanced','withdrawn','role_closed','no_response','declined','rescinded')
   AND ((props->>'to_stage'='closed') = (props->>'closed_reason'<>'none')))
  OR (event='story_saved' AND props='{"source":"user_entered"}'::jsonb)
  OR (event='resume_version_created' AND props IN ('{"source":"paste"}'::jsonb,'{"source":"upload"}'::jsonb,'{"source":"derived"}'::jsonb))
 ) IS TRUE)
);
CREATE INDEX platform_product_events_owner ON platform_product_events(user_id,id);
CREATE INDEX platform_product_events_retention ON platform_product_events(occurred_at,id);
CREATE FUNCTION platform_product_events_no_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Product events are append-only'; END $$;
CREATE TRIGGER platform_product_events_no_update BEFORE UPDATE ON platform_product_events
 FOR EACH ROW EXECUTE FUNCTION platform_product_events_no_update();
