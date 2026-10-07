-- Publication is a persisted fixed resource projection, not evidence that anyone read it.
-- Client presentation, user acknowledgment and explicit task continuation remain separate.
ALTER TABLE platform_onboarding_safety_responses ADD CONSTRAINT platform_safety_response_publication_binding
  UNIQUE(id,user_id,submission_id,draft_id,source_generation);
CREATE TABLE platform_onboarding_safety_publications (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES platform_users(id) ON DELETE CASCADE,
  draft_id uuid NOT NULL,
  response_id uuid NOT NULL UNIQUE,
  submission_id uuid NOT NULL UNIQUE,
  source_generation integer NOT NULL CHECK(source_generation BETWEEN 1 AND 2147483647),
  projection_digest text NOT NULL CHECK(projection_digest ~ '^[0-9a-f]{64}$'),
  payload_ciphertext bytea NOT NULL CHECK(octet_length(payload_ciphertext) BETWEEN 29 AND 65565),
  published_at timestamptz NOT NULL,
  retention_until timestamptz NOT NULL CHECK(retention_until>published_at),
  UNIQUE(id,user_id,draft_id),
  FOREIGN KEY(response_id,user_id,submission_id,draft_id,source_generation)
    REFERENCES platform_onboarding_safety_responses(id,user_id,submission_id,draft_id,source_generation) ON DELETE CASCADE
);
CREATE TABLE platform_onboarding_safety_followups (
  user_id uuid NOT NULL REFERENCES platform_users(id) ON DELETE CASCADE,
  operation_id uuid NOT NULL,
  draft_id uuid NOT NULL,
  publication_id uuid NOT NULL,
  action_kind text NOT NULL CHECK(action_kind IN ('present','acknowledge','continue_intake','clarify_exaggeration','need_support')),
  expected_revision integer NOT NULL CHECK(expected_revision BETWEEN 1 AND 2147483647),
  applied_revision integer NOT NULL CHECK(applied_revision BETWEEN expected_revision AND 2147483647),
  session_hash text NOT NULL CHECK(session_hash ~ '^[0-9a-f]{64}$'),
  presentation_digest text CHECK(presentation_digest ~ '^[0-9a-f]{64}$'),
  presentation_operation_id uuid,
  acknowledgment_operation_id uuid,
  handled boolean NOT NULL,
  clarified_at timestamptz,
  payload_ciphertext bytea NOT NULL CHECK(octet_length(payload_ciphertext) BETWEEN 29 AND 65565),
  created_at timestamptz NOT NULL,
  PRIMARY KEY(user_id,operation_id),
  UNIQUE(user_id,operation_id,draft_id,publication_id),
  FOREIGN KEY(publication_id,user_id,draft_id) REFERENCES platform_onboarding_safety_publications(id,user_id,draft_id) ON DELETE CASCADE,
  FOREIGN KEY(user_id,presentation_operation_id,draft_id,publication_id)
    REFERENCES platform_onboarding_safety_followups(user_id,operation_id,draft_id,publication_id) ON DELETE CASCADE,
  FOREIGN KEY(user_id,acknowledgment_operation_id,draft_id,publication_id)
    REFERENCES platform_onboarding_safety_followups(user_id,operation_id,draft_id,publication_id) ON DELETE CASCADE,
  CHECK((action_kind='present' AND presentation_digest IS NOT NULL AND presentation_operation_id IS NULL AND acknowledgment_operation_id IS NULL AND NOT handled AND clarified_at IS NULL)
    OR (action_kind='acknowledge' AND presentation_digest IS NOT NULL AND presentation_operation_id IS NOT NULL AND acknowledgment_operation_id IS NULL AND NOT handled AND clarified_at IS NULL)
    OR (action_kind='need_support' AND presentation_digest IS NULL AND presentation_operation_id IS NULL AND acknowledgment_operation_id IS NULL AND NOT handled AND clarified_at IS NULL)
    OR (action_kind='continue_intake' AND presentation_digest IS NOT NULL AND presentation_operation_id IS NOT NULL AND acknowledgment_operation_id IS NOT NULL AND handled AND clarified_at IS NULL)
    OR (action_kind='clarify_exaggeration' AND presentation_digest IS NOT NULL AND presentation_operation_id IS NOT NULL AND acknowledgment_operation_id IS NOT NULL AND handled AND clarified_at=created_at)),
  CHECK(action_kind IN ('continue_intake','clarify_exaggeration') OR applied_revision=expected_revision)
);
CREATE UNIQUE INDEX platform_onboarding_safety_handled_once ON platform_onboarding_safety_followups(publication_id) WHERE handled;
