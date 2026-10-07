-- Empty by design. Only an explicit human-reviewed operator transaction can
-- bind the complete eligible tier-one domain and activate it. No seed or API.
CREATE TABLE platform_companion_identity_policy (
  singleton boolean PRIMARY KEY CHECK (singleton),
  revision integer NOT NULL CHECK (revision BETWEEN 1 AND 2147483647),
  content_digest text NOT NULL CHECK (length(content_digest)=64 AND content_digest ~ '^[0-9a-f]{64}$'),
  review_digest text NOT NULL CHECK (length(review_digest)=64 AND review_digest ~ '^[0-9a-f]{64}$'),
  reviewed_by uuid NOT NULL REFERENCES platform_users(id) ON DELETE RESTRICT,
  org_id uuid NOT NULL REFERENCES platform_orgs(id) ON DELETE RESTRICT,
  activated_by uuid NOT NULL REFERENCES platform_users(id) ON DELETE RESTRICT,
  activated_at timestamptz NOT NULL
);
