-- Atomic birth storage foundation; current admission is checked by the service.
-- Exact SQL is repeatable without data backfills or swallowing DDL failures.
-- Durable birth storage foundation only: no birth route/service, C1, model,
-- renderer, authority stub, seed, backfilled birth, review or overlay expiry.
-- The future service must consume current auth/consent/source/safety/review and
-- canonical encrypted evidence in ONE owner-locked bounded transaction.
-- FK presence proves coordinates/ownership only, never current admission.

ALTER TABLE platform_companions DROP CONSTRAINT IF EXISTS platform_companions_status_check;
ALTER TABLE platform_companions DROP CONSTRAINT IF EXISTS platform_companions_current_revision_check;
ALTER TABLE platform_companions ADD COLUMN IF NOT EXISTS name text;
ALTER TABLE platform_companions ADD COLUMN IF NOT EXISTS name_origin text CHECK(name_origin='user_typed');
ALTER TABLE platform_companions ADD COLUMN IF NOT EXISTS seal_char text CHECK(char_length(seal_char)=1);
ALTER TABLE platform_companions ADD COLUMN IF NOT EXISTS seal_candidates jsonb
  CHECK(seal_candidates IS NULL OR (jsonb_typeof(seal_candidates)='array' AND jsonb_array_length(seal_candidates)=3));
ALTER TABLE platform_companions ADD COLUMN IF NOT EXISTS seal_changed_at timestamptz;
ALTER TABLE platform_companions ADD COLUMN IF NOT EXISTS ink_token text
  CHECK(ink_token IN ('yanzhi','zheshi','ganlan','jiangzi','dai','yanzi','hehui'));
ALTER TABLE platform_companions ADD COLUMN IF NOT EXISTS relationship_stage text
  CHECK(relationship_stage IN ('acquainting','familiar','dormant'));
ALTER TABLE platform_companions ADD COLUMN IF NOT EXISTS stage_changed_at timestamptz;
-- NULL means not projected yet, NOT no active safety restriction. No [] default,
-- overlay kinds, source references or expiry timestamps are manufactured here.
ALTER TABLE platform_companions ADD COLUMN IF NOT EXISTS overlays jsonb
  CHECK(overlays IS NULL OR jsonb_typeof(overlays)='array');
ALTER TABLE platform_companions ADD COLUMN IF NOT EXISTS birth_receipt_id uuid;
ALTER TABLE platform_companions ADD COLUMN IF NOT EXISTS birth_idempotency_key uuid;
ALTER TABLE platform_companions ADD COLUMN IF NOT EXISTS born_at timestamptz;
ALTER TABLE platform_companions ADD COLUMN IF NOT EXISTS retired_at timestamptz;
ALTER TABLE platform_companions ADD COLUMN IF NOT EXISTS seal_asset_id uuid;
DO $birth_constraint$ BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conname='companion_birth_status' AND conrelid='platform_companions'::regclass) THEN
    ALTER TABLE platform_companions ADD CONSTRAINT companion_birth_status
      CHECK(status IN ('drafting','awaiting_name','active','retired'));
  END IF;
END $birth_constraint$;
DO $birth_constraint$ BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conname='companion_birth_revision' AND conrelid='platform_companions'::regclass) THEN
    ALTER TABLE platform_companions ADD CONSTRAINT companion_birth_revision
      CHECK((status='drafting' AND current_revision=0) OR (status IN ('awaiting_name','active','retired') AND current_revision=1));
  END IF;
END $birth_constraint$;
DO $birth_constraint$ BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conname='companion_birth_lifecycle' AND conrelid='platform_companions'::regclass) THEN
    ALTER TABLE platform_companions ADD CONSTRAINT companion_birth_lifecycle
      CHECK(
        (status IN ('drafting','awaiting_name')
          AND name IS NULL AND name_origin IS NULL AND seal_char IS NULL AND seal_candidates IS NULL
          AND seal_changed_at IS NULL AND ink_token IS NULL AND relationship_stage IS NULL AND stage_changed_at IS NULL
          AND birth_receipt_id IS NULL AND birth_idempotency_key IS NULL AND born_at IS NULL AND retired_at IS NULL AND seal_asset_id IS NULL)
        OR
        (status IN ('active','retired') AND name IS NOT NULL AND char_length(name) BETWEEN 1 AND 16
          AND name_origin IS NOT NULL AND seal_char IS NOT NULL AND seal_candidates IS NOT NULL AND ink_token IS NOT NULL
          AND relationship_stage IS NOT NULL AND stage_changed_at IS NOT NULL
          AND birth_receipt_id IS NOT NULL AND birth_idempotency_key IS NOT NULL AND born_at IS NOT NULL AND seal_asset_id IS NOT NULL
          AND stage_changed_at>=born_at
          AND ((status='active' AND retired_at IS NULL) OR (status='retired' AND retired_at IS NOT NULL AND retired_at>=born_at)))
      );
  END IF;
