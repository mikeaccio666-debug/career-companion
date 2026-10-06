-- Human observations are separate from execution facts. No execution table is updated.
CREATE TABLE platform_job_outcome_reviews (
  id uuid PRIMARY KEY,
  job_id uuid NOT NULL REFERENCES platform_jobs(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES platform_users(id) ON DELETE CASCADE,
  generation integer NOT NULL CHECK (generation > 0),
  revision integer NOT NULL CHECK (revision > 0),
  request_id uuid NOT NULL,
  request_hash text NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  evidence_version text NOT NULL CHECK (evidence_version ~ '^[a-f0-9]{64}$'),
  outcome text NOT NULL CHECK (outcome IN ('observed_effect','no_effect_observed','still_unknown')),
  note text CHECK (note IS NULL OR (char_length(note) <= 2000 AND octet_length(note) <= 8192)),
  provenance text NOT NULL DEFAULT 'user_reported' CHECK (provenance = 'user_reported'),
  verified boolean NOT NULL DEFAULT false CHECK (verified = false),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (job_id, generation, revision),
  UNIQUE (user_id, request_id)
);
CREATE INDEX platform_job_outcome_reviews_owner ON platform_job_outcome_reviews(user_id, job_id, generation, revision DESC);
