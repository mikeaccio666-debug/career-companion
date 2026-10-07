-- Unreleased durable preparation only. No model, companion birth, room, resource,
-- review, budget, price or execution authorization is seeded by this migration.
-- Later delivery/birth migrations must add their own state transitions and gates.
CREATE TABLE platform_companions (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES platform_users(id) ON DELETE CASCADE,
  status text NOT NULL CHECK (status = 'drafting'),
  current_revision integer NOT NULL DEFAULT 0 CHECK (current_revision = 0),
  draft_rerolls integer NOT NULL DEFAULT 0 CHECK (draft_rerolls = 0),
  fingerprint text NOT NULL CHECK (fingerprint ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (id, user_id)
);
CREATE UNIQUE INDEX platform_companions_current_owner ON platform_companions(user_id)
  WHERE status IN ('drafting','awaiting_name','active');
CREATE INDEX platform_companions_fingerprint ON platform_companions(fingerprint);

-- Snapshot contains choices and references to encrypted intake, never a second
-- copy of raw free text. Revision binds the historical source, not a mutable FK.
CREATE TABLE platform_companion_answers (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES platform_users(id) ON DELETE CASCADE,
  source_draft_id uuid NOT NULL,
  source_revision integer NOT NULL CHECK (source_revision BETWEEN 1 AND 2147483647),
  payload_ciphertext bytea NOT NULL CHECK (octet_length(payload_ciphertext) BETWEEN 29 AND 65565),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (id, user_id, source_draft_id, source_revision),
  FOREIGN KEY (source_draft_id,user_id) REFERENCES platform_onboarding_drafts(id,user_id) ON DELETE CASCADE
);

CREATE TABLE platform_companion_generation_tasks (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES platform_users(id) ON DELETE CASCADE,
  companion_id uuid NOT NULL UNIQUE,
  answers_id uuid NOT NULL,
  source_draft_id uuid NOT NULL,
  source_revision integer NOT NULL CHECK (source_revision BETWEEN 1 AND 2147483647),
  auth_version bigint NOT NULL CHECK (auth_version >= 0),
  questionnaire_revision integer NOT NULL CHECK (questionnaire_revision = 1),
  rules_revision integer NOT NULL CHECK (rules_revision = 1),
  generator_version integer NOT NULL CHECK (generator_version = 1),
  purpose text NOT NULL CHECK (purpose = 'companion_preview'),
  status text NOT NULL CHECK (status = 'pending'),
  seed_ciphertext bytea NOT NULL CHECK (octet_length(seed_ciphertext) BETWEEN 29 AND 65565),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (companion_id,user_id) REFERENCES platform_companions(id,user_id) ON DELETE CASCADE,
  FOREIGN KEY (answers_id,user_id,source_draft_id,source_revision)
    REFERENCES platform_companion_answers(id,user_id,source_draft_id,source_revision) ON DELETE CASCADE
);