END $birth_constraint$;
-- Keep existing platform_companions_current_owner:
-- unique user while status IN ('drafting','awaiting_name','active').
DO $birth_constraint$ BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conname='companion_birth_owner_origin_target' AND conrelid='platform_companions'::regclass) THEN
    ALTER TABLE platform_companions ADD CONSTRAINT companion_birth_owner_origin_target
      UNIQUE(id,user_id,birth_receipt_id,birth_idempotency_key,born_at);
  END IF;
END $birth_constraint$;

-- Existing rows remain legacy with their original mode/persona/content.
-- No historical conversation is adopted as main and no event is backfilled.
ALTER TABLE platform_conversations ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'legacy'
  CHECK(kind IN ('legacy','main'));
ALTER TABLE platform_conversations ADD COLUMN IF NOT EXISTS companion_id uuid;
ALTER TABLE platform_conversations ADD COLUMN IF NOT EXISTS birth_receipt_id uuid;
DO $birth_constraint$ BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conname='companion_room_owner_target' AND conrelid='platform_conversations'::regclass) THEN
    ALTER TABLE platform_conversations ADD CONSTRAINT companion_room_owner_target UNIQUE(id,user_id);
  END IF;
END $birth_constraint$;
DO $birth_constraint$ BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conname='companion_room_kind_target' AND conrelid='platform_conversations'::regclass) THEN
    ALTER TABLE platform_conversations ADD CONSTRAINT companion_room_kind_target UNIQUE(id,kind);
  END IF;
END $birth_constraint$;
DO $birth_constraint$ BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conname='companion_room_subject_target' AND conrelid='platform_conversations'::regclass) THEN
    ALTER TABLE platform_conversations ADD CONSTRAINT companion_room_subject_target UNIQUE(id,user_id,companion_id);
  END IF;
END $birth_constraint$;
DO $birth_constraint$ BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conname='companion_room_birth_target' AND conrelid='platform_conversations'::regclass) THEN
    ALTER TABLE platform_conversations ADD CONSTRAINT companion_room_birth_target UNIQUE(id,user_id,companion_id,birth_receipt_id);
  END IF;
END $birth_constraint$;
DO $birth_constraint$ BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conname='companion_room_owner' AND conrelid='platform_conversations'::regclass) THEN
    ALTER TABLE platform_conversations ADD CONSTRAINT companion_room_owner
      FOREIGN KEY(companion_id,user_id) REFERENCES platform_companions(id,user_id);
  END IF;
END $birth_constraint$;
DO $birth_constraint$ BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conname='companion_room_shape' AND conrelid='platform_conversations'::regclass) THEN
    ALTER TABLE platform_conversations ADD CONSTRAINT companion_room_shape
      CHECK((kind='legacy' AND companion_id IS NULL AND birth_receipt_id IS NULL)
        OR (kind='main' AND companion_id IS NOT NULL AND birth_receipt_id IS NOT NULL AND persona IS NULL AND mode='companion'));
  END IF;
END $birth_constraint$;
CREATE UNIQUE INDEX IF NOT EXISTS companion_one_main_per_owner ON platform_conversations(user_id) WHERE kind='main';
-- mode='companion' satisfies the old NOT NULL enum only. New consumers must use
-- persisted kind and active server context; mode/persona grant no turn authority.

ALTER TABLE platform_messages DROP CONSTRAINT IF EXISTS platform_messages_role_check;
DO $birth_constraint$ BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conname='platform_messages_role_check' AND conrelid='platform_messages'::regclass) THEN
    ALTER TABLE platform_messages ADD CONSTRAINT platform_messages_role_check CHECK(role IN ('user','assistant','tool','system'));
  END IF;
