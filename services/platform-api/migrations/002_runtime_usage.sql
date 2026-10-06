CREATE TABLE IF NOT EXISTS platform_runtime_leases (
  id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES platform_users(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK(kind IN ('chat','voice')), expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS platform_runtime_leases_owner ON platform_runtime_leases(user_id,kind,expires_at);
CREATE TABLE IF NOT EXISTS platform_usage (
  id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES platform_users(id) ON DELETE CASCADE,
  conversation_id uuid REFERENCES platform_conversations(id) ON DELETE SET NULL,
  message_id uuid REFERENCES platform_messages(id) ON DELETE SET NULL,
  provider text NOT NULL, model text, capability text NOT NULL DEFAULT 'chat',
  input_tokens integer NOT NULL DEFAULT 0, output_tokens integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(), CHECK(input_tokens >= 0), CHECK(output_tokens >= 0)
);
CREATE INDEX IF NOT EXISTS platform_usage_owner ON platform_usage(user_id,created_at);
