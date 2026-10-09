-- Counts only. Historical unknown cache use is deliberately not backfilled as zero.
ALTER TABLE platform_chat_calls
  ADD COLUMN cached_input_tokens integer,
  ADD COLUMN cache_write_input_tokens integer,
  ADD CONSTRAINT platform_chat_calls_cache_counts CHECK (
    (cached_input_tokens IS NULL OR (usage_status='reported' AND input_tokens IS NOT NULL AND cached_input_tokens BETWEEN 0 AND input_tokens))
    AND (cache_write_input_tokens IS NULL OR (usage_status='reported' AND input_tokens IS NOT NULL AND cache_write_input_tokens BETWEEN 0 AND input_tokens))
    AND (COALESCE(cached_input_tokens,0)::bigint + COALESCE(cache_write_input_tokens,0)::bigint <= COALESCE(input_tokens,0))
  );
ALTER TABLE platform_safety_model_usage
  ADD COLUMN cached_input_tokens integer,
  ADD COLUMN cache_write_input_tokens integer,
  ADD CONSTRAINT platform_safety_model_usage_cache_counts CHECK (
    (cached_input_tokens IS NULL OR (usage_status='reported' AND input_tokens IS NOT NULL AND cached_input_tokens BETWEEN 0 AND input_tokens))
    AND (cache_write_input_tokens IS NULL OR (usage_status='reported' AND input_tokens IS NOT NULL AND cache_write_input_tokens BETWEEN 0 AND input_tokens))
    AND (COALESCE(cached_input_tokens,0)::bigint + COALESCE(cache_write_input_tokens,0)::bigint <= COALESCE(input_tokens,0))
  );
ALTER TABLE platform_companion_generation_calls
  ADD COLUMN cached_input_tokens integer,
  ADD COLUMN cache_write_input_tokens integer,
  ADD CONSTRAINT platform_companion_generation_calls_cache_counts CHECK (
    (cached_input_tokens IS NULL OR (usage_status='reported' AND input_tokens IS NOT NULL AND cached_input_tokens BETWEEN 0 AND input_tokens))
    AND (cache_write_input_tokens IS NULL OR (usage_status='reported' AND input_tokens IS NOT NULL AND cache_write_input_tokens BETWEEN 0 AND input_tokens))
    AND (COALESCE(cached_input_tokens,0)::bigint + COALESCE(cache_write_input_tokens,0)::bigint <= COALESCE(input_tokens,0))
  );