END $birth_constraint$;
ALTER TABLE platform_messages ADD COLUMN IF NOT EXISTS room_kind text NOT NULL DEFAULT 'legacy' CHECK(room_kind IN ('legacy','main'));
DO $birth_constraint$ BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conname='companion_message_parent_kind' AND conrelid='platform_messages'::regclass) THEN
    ALTER TABLE platform_messages ADD CONSTRAINT companion_message_parent_kind
      FOREIGN KEY(conversation_id,room_kind) REFERENCES platform_conversations(id,kind);
  END IF;
END $birth_constraint$;
ALTER TABLE platform_messages ADD COLUMN IF NOT EXISTS user_id uuid;
ALTER TABLE platform_messages ADD COLUMN IF NOT EXISTS companion_id uuid;
ALTER TABLE platform_messages ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'text' CHECK(kind IN ('text','event'));
-- NULL is retained for legacy consumers that only write the old coarse role.
-- A legacy viewer maps role=assistant to legacy_assistant; no model identity is
-- inferred for a product room. Future C1 supplies its own real speaker snapshot.
ALTER TABLE platform_messages ADD COLUMN IF NOT EXISTS speaker_kind text
  CHECK(speaker_kind IN ('user','companion','expert','system','legacy_assistant'));
ALTER TABLE platform_messages ADD COLUMN IF NOT EXISTS speaker_key text CHECK(char_length(speaker_key) BETWEEN 1 AND 80);
ALTER TABLE platform_messages ADD COLUMN IF NOT EXISTS speaker_ref uuid;
ALTER TABLE platform_messages ADD COLUMN IF NOT EXISTS speaker_snapshot jsonb
  CHECK(speaker_snapshot IS NULL OR jsonb_typeof(speaker_snapshot)='object');
ALTER TABLE platform_messages ADD COLUMN IF NOT EXISTS payload jsonb NOT NULL DEFAULT '{}' CHECK(jsonb_typeof(payload)='object');
ALTER TABLE platform_messages ADD COLUMN IF NOT EXISTS channel text CHECK(channel IN ('web','system'));
ALTER TABLE platform_messages ADD COLUMN IF NOT EXISTS birth_receipt_id uuid;
DO $birth_constraint$ BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conname='companion_message_owner_pair' AND conrelid='platform_messages'::regclass) THEN
    ALTER TABLE platform_messages ADD CONSTRAINT companion_message_owner_pair
      CHECK((room_kind='legacy' AND user_id IS NULL AND companion_id IS NULL AND birth_receipt_id IS NULL)
        OR (room_kind='main' AND user_id IS NOT NULL AND companion_id IS NOT NULL AND speaker_kind IS NOT NULL AND channel IS NOT NULL));
  END IF;
END $birth_constraint$;
DO $birth_constraint$ BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conname='companion_message_room_owner' AND conrelid='platform_messages'::regclass) THEN
    ALTER TABLE platform_messages ADD CONSTRAINT companion_message_room_owner
      FOREIGN KEY(conversation_id,user_id,companion_id) REFERENCES platform_conversations(id,user_id,companion_id);
  END IF;
END $birth_constraint$;
DO $birth_constraint$ BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conname='companion_birth_event_target' AND conrelid='platform_messages'::regclass) THEN
    ALTER TABLE platform_messages ADD CONSTRAINT companion_birth_event_target
      UNIQUE(id,user_id,companion_id,conversation_id,birth_receipt_id,created_at);
  END IF;
END $birth_constraint$;
DO $birth_constraint$ BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conname='companion_birth_event_shape' AND conrelid='platform_messages'::regclass) THEN
    ALTER TABLE platform_messages ADD CONSTRAINT companion_birth_event_shape
      CHECK(
        (birth_receipt_id IS NULL AND kind='text')
        OR
        (birth_receipt_id IS NOT NULL AND user_id IS NOT NULL AND companion_id IS NOT NULL
          AND room_kind='main' AND kind='event' AND role='system' AND speaker_kind IS NOT NULL AND speaker_kind='system'
          AND speaker_key IS NULL AND speaker_ref IS NULL
          AND speaker_snapshot IS NOT NULL AND speaker_snapshot='{"displayName":"系统","roleLabel":"系统","sealChar":null,"ink_token":null,"personaRevision":null}'::jsonb
          AND channel IS NOT NULL AND channel='system' AND status='complete' AND content=''
          AND provider IS NULL AND model IS NULL AND lease_until IS NULL AND attachments='[]'::jsonb
          AND payload=jsonb_build_object('event','companion_born','birthReceiptId',birth_receipt_id::text,'companionId',companion_id::text))
      );
  END IF;
