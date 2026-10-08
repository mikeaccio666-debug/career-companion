-- C1 is separate from birth, generation tasks, first-letter delivery and tools.
-- No historic conversation, message, persona or authorization is backfilled.
-- The typed message/room link must own the same deletion lifecycle as the
-- original conversation_id FK. Immediate NO ACTION checks can run before a
-- sibling cascade during account deletion; never rely on RI trigger ordering.
-- Keep the complete id/kind binding and validate all existing rows again.
ALTER TABLE platform_messages DROP CONSTRAINT IF EXISTS companion_message_parent_kind;
ALTER TABLE platform_messages ADD CONSTRAINT companion_message_parent_kind
  FOREIGN KEY(conversation_id,room_kind) REFERENCES platform_conversations(id,kind) ON DELETE CASCADE;

CREATE UNIQUE INDEX IF NOT EXISTS companion_welcome_message_owner_target ON platform_messages(id,user_id,companion_id,conversation_id);
CREATE TABLE IF NOT EXISTS platform_companion_welcome (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES platform_users(id) ON DELETE CASCADE,
  companion_id uuid NOT NULL,
  conversation_id uuid NOT NULL,
  birth_receipt_id uuid NOT NULL,
  intro_message_id uuid NOT NULL UNIQUE,
  intro_ciphertext bytea NOT NULL,
  revision integer NOT NULL CHECK(revision IN (1,2)),
  step text NOT NULL CHECK(step IN ('C1','C2','C7')),
  choice text CHECK(choice IN ('begin','direct_letter')),
  opened_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL CHECK(updated_at>=opened_at),
  UNIQUE(user_id,companion_id),
  UNIQUE(id,user_id,companion_id),
  FOREIGN KEY(intro_message_id,user_id,companion_id,conversation_id)
    REFERENCES platform_messages(id,user_id,companion_id,conversation_id) ON DELETE CASCADE,
  FOREIGN KEY(conversation_id,user_id,companion_id,birth_receipt_id)
    REFERENCES platform_conversations(id,user_id,companion_id,birth_receipt_id) ON DELETE CASCADE,
  FOREIGN KEY(birth_receipt_id,user_id,companion_id,conversation_id)
    REFERENCES platform_companion_birth_receipts(id,user_id,companion_id,main_conversation_id),
  CHECK((revision=1 AND step='C1' AND choice IS NULL)
    OR (revision=2 AND step='C2' AND choice IS NOT NULL AND choice='begin')
    OR (revision=2 AND step='C7' AND choice IS NOT NULL AND choice='direct_letter'))
);
CREATE TABLE IF NOT EXISTS platform_companion_welcome_operations (
  operation_id uuid NOT NULL,
  user_id uuid NOT NULL REFERENCES platform_users(id) ON DELETE CASCADE,
  welcome_id uuid NOT NULL UNIQUE,
  companion_id uuid NOT NULL,
  request_ciphertext bytea NOT NULL,
  applied_revision integer NOT NULL CHECK(applied_revision=2),
  accepted_auth_version bigint NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(user_id,operation_id),
  FOREIGN KEY(welcome_id,user_id,companion_id)
    REFERENCES platform_companion_welcome(id,user_id,companion_id) ON DELETE CASCADE
);
