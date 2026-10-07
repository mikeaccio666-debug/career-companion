ALTER TABLE platform_goal_plan_steps
  ADD COLUMN resolved_task jsonb,
  ADD COLUMN input_sources jsonb,
  ADD CONSTRAINT platform_goal_plan_input_snapshot_pair CHECK ((resolved_task IS NULL) = (input_sources IS NULL)),
  ADD CONSTRAINT platform_goal_plan_input_sources_array CHECK (input_sources IS NULL OR jsonb_typeof(input_sources) = 'array');
