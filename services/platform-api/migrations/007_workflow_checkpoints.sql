CREATE TABLE IF NOT EXISTS platform_workflow_checkpoints (
  job_id uuid PRIMARY KEY REFERENCES platform_jobs(id) ON DELETE CASCADE,
  definition_hash text NOT NULL,
  revision integer NOT NULL DEFAULT 0 CHECK (revision >= 0),
  steps jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS platform_workflow_step_ledger (
  id bigserial PRIMARY KEY,
  job_id uuid NOT NULL REFERENCES platform_jobs(id) ON DELETE CASCADE,
  revision integer NOT NULL,
  generation integer NOT NULL,
  step_index integer NOT NULL CHECK (step_index BETWEEN 0 AND 7),
  input_hash text NOT NULL,
  event_type text NOT NULL CHECK (event_type IN ('started','provider_task','completed','failed','uncertain')),
  provider_task_id text,
  error_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(job_id, revision)
);
CREATE INDEX IF NOT EXISTS platform_workflow_step_ledger_job ON platform_workflow_step_ledger(job_id, step_index, revision);
