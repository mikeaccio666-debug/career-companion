-- Plan confirmation fixes a definition; it never grants a child task approval.
CREATE TABLE platform_goal_plans (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES platform_users(id) ON DELETE CASCADE,
  conversation_id uuid NOT NULL REFERENCES platform_conversations(id) ON DELETE CASCADE,
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','active','paused','cancelled')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX platform_goal_plans_owner ON platform_goal_plans(user_id,conversation_id,created_at DESC,id DESC);
CREATE TABLE platform_goal_plan_revisions (
  plan_id uuid NOT NULL REFERENCES platform_goal_plans(id) ON DELETE CASCADE,
  revision integer NOT NULL CHECK (revision > 0),
  title text NOT NULL,
  goal text NOT NULL,
  definition_hash text NOT NULL CHECK (definition_hash ~ '^[a-f0-9]{64}$'),
  confirmed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (plan_id,revision)
);
CREATE TABLE platform_goal_plan_steps (
  plan_id uuid NOT NULL,
  revision integer NOT NULL,
  step_index integer NOT NULL CHECK (step_index BETWEEN 0 AND 7),
  input jsonb NOT NULL,
  input_hash text NOT NULL CHECK (input_hash ~ '^[a-f0-9]{64}$'),
  job_id uuid UNIQUE REFERENCES platform_jobs(id) ON DELETE SET NULL,
  job_generation integer CHECK (job_generation > 0),
  message_id uuid UNIQUE REFERENCES platform_messages(id) ON DELETE SET NULL,
  bound_at timestamptz,
  receipt jsonb,
  PRIMARY KEY (plan_id,revision,step_index),
  FOREIGN KEY (plan_id,revision) REFERENCES platform_goal_plan_revisions(plan_id,revision) ON DELETE CASCADE,
  CHECK (job_id IS NULL OR message_id IS NULL),
  CHECK (job_id IS NULL OR job_generation IS NOT NULL)
);
