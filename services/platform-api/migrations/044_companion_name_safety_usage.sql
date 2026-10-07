-- Extend the existing counts-only ledger with a concrete naming source. No policy,
-- model access, budget, approval, resource or classification result is seeded.
ALTER TABLE platform_safety_model_usage
  ADD COLUMN source_kind text NOT NULL DEFAULT 'onboarding'
    CHECK (source_kind IN ('onboarding','companion_name')),
  ADD COLUMN entry_id uuid,
  ADD COLUMN task_id uuid,
  ADD COLUMN companion_id uuid,
  ADD COLUMN preview_revision integer,
  ADD COLUMN expected_identity_revision integer,
  ADD COLUMN name_execution_token uuid,
  ALTER COLUMN draft_id DROP NOT NULL,
  ALTER COLUMN question_id DROP NOT NULL;

ALTER TABLE platform_safety_model_usage DROP CONSTRAINT platform_safety_model_usage_submitted_revision_check;
ALTER TABLE platform_safety_model_usage ADD CONSTRAINT platform_safety_usage_submitted_revision
  CHECK (submitted_revision BETWEEN 1 AND 2147483647);

ALTER TABLE platform_safety_model_usage ADD CONSTRAINT platform_safety_usage_source_shape CHECK (
  (source_kind='onboarding' AND submitted_revision>=2 AND draft_id IS NOT NULL AND question_id IS NOT NULL
    AND entry_id IS NULL AND task_id IS NULL AND companion_id IS NULL
    AND preview_revision IS NULL AND expected_identity_revision IS NULL AND name_execution_token IS NULL)
  OR (source_kind='companion_name' AND draft_id IS NULL AND question_id IS NULL
    AND entry_id IS NOT NULL AND task_id IS NOT NULL AND companion_id IS NOT NULL
    AND preview_revision IS NOT NULL AND preview_revision=1
    AND expected_identity_revision IS NOT NULL AND expected_identity_revision BETWEEN 0 AND 2147483647
    AND name_execution_token IS NOT NULL)
);

-- The original onboarding FK remains. Its nullable branch is paired with this
-- exact naming FK and the closed shape above, so neither branch can omit a source.
ALTER TABLE platform_safety_model_usage ADD CONSTRAINT platform_safety_usage_name_source
  FOREIGN KEY (submission_id,user_id,operation_id,entry_id,task_id,companion_id,
    preview_revision,submitted_revision,expected_identity_revision)
  REFERENCES platform_companion_name_submissions(id,user_id,operation_id,entry_id,
    task_id,companion_id,preview_revision,submitted_revision,expected_identity_revision)
  ON DELETE CASCADE;