END $birth_constraint$;
CREATE UNIQUE INDEX IF NOT EXISTS companion_one_birth_event ON platform_messages(birth_receipt_id) WHERE birth_receipt_id IS NOT NULL;

-- Additional unique targets name EXISTING real source coordinates; they do not
-- create a source row, grade, selection, current review or authorization.
DO $birth_constraint$ BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conname='companion_birth_task_target' AND conrelid='platform_companion_generation_tasks'::regclass) THEN
    ALTER TABLE platform_companion_generation_tasks ADD CONSTRAINT companion_birth_task_target
      UNIQUE(id,user_id,companion_id,answers_id,source_draft_id,source_revision,generation);
  END IF;
END $birth_constraint$;
DO $birth_constraint$ BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conname='companion_birth_preview_target' AND conrelid='platform_companion_revisions'::regclass) THEN
    ALTER TABLE platform_companion_revisions ADD CONSTRAINT companion_birth_preview_target
      UNIQUE(companion_id,user_id,revision,task_id,generation);
  END IF;
END $birth_constraint$;
DO $birth_constraint$ BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conname='companion_birth_identity_target' AND conrelid='platform_companion_identity_drafts'::regclass) THEN
    ALTER TABLE platform_companion_identity_drafts ADD CONSTRAINT companion_birth_identity_target
      UNIQUE(id,user_id,companion_id,task_id,preview_revision);
  END IF;
END $birth_constraint$;
DO $birth_constraint$ BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conname='companion_birth_provenance_target' AND conrelid='platform_companion_name_identity_provenance'::regclass) THEN
    ALTER TABLE platform_companion_name_identity_provenance ADD CONSTRAINT companion_birth_provenance_target
      UNIQUE(draft_id,identity_revision,user_id,operation_id,submission_id,generation);
  END IF;
END $birth_constraint$;
DO $birth_constraint$ BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conname='companion_birth_selection_owner_target' AND conrelid='platform_companion_identity_selections'::regclass) THEN
    ALTER TABLE platform_companion_identity_selections ADD CONSTRAINT companion_birth_selection_owner_target
      UNIQUE(id,user_id,draft_id,companion_id,task_id,preview_revision);
  END IF;
END $birth_constraint$;
DO $birth_constraint$ BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conname='companion_birth_selection_operation_target' AND conrelid='platform_companion_identity_selection_operations'::regclass) THEN
    ALTER TABLE platform_companion_identity_selection_operations ADD CONSTRAINT companion_birth_selection_operation_target
      UNIQUE(user_id,operation_id,selection_id,identity_revision,applied_revision,bundle_revision,content_digest,review_digest);
  END IF;
END $birth_constraint$;
DO $birth_constraint$ BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conname='companion_birth_source_prefix_target' AND conrelid='platform_companion_source_prefixes'::regclass) THEN
    ALTER TABLE platform_companion_source_prefixes ADD CONSTRAINT companion_birth_source_prefix_target
      UNIQUE(id,user_id,companion_id,answers_id,source_draft_id,source_revision,schema_version,payload_digest);
  END IF;
END $birth_constraint$;

