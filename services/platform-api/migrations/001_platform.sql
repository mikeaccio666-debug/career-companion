CREATE TABLE IF NOT EXISTS platform_users (
  id uuid PRIMARY KEY, email text NOT NULL UNIQUE, name text NOT NULL,
  password_hash text NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS platform_sessions (
  token_hash text PRIMARY KEY, user_id uuid NOT NULL REFERENCES platform_users(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS platform_sessions_expiry ON platform_sessions(expires_at);
CREATE TABLE IF NOT EXISTS platform_conversations (
  id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES platform_users(id) ON DELETE CASCADE,
  title text NOT NULL, mode text NOT NULL CHECK (mode IN ('chat','companion','agent')),
  persona text, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS platform_conversations_owner ON platform_conversations(user_id, updated_at DESC);
CREATE TABLE IF NOT EXISTS platform_messages (
  id uuid PRIMARY KEY, conversation_id uuid NOT NULL REFERENCES platform_conversations(id) ON DELETE CASCADE,
  ordinal bigserial NOT NULL,
  role text NOT NULL CHECK (role IN ('user','assistant','tool')), content text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'complete' CHECK (status IN ('streaming','complete','failed','cancelled')),
  provider text, model text, attachments jsonb NOT NULL DEFAULT '[]',
  lease_until timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS platform_messages_conversation ON platform_messages(conversation_id, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS platform_one_stream_per_conversation ON platform_messages(conversation_id) WHERE status='streaming';
CREATE TABLE IF NOT EXISTS platform_memories (
  id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES platform_users(id) ON DELETE CASCADE,
  content text NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS platform_uploads (
  id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES platform_users(id) ON DELETE CASCADE,
  filename text NOT NULL, mime text NOT NULL, byte_size bigint NOT NULL, storage_key text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS platform_jobs (
  id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES platform_users(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK(kind IN ('image','video','speech','browser','cli','workflow')),
  provider text NOT NULL, model text, prompt text NOT NULL, options jsonb NOT NULL DEFAULT '{}',
  attachment_ids jsonb NOT NULL DEFAULT '[]',
  status text NOT NULL CHECK(status IN ('needs_approval','queued','running','succeeded','failed','cancelled','uncertain')),
  requires_approval boolean NOT NULL DEFAULT false,
  generation integer NOT NULL DEFAULT 1, attempt_count integer NOT NULL DEFAULT 0,
  progress integer NOT NULL DEFAULT 0 CHECK(progress BETWEEN 0 AND 100),
  provider_task_id text, error_code text, error_message text,
  lease_token uuid, lease_until timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS platform_jobs_owner ON platform_jobs(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS platform_jobs_recovery ON platform_jobs(status, lease_until);
CREATE TABLE IF NOT EXISTS platform_approvals (
  id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES platform_users(id) ON DELETE CASCADE,
  job_id uuid REFERENCES platform_jobs(id) ON DELETE CASCADE,
  conversation_id uuid REFERENCES platform_conversations(id) ON DELETE CASCADE,
  tool_name text NOT NULL, args jsonb NOT NULL DEFAULT '{}',
  status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected','expired')),
  created_at timestamptz NOT NULL DEFAULT now(), decided_at timestamptz,
  CHECK (job_id IS NOT NULL OR conversation_id IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS platform_approvals_owner ON platform_approvals(user_id, created_at DESC);
CREATE TABLE IF NOT EXISTS platform_job_attempts (
  id uuid PRIMARY KEY, job_id uuid NOT NULL REFERENCES platform_jobs(id) ON DELETE CASCADE,
  generation integer NOT NULL, attempt integer NOT NULL,
  status text NOT NULL CHECK(status IN ('running','succeeded','failed','cancelled','uncertain')),
  provider_task_id text, error_code text,
  started_at timestamptz NOT NULL DEFAULT now(), finished_at timestamptz,
  UNIQUE(job_id, generation, attempt)
);
CREATE TABLE IF NOT EXISTS platform_artifacts (
  id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES platform_users(id) ON DELETE CASCADE,
  job_id uuid REFERENCES platform_jobs(id) ON DELETE CASCADE,
  kind text NOT NULL, mime text, filename text,
  upload_id uuid REFERENCES platform_uploads(id), external_url text, metadata jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS platform_job_outbox (
  job_id uuid NOT NULL REFERENCES platform_jobs(id) ON DELETE CASCADE,
  generation integer NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), dispatched_at timestamptz,
  PRIMARY KEY (job_id, generation)
);
