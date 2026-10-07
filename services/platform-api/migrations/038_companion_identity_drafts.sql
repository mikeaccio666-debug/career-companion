-- Internal name/candidate preparation only. No chosen seal, birth, room,
-- reroll entitlement, resource approval or user input is seeded.
-- Reviewed server vocabulary is not user data; retain its exact snapshot so
-- historical private drafts do not change when configured assets change.
CREATE TABLE platform_companion_identity_assets (
  content_digest text NOT NULL CHECK (content_digest ~ '^[0-9a-f]{64}$'),
  review_digest text NOT NULL CHECK (review_digest ~ '^[0-9a-f]{64}$'),
  revision integer NOT NULL CHECK (revision BETWEEN 1 AND 2147483647),
  bundle_json text NOT NULL CHECK (octet_length(bundle_json) BETWEEN 1 AND 262144),
  review_json text NOT NULL CHECK (octet_length(review_json) BETWEEN 1 AND 32768),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(content_digest,review_digest),
  UNIQUE(revision,content_digest,review_digest)
);
CREATE TABLE platform_companion_identity_drafts (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES platform_users(id) ON DELETE CASCADE,
  companion_id uuid NOT NULL UNIQUE,
  task_id uuid NOT NULL UNIQUE,
  preview_revision integer NOT NULL CHECK (preview_revision=1),
  revision integer NOT NULL CHECK (revision BETWEEN 1 AND 2147483647),
  bundle_revision integer NOT NULL CHECK (bundle_revision BETWEEN 1 AND 2147483647),
  content_digest text NOT NULL,
  review_digest text NOT NULL,
  payload_ciphertext bytea NOT NULL CHECK (octet_length(payload_ciphertext) BETWEEN 29 AND 65565),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(id,user_id),
  FOREIGN KEY(task_id,user_id,companion_id) REFERENCES platform_companion_generation_tasks(id,user_id,companion_id) ON DELETE CASCADE,
  FOREIGN KEY(companion_id,preview_revision) REFERENCES platform_companion_revisions(companion_id,revision) ON DELETE CASCADE,
  FOREIGN KEY(bundle_revision,content_digest,review_digest) REFERENCES platform_companion_identity_assets(revision,content_digest,review_digest)
);
CREATE TABLE platform_companion_identity_operations (
  user_id uuid NOT NULL REFERENCES platform_users(id) ON DELETE CASCADE,
  operation_id uuid NOT NULL,
  draft_id uuid NOT NULL,
  applied_revision integer NOT NULL CHECK (applied_revision BETWEEN 1 AND 2147483647),
  request_ciphertext bytea NOT NULL CHECK (octet_length(request_ciphertext) BETWEEN 29 AND 65565),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(user_id,operation_id),
  FOREIGN KEY(draft_id,user_id) REFERENCES platform_companion_identity_drafts(id,user_id) ON DELETE CASCADE
);
