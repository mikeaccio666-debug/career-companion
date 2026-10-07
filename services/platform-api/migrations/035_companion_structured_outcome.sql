-- A completed provider response can fail local content validation. This is not
-- a successful model output or permission to publish; actual admitted call and
-- cost receipts are still required. Legacy failed calls gain no inferred proof.
ALTER TABLE platform_companion_generation_calls ADD COLUMN structured_outcome text;
ALTER TABLE platform_companion_generation_calls ADD CONSTRAINT platform_companion_structured_outcome_state
  CHECK (structured_outcome IS NULL OR (structured_outcome='invalid_format' AND status='failed'
    AND admitted_at IS NOT NULL AND finished_at IS NOT NULL AND usage_status<>'pending'));
