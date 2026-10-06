ALTER TABLE platform_approvals ADD COLUMN IF NOT EXISTS generation integer NOT NULL DEFAULT 1;
CREATE INDEX IF NOT EXISTS platform_approvals_job_generation ON platform_approvals(job_id,generation,status);
