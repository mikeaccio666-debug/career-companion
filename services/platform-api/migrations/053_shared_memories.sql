-- Existing plaintext rows remain owner-only review candidates. No category,
-- sensitivity, confidence, source or confirmation is guessed or backfilled.
ALTER TABLE platform_memories ADD COLUMN IF NOT EXISTS record_revision integer NOT NULL DEFAULT 0 CHECK(record_revision>=0);
ALTER TABLE platform_memories ADD COLUMN IF NOT EXISTS record_ciphertext bytea;
ALTER TABLE platform_memories ADD COLUMN IF NOT EXISTS category text CHECK(category IN ('agreement','communication','goal_preference','experience','identity_timeline','emotion_rhythm'));
ALTER TABLE platform_memories ADD COLUMN IF NOT EXISTS sensitivity text CHECK(sensitivity IN ('normal','sensitive','restricted'));
ALTER TABLE platform_memories ADD COLUMN IF NOT EXISTS source text CHECK(source IN ('user_saved','user_stated','companion_proposed','expert_proposed','imported'));
ALTER TABLE platform_memories ADD COLUMN IF NOT EXISTS status text CHECK(status IN ('proposed','confirmed','archived'));
ALTER TABLE platform_memories ADD COLUMN IF NOT EXISTS confidence text CHECK(confidence IN ('high','medium','low'));
ALTER TABLE platform_memories ADD COLUMN IF NOT EXISTS use_policy text CHECK(use_policy IN ('normal','only_if_user_raises'));
ALTER TABLE platform_memories ADD COLUMN IF NOT EXISTS speaker_scope text CHECK(speaker_scope IN ('companion','planner','guide','coach','interviewer','networker','applier'));
ALTER TABLE platform_memories ADD COLUMN IF NOT EXISTS valid_until timestamptz;
ALTER TABLE platform_memories ADD COLUMN IF NOT EXISTS review_due_at timestamptz;
ALTER TABLE platform_memories ADD COLUMN IF NOT EXISTS confirmed_at timestamptz;
ALTER TABLE platform_memories ADD COLUMN IF NOT EXISTS updated_at timestamptz;
ALTER TABLE platform_memories ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
ALTER TABLE platform_memories ADD COLUMN IF NOT EXISTS undo_until timestamptz;
ALTER TABLE platform_memories ADD COLUMN IF NOT EXISTS deletion_operation_id uuid;
ALTER TABLE platform_memories ADD COLUMN IF NOT EXISTS last_operation_id uuid;
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='platform_memories'::regclass AND conname='shared_memory_storage') THEN
 ALTER TABLE platform_memories ADD CONSTRAINT shared_memory_storage CHECK(
  (record_revision=0 AND record_ciphertext IS NULL AND category IS NULL AND sensitivity IS NULL AND source IS NULL AND status IS NULL
   AND confidence IS NULL AND use_policy IS NULL AND speaker_scope IS NULL AND confirmed_at IS NULL AND updated_at IS NULL
   AND valid_until IS NULL AND review_due_at IS NULL AND deleted_at IS NULL AND undo_until IS NULL AND deletion_operation_id IS NULL AND last_operation_id IS NULL)
  OR (record_revision>0 AND record_ciphertext IS NOT NULL AND octet_length(record_ciphertext)>=29 AND content='' AND updated_at IS NOT NULL AND last_operation_id IS NOT NULL
   AND ((category IS NULL AND sensitivity IS NULL AND source IS NULL AND status IS NULL AND confidence IS NULL AND use_policy IS NULL AND confirmed_at IS NULL)
    OR (category IS NOT NULL AND sensitivity IS NOT NULL AND source IS NOT NULL AND status IS NOT NULL AND confidence IS NOT NULL AND use_policy IS NOT NULL))
   AND (status IS DISTINCT FROM 'confirmed' OR confirmed_at IS NOT NULL)
   AND (speaker_scope IS NULL OR category='communication')
   AND ((deleted_at IS NULL AND undo_until IS NULL AND deletion_operation_id IS NULL)
    OR (deleted_at IS NOT NULL AND undo_until=deleted_at+interval '10 seconds' AND deletion_operation_id IS NOT NULL))));
 END IF;
