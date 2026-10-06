ALTER TABLE platform_jobs DROP CONSTRAINT platform_jobs_kind_check;
ALTER TABLE platform_jobs ADD CONSTRAINT platform_jobs_kind_check
  CHECK (kind IN ('image','video','speech','browser','cli','workflow','mcp'));

CREATE TABLE platform_mcp_connections (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES platform_users(id) ON DELETE CASCADE,
  catalog_id text NOT NULL,
  name text NOT NULL,
  status text NOT NULL CHECK (status IN ('connected','revoked')),
  grant_version integer NOT NULL CHECK (grant_version > 0),
  policy_hash text NOT NULL CHECK (policy_hash ~ '^[a-f0-9]{64}$'),
  tools jsonb NOT NULL DEFAULT '[]',
  discovered_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, catalog_id)
);

-- A call that crossed this durable boundary is never replayed by ordinary retry.
CREATE TABLE platform_mcp_receipts (
  job_id uuid PRIMARY KEY REFERENCES platform_jobs(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES platform_users(id) ON DELETE CASCADE,
  connection_id uuid NOT NULL REFERENCES platform_mcp_connections(id),
  generation integer NOT NULL CHECK (generation > 0),
  grant_version integer NOT NULL CHECK (grant_version > 0),
  tool_name text NOT NULL,
  schema_hash text NOT NULL CHECK (schema_hash ~ '^[a-f0-9]{64}$'),
  definition_hash text NOT NULL CHECK (definition_hash ~ '^[a-f0-9]{64}$'),
  arguments_hash text NOT NULL CHECK (arguments_hash ~ '^[a-f0-9]{64}$'),
  status text NOT NULL CHECK (status IN ('started','completed','tool_error','uncertain')),
  artifact_id uuid REFERENCES platform_artifacts(id),
  response_hash text CHECK (response_hash IS NULL OR response_hash ~ '^[a-f0-9]{64}$'),
  error_code text,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  CHECK ((status IN ('completed','tool_error')) = (artifact_id IS NOT NULL AND response_hash IS NOT NULL))
);
CREATE INDEX platform_mcp_receipts_owner ON platform_mcp_receipts(user_id, started_at DESC);
