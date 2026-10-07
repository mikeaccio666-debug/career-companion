-- Independent user-text source for naming. No approved detector, safety level,
-- user text, vocabulary, backfill, publication or birth permission is seeded.
CREATE TABLE platform_companion_name_entries (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES platform_users(id) ON DELETE CASCADE,
  task_id uuid NOT NULL UNIQUE,
  companion_id uuid NOT NULL UNIQUE,
  preview_revision integer NOT NULL CHECK (preview_revision=1),
  revision integer NOT NULL CHECK (revision BETWEEN 1 AND 2147483647),
  latest_submission_id uuid NOT NULL,
  payload_ciphertext bytea NOT NULL CHECK (octet_length(payload_ciphertext) BETWEEN 29 AND 65565),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(id,user_id,task_id,companion_id,preview_revision),
  FOREIGN KEY(task_id,user_id,companion_id) REFERENCES platform_companion_generation_tasks(id,user_id,companion_id) ON DELETE CASCADE,
  FOREIGN KEY(companion_id,preview_revision) REFERENCES platform_companion_revisions(companion_id,revision) ON DELETE CASCADE
);
CREATE TABLE platform_companion_name_submissions (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES platform_users(id) ON DELETE CASCADE,
  operation_id uuid NOT NULL,
  entry_id uuid NOT NULL,
  task_id uuid NOT NULL,
  companion_id uuid NOT NULL,
  preview_revision integer NOT NULL CHECK (preview_revision=1),
  submitted_revision integer NOT NULL CHECK (submitted_revision BETWEEN 1 AND 2147483647),
  expected_identity_revision integer NOT NULL CHECK (expected_identity_revision BETWEEN 0 AND 2147483646),
  submitted_auth_version bigint NOT NULL CHECK (submitted_auth_version>=0),
  application_operation_id uuid NOT NULL UNIQUE,
  request_ciphertext bytea NOT NULL CHECK (octet_length(request_ciphertext) BETWEEN 29 AND 65565),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','running','detected')),
  generation integer NOT NULL DEFAULT 0 CHECK (generation BETWEEN 0 AND 2147483647),
  auth_version bigint CHECK (auth_version>=0),
  lease_token uuid,
  lease_until timestamptz,
  execution_token uuid,
  detector_revision integer CHECK (detector_revision BETWEEN 1 AND 2147483647),
  claim_ciphertext bytea CHECK (octet_length(claim_ciphertext) BETWEEN 29 AND 65565),
  result_ciphertext bytea CHECK (octet_length(result_ciphertext) BETWEEN 29 AND 65565),
  level text CHECK (level IN ('L0','L1','L2')),
  detector_mode text CHECK (detector_mode IN ('full','keyword_only')),
  failure text CHECK (failure IN ('unavailable','timeout','invalid_result')),
  application_status text NOT NULL DEFAULT 'pending' CHECK (application_status IN ('pending','applied','name_rejected','superseded','not_eligible')),
  rejected_category text CHECK (rejected_category IN ('family_or_partner','team_or_org','same_as_user','abusive','public_figure','length')),
  applied_identity_revision integer CHECK (applied_identity_revision BETWEEN 1 AND 2147483647),
  application_ciphertext bytea CHECK (octet_length(application_ciphertext) BETWEEN 29 AND 65565),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(user_id,operation_id),
  UNIQUE(entry_id,submitted_revision),
  UNIQUE(id,user_id,operation_id,entry_id,task_id,companion_id,preview_revision,submitted_revision,expected_identity_revision),
  UNIQUE(id,user_id,entry_id,task_id,companion_id,preview_revision,submitted_revision),
  UNIQUE(id,user_id,generation),
  UNIQUE(id,user_id,generation,level,detector_mode),
  FOREIGN KEY(entry_id,user_id,task_id,companion_id,preview_revision)
    REFERENCES platform_companion_name_entries(id,user_id,task_id,companion_id,preview_revision) ON DELETE CASCADE,
  CHECK ((status='pending' AND lease_token IS NULL AND lease_until IS NULL AND execution_token IS NULL)
    OR (status IN ('running','detected') AND generation>0 AND auth_version IS NOT NULL AND lease_token IS NOT NULL
      AND lease_until IS NOT NULL AND detector_revision IS NOT NULL AND claim_ciphertext IS NOT NULL)),
  CHECK ((status='detected' AND execution_token IS NOT NULL AND result_ciphertext IS NOT NULL AND level IS NOT NULL AND detector_mode IS NOT NULL AND failure IS NULL)
    OR (status<>'detected' AND result_ciphertext IS NULL AND level IS NULL AND detector_mode IS NULL)),
  CHECK (level IS DISTINCT FROM 'L0' OR detector_mode='full'),
  CHECK ((application_status='pending' AND rejected_category IS NULL AND applied_identity_revision IS NULL AND application_ciphertext IS NULL)
    OR (status='detected' AND application_ciphertext IS NOT NULL AND
      ((application_status='applied' AND level='L0' AND rejected_category IS NULL AND applied_identity_revision IS NOT NULL)
      OR (application_status='name_rejected' AND level='L0' AND rejected_category IS NOT NULL AND applied_identity_revision IS NULL)
      OR (application_status IN ('superseded','not_eligible') AND rejected_category IS NULL AND applied_identity_revision IS NULL))))
);
ALTER TABLE platform_companion_name_entries ADD CONSTRAINT companion_name_latest_source
  FOREIGN KEY(latest_submission_id,user_id,id,task_id,companion_id,preview_revision,revision)
    REFERENCES platform_companion_name_submissions(id,user_id,entry_id,task_id,companion_id,preview_revision,submitted_revision)
    DEFERRABLE INITIALLY DEFERRED;