CREATE TABLE IF NOT EXISTS platform_companion_birth_assets (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES platform_users(id) ON DELETE CASCADE,
  companion_id uuid NOT NULL,
  birth_receipt_id uuid NOT NULL UNIQUE,
  seal_char text NOT NULL CHECK(char_length(seal_char)=1),
  ink_token text NOT NULL CHECK(ink_token IN ('yanzhi','zheshi','ganlan','jiangzi','dai','yanzi','hehui')),
  renderer_version text NOT NULL CHECK(char_length(renderer_version) BETWEEN 1 AND 100),
  glyph_source_digest text NOT NULL CHECK(glyph_source_digest ~ '^[0-9a-f]{64}$'),
  svg_digest text NOT NULL CHECK(svg_digest ~ '^[0-9a-f]{64}$'),
  png_digest text NOT NULL CHECK(png_digest ~ '^[0-9a-f]{64}$'),
  -- Actual small rendered bytes are encrypted in the same DB transaction.
  -- Version-1 AAD binds this table/column/asset ID/owner/schema version. The
  -- current DataCrypto UTF-8 port seals SVG text and canonical PNG base64.
  assets_schema_version integer NOT NULL CHECK(assets_schema_version=1),
  svg_size_bytes integer NOT NULL CHECK(svg_size_bytes BETWEEN 1 AND 16384),
  png_size_bytes integer NOT NULL CHECK(png_size_bytes BETWEEN 8 AND 32768),
  svg_ciphertext bytea NOT NULL CHECK(octet_length(svg_ciphertext) BETWEEN 30 AND 16413),
  png_base64_ciphertext bytea NOT NULL CHECK(octet_length(png_base64_ciphertext) BETWEEN 41 AND 43721),
  created_at timestamptz NOT NULL,
  UNIQUE(id,user_id,companion_id),
  UNIQUE(id,user_id,companion_id,birth_receipt_id,seal_char,ink_token,created_at),
  FOREIGN KEY(companion_id,user_id) REFERENCES platform_companions(id,user_id) ON DELETE CASCADE
);
-- Ciphertext bounds and declared digests do not prove rendering or licensing.
-- The server validates fixed SVG and PNG geometry, canonical encoding, actual
-- byte sizes and SHA-256 on write and authenticated read;
-- a current request never accepts caller bytes, digests, asset IDs or MIME.

