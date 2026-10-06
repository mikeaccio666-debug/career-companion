ALTER TABLE platform_jobs ADD COLUMN IF NOT EXISTS execution_policy jsonb NOT NULL DEFAULT '{}';

CREATE TABLE IF NOT EXISTS platform_model_relay_requests (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES platform_users(id) ON DELETE CASCADE,
  job_id uuid NOT NULL REFERENCES platform_jobs(id) ON DELETE CASCADE,
  generation integer NOT NULL,
  request_id text NOT NULL,
  provider text NOT NULL DEFAULT 'openai', model text NOT NULL,
  reserved_tokens integer NOT NULL CHECK(reserved_tokens > 0),
  input_tokens integer, output_tokens integer,
  status text NOT NULL CHECK(status IN ('reserved','succeeded','failed','uncertain')),
  error_code text, created_at timestamptz NOT NULL DEFAULT now(), finished_at timestamptz,
  UNIQUE(job_id,generation,request_id),
  CHECK(input_tokens IS NULL OR input_tokens >= 0),
  CHECK(output_tokens IS NULL OR output_tokens >= 0)
);
CREATE INDEX IF NOT EXISTS platform_model_relay_owner ON platform_model_relay_requests(user_id,created_at);
CREATE INDEX IF NOT EXISTS platform_model_relay_job ON platform_model_relay_requests(job_id);
