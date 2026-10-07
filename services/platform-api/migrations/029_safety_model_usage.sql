-- Counts-only records for actual safety model calls. No budget, activation, request content or credentials are seeded.
-- Immutable submission coordinates remain valid when a later generation claims the same submission.
ALTER TABLE platform_onboarding_safety_submissions ADD CONSTRAINT platform_onboarding_safety_usage_binding
  UNIQUE (id,user_id,operation_id,draft_id,question_id,submitted_revision);
CREATE TABLE platform_safety_model_usage (
  call_id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES platform_users(id) ON DELETE CASCADE,
  submission_id uuid NOT NULL,
  operation_id uuid NOT NULL,
  draft_id uuid NOT NULL,
  question_id text NOT NULL,
  submitted_revision integer NOT NULL CHECK (submitted_revision BETWEEN 2 AND 2147483647),
  generation integer NOT NULL CHECK (generation BETWEEN 1 AND 2147483647),
  auth_version bigint NOT NULL CHECK (auth_version>=0),
  detector_revision integer NOT NULL CHECK (detector_revision BETWEEN 1 AND 2147483647),
  call_index integer NOT NULL CHECK (call_index=1),
  provider text NOT NULL CHECK (length(provider) BETWEEN 1 AND 80),
  model text NOT NULL CHECK (length(model) BETWEEN 1 AND 150),
  purpose text NOT NULL CHECK (purpose='safety_classify'),
  status text NOT NULL DEFAULT 'prepared' CHECK (status IN ('prepared','admitted','complete','failed','cancelled','interrupted')),
  usage_status text NOT NULL DEFAULT 'pending' CHECK (usage_status IN ('pending','reported','missing','invalid')),
  input_tokens integer CHECK (input_tokens BETWEEN 0 AND 2147483647),
  output_tokens integer CHECK (output_tokens BETWEEN 0 AND 2147483647),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  admitted_at timestamptz,
  finished_at timestamptz,
  UNIQUE (submission_id,generation),
  FOREIGN KEY (submission_id,user_id,operation_id,draft_id,question_id,submitted_revision)
    REFERENCES platform_onboarding_safety_submissions(id,user_id,operation_id,draft_id,question_id,submitted_revision) ON DELETE CASCADE,
  CHECK (status<>'complete' OR admitted_at IS NOT NULL),
  CHECK ((usage_status='reported' AND input_tokens IS NOT NULL AND output_tokens IS NOT NULL)
    OR (usage_status<>'reported' AND input_tokens IS NULL AND output_tokens IS NULL)),
  CHECK ((status='prepared' AND admitted_at IS NULL AND finished_at IS NULL AND usage_status='pending')
    OR (status='admitted' AND admitted_at IS NOT NULL AND finished_at IS NULL AND usage_status='pending')
    OR (status IN ('complete','failed','cancelled','interrupted') AND finished_at IS NOT NULL AND usage_status<>'pending'))
);
CREATE INDEX platform_safety_model_usage_owner_day ON platform_safety_model_usage(user_id,created_at);