CREATE INDEX companion_name_pending ON platform_companion_name_submissions(user_id,submitted_revision) WHERE status<>'detected';
ALTER TABLE platform_companion_identity_operations ADD CONSTRAINT companion_name_actual_identity_operation
  UNIQUE(user_id,operation_id,draft_id,applied_revision);
-- Written only for a new actual classified name application, in the same
-- transaction as its identity operation. Legacy commands have no invented
-- receipt. This independent receipt authenticates the whole saved snapshot.
CREATE TABLE platform_companion_name_identity_receipts (
  user_id uuid NOT NULL REFERENCES platform_users(id) ON DELETE CASCADE,
  operation_id uuid NOT NULL,
  draft_id uuid NOT NULL,
  identity_revision integer NOT NULL CHECK (identity_revision BETWEEN 1 AND 2147483647),
  submission_id uuid NOT NULL UNIQUE,
  generation integer NOT NULL CHECK (generation BETWEEN 1 AND 2147483647),
  level text NOT NULL DEFAULT 'L0' CHECK (level='L0'),
  detector_mode text NOT NULL DEFAULT 'full' CHECK (detector_mode='full'),
  payload_ciphertext bytea NOT NULL CHECK (octet_length(payload_ciphertext) BETWEEN 29 AND 65565),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(user_id,operation_id),
  UNIQUE(user_id,operation_id,draft_id,identity_revision,submission_id,generation),
  FOREIGN KEY(user_id,operation_id,draft_id,identity_revision)
    REFERENCES platform_companion_identity_operations(user_id,operation_id,draft_id,applied_revision) ON DELETE CASCADE,
  FOREIGN KEY(submission_id,user_id,generation,level,detector_mode)
    REFERENCES platform_companion_name_submissions(id,user_id,generation,level,detector_mode) ON DELETE CASCADE
);
-- Only new actual full-L0 sources can establish usable naming provenance.
-- Existing identity revisions have no synthetic safety record.
CREATE TABLE platform_companion_name_identity_provenance (
  draft_id uuid NOT NULL,
  identity_revision integer NOT NULL CHECK (identity_revision BETWEEN 1 AND 2147483647),
  user_id uuid NOT NULL REFERENCES platform_users(id) ON DELETE CASCADE,
  operation_id uuid NOT NULL,
  submission_id uuid NOT NULL UNIQUE,
  generation integer NOT NULL CHECK (generation BETWEEN 1 AND 2147483647),
  level text NOT NULL DEFAULT 'L0' CHECK (level='L0'),
  detector_mode text NOT NULL DEFAULT 'full' CHECK (detector_mode='full'),
  payload_ciphertext bytea NOT NULL CHECK (octet_length(payload_ciphertext) BETWEEN 29 AND 65565),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(draft_id,identity_revision),
  FOREIGN KEY(draft_id,user_id) REFERENCES platform_companion_identity_drafts(id,user_id) ON DELETE CASCADE,
  FOREIGN KEY(submission_id,user_id,generation,level,detector_mode)
    REFERENCES platform_companion_name_submissions(id,user_id,generation,level,detector_mode) ON DELETE CASCADE,
  FOREIGN KEY(user_id,operation_id,draft_id,identity_revision,submission_id,generation)
    REFERENCES platform_companion_name_identity_receipts(user_id,operation_id,draft_id,identity_revision,submission_id,generation) ON DELETE CASCADE
);