CREATE TABLE IF NOT EXISTS platform_companion_birth_receipts (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES platform_users(id) ON DELETE CASCADE,
  companion_id uuid NOT NULL UNIQUE,
  idempotency_key uuid NOT NULL,
  request_digest text NOT NULL CHECK(request_digest ~ '^[0-9a-f]{64}$'),
  request_ciphertext bytea NOT NULL CHECK(octet_length(request_ciphertext) BETWEEN 29 AND 65565),
  snapshot_ciphertext bytea NOT NULL CHECK(octet_length(snapshot_ciphertext) BETWEEN 29 AND 65565),
  -- AAD is the actual table/column/receipt ID/owner with codec revision 1.
  snapshot_schema_version integer NOT NULL CHECK(snapshot_schema_version=1),
  accepted_auth_version bigint NOT NULL CHECK(accepted_auth_version>=0),
  terms_version text NOT NULL CHECK(char_length(terms_version) BETWEEN 1 AND 100),
  terms_content_digest text NOT NULL CHECK(terms_content_digest ~ '^[0-9a-f]{64}$'),
  task_id uuid NOT NULL,
  generation integer NOT NULL CHECK(generation BETWEEN 1 AND 2147483647),
  answers_id uuid NOT NULL,
  source_draft_id uuid NOT NULL,
  source_revision integer NOT NULL CHECK(source_revision BETWEEN 1 AND 2147483647),
  preview_revision integer NOT NULL CHECK(preview_revision=1),
  -- NULL is only for a genuine legacy task whose original manifest is NULL.
  -- The future service must compare the actual task flag and perform its
  -- existing current-source gate. It must never create a 045 prefix on replay.
  source_prefix_id uuid,
  source_prefix_version integer CHECK(source_prefix_version IN (1,2)),
  source_prefix_digest text CHECK(source_prefix_digest ~ '^[0-9a-f]{64}$'),
  inventory_tip_id uuid NOT NULL,
  inventory_revision integer NOT NULL CHECK(inventory_revision BETWEEN 1 AND 2147483647),
  inventory_tip_digest text NOT NULL CHECK(inventory_tip_digest ~ '^[0-9a-f]{64}$'),
  identity_draft_id uuid NOT NULL,
  identity_revision integer NOT NULL CHECK(identity_revision BETWEEN 1 AND 2147483647),
  name_application_operation_id uuid NOT NULL,
  name_submission_id uuid NOT NULL,
  name_generation integer NOT NULL CHECK(name_generation BETWEEN 1 AND 2147483647),
  selection_id uuid NOT NULL,
  selection_operation_id uuid NOT NULL,
  selection_revision integer NOT NULL CHECK(selection_revision BETWEEN 1 AND 2147483647),
  bundle_revision integer NOT NULL CHECK(bundle_revision BETWEEN 1 AND 2147483647),
  content_digest text NOT NULL CHECK(content_digest ~ '^[0-9a-f]{64}$'),
  review_digest text NOT NULL CHECK(review_digest ~ '^[0-9a-f]{64}$'),
  born_name text NOT NULL CHECK(char_length(born_name) BETWEEN 1 AND 16),
  name_origin text NOT NULL CHECK(name_origin='user_typed'),
  seal_char text NOT NULL CHECK(char_length(seal_char)=1),
  ink_token text NOT NULL CHECK(ink_token IN ('yanzhi','zheshi','ganlan','jiangzi','dai','yanzi','hehui')),
  main_conversation_id uuid NOT NULL UNIQUE,
  event_message_id uuid NOT NULL UNIQUE,
  seal_asset_id uuid NOT NULL UNIQUE,
  -- Milliseconds match the public ISO codec. Writers consume one DB timestamp
  -- for receipt, companion, main/event and assets; no client timestamp is used.
  born_at timestamptz NOT NULL DEFAULT date_trunc('milliseconds',clock_timestamp()),
  UNIQUE(user_id,idempotency_key),
  UNIQUE(id,user_id,companion_id,idempotency_key,born_at),
  UNIQUE(id,user_id,companion_id,main_conversation_id),
  UNIQUE(id,user_id,companion_id,seal_asset_id),
  CHECK((source_prefix_id IS NULL AND source_prefix_version IS NULL AND source_prefix_digest IS NULL)
    OR (source_prefix_id IS NOT NULL AND source_prefix_id=task_id AND source_prefix_version IS NOT NULL AND source_prefix_digest IS NOT NULL)),
  FOREIGN KEY(companion_id,user_id) REFERENCES platform_companions(id,user_id) ON DELETE CASCADE,
  -- Accepted consent coordinates are authenticated in the immutable snapshot.
  -- Do not FK the revocable current consent row: withdrawal must remain possible.
  FOREIGN KEY(task_id,user_id,companion_id,answers_id,source_draft_id,source_revision,generation)
    REFERENCES platform_companion_generation_tasks(id,user_id,companion_id,answers_id,source_draft_id,source_revision,generation),
  FOREIGN KEY(companion_id,user_id,preview_revision,task_id,generation)
    REFERENCES platform_companion_revisions(companion_id,user_id,revision,task_id,generation),
  FOREIGN KEY(source_prefix_id,user_id,companion_id,answers_id,source_draft_id,source_revision,source_prefix_version,source_prefix_digest)
    REFERENCES platform_companion_source_prefixes(id,user_id,companion_id,answers_id,source_draft_id,source_revision,schema_version,payload_digest),
  FOREIGN KEY(inventory_tip_id,user_id,inventory_revision,inventory_tip_digest)
    REFERENCES platform_companion_prebirth_inventory(id,user_id,revision,chain_digest),
  FOREIGN KEY(identity_draft_id,user_id,companion_id,task_id,preview_revision)
    REFERENCES platform_companion_identity_drafts(id,user_id,companion_id,task_id,preview_revision),
  FOREIGN KEY(identity_draft_id,identity_revision,user_id,name_application_operation_id,name_submission_id,name_generation)
    REFERENCES platform_companion_name_identity_provenance(draft_id,identity_revision,user_id,operation_id,submission_id,generation),
  FOREIGN KEY(selection_id,user_id,identity_draft_id,companion_id,task_id,preview_revision)
    REFERENCES platform_companion_identity_selections(id,user_id,draft_id,companion_id,task_id,preview_revision),
  -- Bind the immutable original operation, NOT the mutable current selection
  -- revision. A future new choice can update that head without rewriting birth.
  FOREIGN KEY(user_id,selection_operation_id,selection_id,identity_revision,selection_revision,bundle_revision,content_digest,review_digest)
    REFERENCES platform_companion_identity_selection_operations(user_id,operation_id,selection_id,identity_revision,applied_revision,bundle_revision,content_digest,review_digest),
  FOREIGN KEY(bundle_revision,content_digest,review_digest)
    REFERENCES platform_companion_identity_assets(revision,content_digest,review_digest),
  FOREIGN KEY(main_conversation_id,user_id,companion_id,id)
    REFERENCES platform_conversations(id,user_id,companion_id,birth_receipt_id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY(event_message_id,user_id,companion_id,main_conversation_id,id,born_at)
    REFERENCES platform_messages(id,user_id,companion_id,conversation_id,birth_receipt_id,created_at) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY(seal_asset_id,user_id,companion_id,id,seal_char,ink_token,born_at)
    REFERENCES platform_companion_birth_assets(id,user_id,companion_id,birth_receipt_id,seal_char,ink_token,created_at) DEFERRABLE INITIALLY DEFERRED
);
-- Reciprocal deferred FKs make active + receipt + main + event + both formats
-- one COMMIT. A standalone receipt or active row with missing children fails.
DO $birth_constraint$ BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conname='companion_birth_origin' AND conrelid='platform_companions'::regclass) THEN
    ALTER TABLE platform_companions ADD CONSTRAINT companion_birth_origin
      FOREIGN KEY(birth_receipt_id,user_id,id,birth_idempotency_key,born_at)
        REFERENCES platform_companion_birth_receipts(id,user_id,companion_id,idempotency_key,born_at) DEFERRABLE INITIALLY DEFERRED;
  END IF;
