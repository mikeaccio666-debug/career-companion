-- A model may propose one editable draft per server-bound assistant response.
-- Editing/confirmation later does not alter the immutable proposal input identity.
CREATE TABLE platform_goal_plan_proposals (
  plan_id uuid PRIMARY KEY REFERENCES platform_goal_plans(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES platform_users(id) ON DELETE CASCADE,
  conversation_id uuid NOT NULL REFERENCES platform_conversations(id) ON DELETE CASCADE,
  message_id uuid UNIQUE REFERENCES platform_messages(id) ON DELETE SET NULL,
  input_hash text NOT NULL CHECK (input_hash ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX platform_goal_plan_proposals_owner ON platform_goal_plan_proposals(user_id,conversation_id,created_at DESC,plan_id DESC);
