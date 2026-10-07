-- No detector profile, approval or active policy is seeded by this migration.
-- Explicit activation binds reviewed file content and review metadata to an actual account.
CREATE TABLE IF NOT EXISTS platform_safety_detector_policy (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  revision integer NOT NULL CHECK (revision BETWEEN 1 AND 2147483647),
  content_digest text NOT NULL CHECK (length(content_digest)=64 AND content_digest ~ '^[0-9a-f]{64}$'),
  review_digest text NOT NULL CHECK (length(review_digest)=64 AND review_digest ~ '^[0-9a-f]{64}$'),
  activated_at timestamptz NOT NULL,
  activated_by uuid NOT NULL REFERENCES platform_users(id) ON DELETE RESTRICT
);