END $$;
CREATE UNIQUE INDEX IF NOT EXISTS shared_memory_owner_identity ON platform_memories(id,user_id);
CREATE INDEX IF NOT EXISTS shared_memory_owner_page ON platform_memories(user_id,created_at DESC,id DESC);
CREATE INDEX IF NOT EXISTS shared_memory_pending_purge ON platform_memories(undo_until) WHERE deleted_at IS NOT NULL;
CREATE TABLE IF NOT EXISTS platform_memory_operations(
 operation_id uuid NOT NULL,user_id uuid NOT NULL REFERENCES platform_users(id) ON DELETE CASCADE,memory_id uuid NOT NULL,
 action text NOT NULL CHECK(action IN ('create','confirm','edit','delete','undo')),applied_revision integer NOT NULL CHECK(applied_revision>0),
 receipt_ciphertext bytea NOT NULL CHECK(octet_length(receipt_ciphertext)>=29),created_at timestamptz NOT NULL,
 PRIMARY KEY(user_id,operation_id),UNIQUE(user_id,memory_id,applied_revision),UNIQUE(user_id,operation_id,memory_id));
-- No FK to memory: these content-free events survive a deliberate memory purge.
CREATE TABLE IF NOT EXISTS platform_memory_events(
 id uuid PRIMARY KEY,user_id uuid NOT NULL REFERENCES platform_users(id) ON DELETE CASCADE,memory_id uuid NOT NULL,operation_id uuid NOT NULL,
 action text NOT NULL CHECK(action IN ('proposed','confirmed','edited','dismissed','deleted','sensitivity_changed','expired')),
 actor text NOT NULL CHECK(actor IN ('user','companion','expert:planner','expert:guide','expert:coach','expert:interviewer','expert:networker','expert:applier','system')),
 channel text NOT NULL CHECK(channel IN ('web','discord','voice')),revision integer NOT NULL CHECK(revision>0),created_at timestamptz NOT NULL,
 UNIQUE(user_id,operation_id,action),FOREIGN KEY(user_id,operation_id,memory_id) REFERENCES platform_memory_operations(user_id,operation_id,memory_id) ON DELETE CASCADE);
CREATE UNIQUE INDEX IF NOT EXISTS shared_memory_room_owner ON platform_conversations(id,user_id);
CREATE UNIQUE INDEX IF NOT EXISTS shared_memory_message_owner_room ON platform_messages(id,conversation_id,user_id);
CREATE TABLE IF NOT EXISTS platform_memory_uses(
 id uuid PRIMARY KEY,memory_id uuid NOT NULL,user_id uuid NOT NULL REFERENCES platform_users(id) ON DELETE CASCADE,
 memory_revision integer NOT NULL CHECK(memory_revision>0),conversation_id uuid NOT NULL,
 message_id uuid NOT NULL,speaker text NOT NULL CHECK(speaker IN ('companion','planner','guide','coach','interviewer','networker','applier')),
 channel text NOT NULL CHECK(channel IN ('web','discord','voice')),purpose text NOT NULL CHECK(purpose IN ('chat','morning_brief','self_set_reminder','external_draft','handoff_note')),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),FOREIGN KEY(memory_id,user_id) REFERENCES platform_memories(id,user_id) ON DELETE CASCADE,
 FOREIGN KEY(conversation_id,user_id) REFERENCES platform_conversations(id,user_id) ON DELETE CASCADE,
 FOREIGN KEY(message_id,conversation_id,user_id) REFERENCES platform_messages(id,conversation_id,user_id) ON DELETE CASCADE,
 UNIQUE(memory_id,memory_revision,message_id,purpose));

ALTER TABLE platform_messages ADD COLUMN IF NOT EXISTS excluded_from_context boolean NOT NULL DEFAULT false;

-- Content-free command receipts are the monotonic source head and remain after
-- forgetting a memory. Account deletion is the only cascade that removes them.
CREATE OR REPLACE FUNCTION shared_memory_keep_receipt() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF EXISTS(SELECT 1 FROM platform_users WHERE id=OLD.user_id) THEN
  RAISE EXCEPTION 'memory receipts are immutable while owner exists' USING ERRCODE='23514';
 END IF;
 RETURN OLD;
END $$;
DROP TRIGGER IF EXISTS shared_memory_receipt_immutable ON platform_memory_operations;
CREATE TRIGGER shared_memory_receipt_immutable BEFORE UPDATE OR DELETE ON platform_memory_operations FOR EACH ROW EXECUTE FUNCTION shared_memory_keep_receipt();
DROP TRIGGER IF EXISTS shared_memory_event_immutable ON platform_memory_events;
CREATE TRIGGER shared_memory_event_immutable BEFORE UPDATE OR DELETE ON platform_memory_events FOR EACH ROW EXECUTE FUNCTION shared_memory_keep_receipt();
