-- Bind each review/rewrite to the immediately preceding authenticated result.
ALTER TABLE platform_first_letter_stages DROP CONSTRAINT platform_first_letter_stages_stage_check;
ALTER TABLE platform_first_letter_stages ADD CONSTRAINT platform_first_letter_stages_stage_check
 CHECK(stage IN ('write_original','review_original','rewrite','review_rewrite'));
ALTER TABLE platform_first_letter_stages ADD COLUMN predecessor_id uuid;
ALTER TABLE platform_first_letter_stages ADD COLUMN predecessor_digest text;
ALTER TABLE platform_first_letter_stages ADD COLUMN request_digest text;
ALTER TABLE platform_first_letter_stages ADD UNIQUE(id,user_id,task_id);
ALTER TABLE platform_first_letter_stages ADD FOREIGN KEY(predecessor_id,user_id,task_id)
 REFERENCES platform_first_letter_stages(id,user_id,task_id) ON DELETE CASCADE;
ALTER TABLE platform_first_letter_stages ADD CONSTRAINT first_letter_stage_dependency CHECK(
 (stage='write_original' AND predecessor_id IS NULL AND predecessor_digest IS NULL AND request_digest IS NULL)
 OR(stage<>'write_original' AND predecessor_id IS NOT NULL AND predecessor_id<>id
  AND predecessor_digest IS NOT NULL AND predecessor_digest ~ '^[a-f0-9]{64}$'
  AND request_digest IS NOT NULL AND request_digest ~ '^[a-f0-9]{64}$'));
