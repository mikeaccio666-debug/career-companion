-- Origins are references to server-owned assistant turns, never execution authority.
-- Deleting a conversation removes these links while keeping its jobs independent.
CREATE TABLE IF NOT EXISTS platform_conversation_tasks (
  job_id uuid PRIMARY KEY REFERENCES platform_jobs(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES platform_users(id) ON DELETE CASCADE,
  conversation_id uuid NOT NULL REFERENCES platform_conversations(id) ON DELETE CASCADE,
  message_id uuid NOT NULL REFERENCES platform_messages(id) ON DELETE CASCADE,
  tool text NOT NULL CHECK (tool IN ('create_job', 'prepare_browser_task', 'prepare_mcp_task')),
  created_generation integer NOT NULL CHECK (created_generation > 0),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS platform_conversation_tasks_page
  ON platform_conversation_tasks(user_id, conversation_id, created_at DESC, job_id DESC);
