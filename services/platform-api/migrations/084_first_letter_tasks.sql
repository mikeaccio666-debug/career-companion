-- Durable task preparation only. No model call, execution lease or delivery.
CREATE TABLE platform_first_letter_tasks (
 id uuid PRIMARY KEY,
 user_id uuid NOT NULL REFERENCES platform_users(id) ON DELETE CASCADE,
 companion_id uuid NOT NULL,
 conversation_id uuid NOT NULL,
 welcome_id uuid NOT NULL,
 birth_receipt_id uuid NOT NULL,
 source_id text NOT NULL CHECK(source_id ~ '^first_letter_source_[a-f0-9]{64}$'),
 preparation_id text NOT NULL CHECK(preparation_id ~ '^first_letter_preparation_[a-f0-9]{64}$'),
 policy_revision integer NOT NULL CHECK(policy_revision=1),
 status text NOT NULL CHECK(status='prepared'),
 preparation_ciphertext bytea NOT NULL CHECK(octet_length(preparation_ciphertext)>=29),
 created_at timestamptz NOT NULL,
 UNIQUE(id,user_id),UNIQUE(user_id,welcome_id),
 FOREIGN KEY(welcome_id,user_id,companion_id)
  REFERENCES platform_companion_welcome(id,user_id,companion_id) ON DELETE CASCADE,
 FOREIGN KEY(conversation_id,user_id,companion_id,birth_receipt_id)
  REFERENCES platform_conversations(id,user_id,companion_id,birth_receipt_id) ON DELETE CASCADE
);
