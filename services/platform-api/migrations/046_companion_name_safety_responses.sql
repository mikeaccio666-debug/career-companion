-- Independent fixed-resource capture for actual classified name text.
-- No reviewer, activation, template, contact, grade or historical proof is seeded.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='platform_companion_name_submissions'::regclass
    AND conname='companion_name_resource_result_binding') THEN
    ALTER TABLE platform_companion_name_submissions ADD CONSTRAINT companion_name_resource_result_binding
      UNIQUE(id,user_id,generation,detector_revision,level,detector_mode);
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS platform_companion_name_safety_responses (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES platform_users(id) ON DELETE CASCADE,
  submission_id uuid NOT NULL UNIQUE,
  operation_id uuid NOT NULL,
  entry_id uuid NOT NULL,
  task_id uuid NOT NULL,
  companion_id uuid NOT NULL,
  preview_revision integer NOT NULL CHECK(preview_revision=1),
  submitted_revision integer NOT NULL CHECK(submitted_revision BETWEEN 1 AND 2147483647),
  expected_identity_revision integer NOT NULL CHECK(expected_identity_revision BETWEEN 0 AND 2147483646),
  source_generation integer NOT NULL CHECK(source_generation BETWEEN 1 AND 2147483647),
  detector_revision integer NOT NULL CHECK(detector_revision BETWEEN 1 AND 2147483647),
  level text NOT NULL CHECK(level IN ('L1','L2')),
  detector_mode text NOT NULL CHECK(detector_mode IN ('full','keyword_only')),
  status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','ready')),
  payload_ciphertext bytea CHECK(octet_length(payload_ciphertext) BETWEEN 29 AND 65565),
  bundle_revision integer CHECK(bundle_revision BETWEEN 1 AND 2147483647),
  content_digest text CHECK(content_digest ~ '^[0-9a-f]{64}$'),
  review_digest text CHECK(review_digest ~ '^[0-9a-f]{64}$'),
  locale text CHECK(locale IN ('zh','en')),
  locale_origin text CHECK(locale_origin IN ('captured_answers','default_zh')),
  prepared_at timestamptz,
  retention_until timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(id,user_id,submission_id,source_generation,detector_revision,level,detector_mode),
  FOREIGN KEY(submission_id,user_id,operation_id,entry_id,task_id,companion_id,preview_revision,submitted_revision,expected_identity_revision)
    REFERENCES platform_companion_name_submissions(id,user_id,operation_id,entry_id,task_id,companion_id,preview_revision,submitted_revision,expected_identity_revision) ON DELETE CASCADE,
  FOREIGN KEY(submission_id,user_id,source_generation,detector_revision,level,detector_mode)
    REFERENCES platform_companion_name_submissions(id,user_id,generation,detector_revision,level,detector_mode) ON DELETE CASCADE,
  CHECK((status='pending' AND payload_ciphertext IS NULL AND bundle_revision IS NULL AND content_digest IS NULL
      AND review_digest IS NULL AND locale IS NULL AND locale_origin IS NULL AND prepared_at IS NULL AND retention_until IS NULL)
    OR (status='ready' AND payload_ciphertext IS NOT NULL AND bundle_revision IS NOT NULL AND content_digest IS NOT NULL
      AND review_digest IS NOT NULL AND locale IS NOT NULL AND locale_origin IS NOT NULL
      AND prepared_at IS NOT NULL AND retention_until IS NOT NULL AND retention_until>prepared_at)),
  CHECK(locale_origin IS DISTINCT FROM 'default_zh' OR locale='zh')
);
CREATE INDEX IF NOT EXISTS companion_name_safety_response_pending
  ON platform_companion_name_safety_responses(level,created_at) WHERE status='pending';

-- Preserve the original onboarding references and FK. Each new name event has
-- its own real source/result binding; NULL never substitutes an old source.
ALTER TABLE platform_safety_events
  ADD COLUMN IF NOT EXISTS name_submission_id uuid,
  ADD COLUMN IF NOT EXISTS name_response_id uuid,
  ADD COLUMN IF NOT EXISTS name_source_generation integer,
  ALTER COLUMN submission_id DROP NOT NULL,
  ALTER COLUMN response_id DROP NOT NULL;
ALTER TABLE platform_safety_events DROP CONSTRAINT IF EXISTS platform_safety_events_source_kind_check;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='platform_safety_events'::regclass
    AND conname='platform_safety_event_source_kind') THEN
    ALTER TABLE platform_safety_events ADD CONSTRAINT platform_safety_event_source_kind
      CHECK(source_kind IN ('onboarding','companion_name'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='platform_safety_events'::regclass
    AND conname='platform_safety_event_source_shape') THEN
    ALTER TABLE platform_safety_events ADD CONSTRAINT platform_safety_event_source_shape CHECK(
      (source_kind='onboarding' AND submission_id IS NOT NULL AND response_id IS NOT NULL
        AND name_submission_id IS NULL AND name_response_id IS NULL AND name_source_generation IS NULL)
      OR (source_kind='companion_name' AND submission_id IS NULL AND response_id IS NULL
        AND name_submission_id IS NOT NULL AND name_response_id IS NOT NULL
        AND name_source_generation IS NOT NULL AND name_source_generation BETWEEN 1 AND 2147483647));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='platform_safety_events'::regclass
    AND conname='platform_safety_event_name_response_once') THEN
    ALTER TABLE platform_safety_events ADD CONSTRAINT platform_safety_event_name_response_once UNIQUE(name_response_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='platform_safety_events'::regclass
    AND conname='platform_safety_event_name_response') THEN
    ALTER TABLE platform_safety_events ADD CONSTRAINT platform_safety_event_name_response
      FOREIGN KEY(name_response_id,user_id,name_submission_id,name_source_generation,detector_revision,level,detector_mode)
      REFERENCES platform_companion_name_safety_responses(id,user_id,submission_id,source_generation,detector_revision,level,detector_mode) ON DELETE CASCADE;
  END IF;
END $$;
