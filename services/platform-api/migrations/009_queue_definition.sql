ALTER TABLE platform_job_outbox ADD COLUMN IF NOT EXISTS definition_hash text;
ALTER TABLE platform_job_outbox ADD CONSTRAINT platform_job_outbox_definition_hash
  CHECK (definition_hash IS NULL OR definition_hash ~ '^[a-f0-9]{64}$');
CREATE INDEX IF NOT EXISTS platform_job_outbox_dispatch ON platform_job_outbox(dispatched_at, created_at);
