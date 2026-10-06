CREATE TABLE IF NOT EXISTS platform_browser_checkpoints (
  job_id uuid PRIMARY KEY REFERENCES platform_jobs(id) ON DELETE CASCADE,
  definition_hash text NOT NULL,
  total_actions integer NOT NULL CHECK (total_actions BETWEEN 1 AND 12),
  revision integer NOT NULL DEFAULT 0 CHECK (revision >= 0),
  next_index integer NOT NULL DEFAULT 0 CHECK (next_index >= 0),
  state text NOT NULL DEFAULT 'ready' CHECK (state IN ('ready','started','completed','uncertain')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (next_index <= total_actions)
);
CREATE TABLE IF NOT EXISTS platform_browser_action_ledger (
  id bigserial PRIMARY KEY,
  job_id uuid NOT NULL REFERENCES platform_jobs(id) ON DELETE CASCADE,
  revision integer NOT NULL,
  generation integer NOT NULL,
  action_index integer NOT NULL CHECK (action_index BETWEEN 0 AND 11),
  event_type text NOT NULL CHECK (event_type IN ('started','completed','uncertain')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(job_id, revision)
);
CREATE INDEX IF NOT EXISTS platform_browser_action_ledger_job ON platform_browser_action_ledger(job_id, revision);