END $birth_constraint$;
DO $birth_constraint$ BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conname='companion_birth_active_origin' AND conrelid='platform_companion_birth_receipts'::regclass) THEN
    ALTER TABLE platform_companion_birth_receipts ADD CONSTRAINT companion_birth_active_origin
      FOREIGN KEY(companion_id,user_id,id,idempotency_key,born_at)
        REFERENCES platform_companions(id,user_id,birth_receipt_id,birth_idempotency_key,born_at) DEFERRABLE INITIALLY DEFERRED;
  END IF;
END $birth_constraint$;
DO $birth_constraint$ BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conname='companion_birth_current_asset_owner' AND conrelid='platform_companions'::regclass) THEN
    ALTER TABLE platform_companions ADD CONSTRAINT companion_birth_current_asset_owner
      FOREIGN KEY(seal_asset_id,user_id,id) REFERENCES platform_companion_birth_assets(id,user_id,companion_id) DEFERRABLE INITIALLY DEFERRED;
  END IF;
END $birth_constraint$;
DO $birth_constraint$ BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conname='companion_main_birth' AND conrelid='platform_conversations'::regclass) THEN
    ALTER TABLE platform_conversations ADD CONSTRAINT companion_main_birth
      FOREIGN KEY(birth_receipt_id,user_id,companion_id,id)
        REFERENCES platform_companion_birth_receipts(id,user_id,companion_id,main_conversation_id) DEFERRABLE INITIALLY DEFERRED;
  END IF;
END $birth_constraint$;
DO $birth_constraint$ BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conname='companion_event_birth' AND conrelid='platform_messages'::regclass) THEN
    ALTER TABLE platform_messages ADD CONSTRAINT companion_event_birth
      FOREIGN KEY(birth_receipt_id,user_id,companion_id,conversation_id)
        REFERENCES platform_companion_birth_receipts(id,user_id,companion_id,main_conversation_id) DEFERRABLE INITIALLY DEFERRED;
  END IF;
END $birth_constraint$;
DO $birth_constraint$ BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conname='companion_asset_birth' AND conrelid='platform_companion_birth_assets'::regclass) THEN
    ALTER TABLE platform_companion_birth_assets ADD CONSTRAINT companion_asset_birth
      FOREIGN KEY(birth_receipt_id,user_id,companion_id,id)
        REFERENCES platform_companion_birth_receipts(id,user_id,companion_id,seal_asset_id) DEFERRABLE INITIALLY DEFERRED;
  END IF;
END $birth_constraint$;

CREATE OR REPLACE FUNCTION companion_birth_keep_private_record() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS(SELECT 1 FROM platform_users WHERE id=OLD.user_id) THEN
    RAISE EXCEPTION 'birth origin and assets are immutable while owner exists' USING ERRCODE='23514';
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
DO $birth_trigger$ BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgname='companion_birth_receipt_immutable' AND tgrelid='platform_companion_birth_receipts'::regclass) THEN
    CREATE TRIGGER companion_birth_receipt_immutable BEFORE UPDATE OR DELETE ON platform_companion_birth_receipts
      FOR EACH ROW EXECUTE FUNCTION companion_birth_keep_private_record();
  END IF;
END $birth_trigger$;
DO $birth_trigger$ BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgname='companion_birth_assets_immutable' AND tgrelid='platform_companion_birth_assets'::regclass) THEN
    CREATE TRIGGER companion_birth_assets_immutable BEFORE UPDATE OR DELETE ON platform_companion_birth_assets
      FOR EACH ROW EXECUTE FUNCTION companion_birth_keep_private_record();
  END IF;
