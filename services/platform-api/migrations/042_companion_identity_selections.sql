-- Internal explicit choice of an existing saved candidate. No candidate,
-- selection, review, activation, birth or authority is seeded by this migration.
-- Name and selection revisions remain independent. A name change invalidates
-- the old choice by identity_revision while preserving its encrypted evidence.
CREATE TABLE platform_companion_identity_selections (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES platform_users(id) ON DELETE CASCADE,
  draft_id uuid NOT NULL UNIQUE,
  companion_id uuid NOT NULL UNIQUE,
  task_id uuid NOT NULL UNIQUE,
  preview_revision integer NOT NULL CHECK (preview_revision=1),
  identity_revision integer NOT NULL CHECK (identity_revision BETWEEN 1 AND 2147483647),
  revision integer NOT NULL CHECK (revision BETWEEN 1 AND 2147483647),
  bundle_revision integer NOT NULL CHECK (bundle_revision BETWEEN 1 AND 2147483647),
  content_digest text NOT NULL,
  review_digest text NOT NULL,
  payload_ciphertext bytea NOT NULL CHECK (octet_length(payload_ciphertext) BETWEEN 29 AND 65565),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(id,user_id),
  FOREIGN KEY(draft_id,user_id) REFERENCES platform_companion_identity_drafts(id,user_id) ON DELETE CASCADE,
  FOREIGN KEY(task_id,user_id,companion_id) REFERENCES platform_companion_generation_tasks(id,user_id,companion_id) ON DELETE CASCADE,
  FOREIGN KEY(companion_id,preview_revision) REFERENCES platform_companion_revisions(companion_id,revision) ON DELETE CASCADE,
  FOREIGN KEY(bundle_revision,content_digest,review_digest) REFERENCES platform_companion_identity_assets(revision,content_digest,review_digest)
);
CREATE TABLE platform_companion_identity_selection_operations (
  user_id uuid NOT NULL REFERENCES platform_users(id) ON DELETE CASCADE,
  operation_id uuid NOT NULL,
  selection_id uuid NOT NULL,
  identity_revision integer NOT NULL CHECK (identity_revision BETWEEN 1 AND 2147483647),
  applied_revision integer NOT NULL CHECK (applied_revision BETWEEN 1 AND 2147483647),
  bundle_revision integer NOT NULL CHECK (bundle_revision BETWEEN 1 AND 2147483647),
  content_digest text NOT NULL,
  review_digest text NOT NULL,
  request_ciphertext bytea NOT NULL CHECK (octet_length(request_ciphertext) BETWEEN 29 AND 65565),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(user_id,operation_id),
  UNIQUE(selection_id,applied_revision),
  FOREIGN KEY(selection_id,user_id) REFERENCES platform_companion_identity_selections(id,user_id) ON DELETE CASCADE,
  FOREIGN KEY(bundle_revision,content_digest,review_digest) REFERENCES platform_companion_identity_assets(revision,content_digest,review_digest)
);
