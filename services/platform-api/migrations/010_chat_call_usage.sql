-- This ledger records one actual runtime call, not a response delta or a bill.
CREATE TABLE IF NOT EXISTS platform_chat_calls (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES platform_users(id) ON DELETE CASCADE,
  conversation_id uuid REFERENCES platform_conversations(id) ON DELETE SET NULL,
  message_id uuid REFERENCES platform_messages(id) ON DELETE SET NULL,
  call_index integer NOT NULL CHECK(call_index BETWEEN 1 AND 6),
  provider text NOT NULL, model text NOT NULL,
  status text NOT NULL DEFAULT 'running' CHECK(status IN ('running','complete','failed','cancelled','interrupted')),
  usage_status text NOT NULL DEFAULT 'pending' CHECK(usage_status IN ('pending','reported','missing','invalid')),
  input_tokens integer, output_tokens integer,
  created_at timestamptz NOT NULL DEFAULT now(), finished_at timestamptz,
  UNIQUE(message_id,call_index),
  CHECK ((usage_status='reported' AND input_tokens IS NOT NULL AND output_tokens IS NOT NULL
           AND input_tokens >= 0 AND output_tokens >= 0)
      OR (usage_status<>'reported' AND input_tokens IS NULL AND output_tokens IS NULL)),
  CHECK ((status='running' AND finished_at IS NULL AND usage_status='pending')
      OR (status<>'running' AND finished_at IS NOT NULL AND usage_status<>'pending'))
);
CREATE INDEX IF NOT EXISTS platform_chat_calls_owner ON platform_chat_calls(user_id,created_at);