END $birth_trigger$;
-- Ordinary parent account deletion can cascade private records. An owner-
-- scoped delete/repair/upsert cannot remove or replace birth while owner lives.

CREATE OR REPLACE FUNCTION companion_birth_keep_event() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='UPDATE' AND OLD.birth_receipt_id IS NULL AND NEW.birth_receipt_id IS NOT NULL THEN
    RAISE EXCEPTION 'a birth event must be newly inserted' USING ERRCODE='23514';
  END IF;
  IF OLD.birth_receipt_id IS NOT NULL AND EXISTS(SELECT 1 FROM platform_users WHERE id=OLD.user_id) THEN
    RAISE EXCEPTION 'the committed birth event is immutable' USING ERRCODE='23514';
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
DO $birth_trigger$ BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgname='companion_birth_event_immutable' AND tgrelid='platform_messages'::regclass) THEN
    CREATE TRIGGER companion_birth_event_immutable BEFORE UPDATE OR DELETE ON platform_messages
      FOR EACH ROW EXECUTE FUNCTION companion_birth_keep_event();
  END IF;
END $birth_trigger$;
CREATE OR REPLACE FUNCTION companion_birth_keep_main() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN
    IF OLD.kind='main' AND EXISTS(SELECT 1 FROM platform_users WHERE id=OLD.user_id) THEN
      RAISE EXCEPTION 'the main room cannot be deleted while owner exists' USING ERRCODE='23514';
    END IF;
    RETURN OLD;
  END IF;
  IF OLD.kind='legacy' AND NEW.kind IS DISTINCT FROM OLD.kind THEN
    RAISE EXCEPTION 'a legacy room cannot be adopted as main' USING ERRCODE='23514';
  END IF;
  IF OLD.kind='main' AND (NEW.id IS DISTINCT FROM OLD.id OR NEW.user_id IS DISTINCT FROM OLD.user_id
    OR NEW.kind IS DISTINCT FROM OLD.kind OR NEW.companion_id IS DISTINCT FROM OLD.companion_id
    OR NEW.birth_receipt_id IS DISTINCT FROM OLD.birth_receipt_id) THEN
    RAISE EXCEPTION 'the main room origin cannot be replaced' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
DO $birth_trigger$ BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgname='companion_main_origin_immutable' AND tgrelid='platform_conversations'::regclass) THEN
    CREATE TRIGGER companion_main_origin_immutable BEFORE UPDATE OR DELETE ON platform_conversations
      FOR EACH ROW EXECUTE FUNCTION companion_birth_keep_main();
  END IF;
END $birth_trigger$;
CREATE OR REPLACE FUNCTION companion_birth_keep_origin() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.birth_receipt_id IS NOT NULL AND (NEW.id IS DISTINCT FROM OLD.id OR NEW.user_id IS DISTINCT FROM OLD.user_id
    OR NEW.birth_receipt_id IS DISTINCT FROM OLD.birth_receipt_id
    OR NEW.birth_idempotency_key IS DISTINCT FROM OLD.birth_idempotency_key OR NEW.born_at IS DISTINCT FROM OLD.born_at) THEN
    RAISE EXCEPTION 'a committed companion birth cannot be replaced' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
DO $birth_trigger$ BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgname='companion_birth_origin_immutable' AND tgrelid='platform_companions'::regclass) THEN
    CREATE TRIGGER companion_birth_origin_immutable BEFORE UPDATE ON platform_companions
      FOR EACH ROW EXECUTE FUNCTION companion_birth_keep_origin();
  END IF;
END $birth_trigger$;

COMMENT ON TABLE platform_companion_birth_receipts IS
  'Immutable actual origin only. Same owner/key canonical request replay is a service read; different payload conflicts. No approval/clinical/model/tool authority is inferred from this row.';
COMMENT ON TABLE platform_companion_birth_assets IS
  'Atomic immutable SVG/PNG pair for the actual birth. No renderer, source license, review, current admission or future reseal operation is created by this migration.';
COMMENT ON COLUMN platform_companions.overlays IS
  'No default or manufactured expiry. Runtime must derive and preserve actual safety restrictions before allowing C1/tasks.';
