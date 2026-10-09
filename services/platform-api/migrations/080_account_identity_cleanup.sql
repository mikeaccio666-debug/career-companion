-- Bind account-owned counters to real accounts. Shared socket-IP counters are
-- intentionally ownerless: deleting one account must not reset everyone at an IP.
DELETE FROM platform_request_limits r WHERE subject_type='user'
 AND NOT EXISTS(SELECT 1 FROM platform_users u WHERE u.id::text=r.subject_key);
ALTER TABLE platform_request_limits ADD COLUMN IF NOT EXISTS owner_id uuid
 GENERATED ALWAYS AS (CASE WHEN subject_type='user' THEN subject_key::uuid ELSE NULL END) STORED;
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conname='request_limits_owner_fk' AND conrelid='platform_request_limits'::regclass) THEN
  ALTER TABLE platform_request_limits ADD CONSTRAINT request_limits_owner_fk
   FOREIGN KEY(owner_id) REFERENCES platform_users(id) ON DELETE CASCADE;
 END IF;
END $$;
CREATE INDEX IF NOT EXISTS request_limits_owner ON platform_request_limits(owner_id) WHERE owner_id IS NOT NULL;

-- Same purpose-separated SHA-256 bytes as AccountActions.targetHash (including
-- its NUL separator). No extension and no plaintext address column are needed.
ALTER TABLE platform_account_action_limits ADD COLUMN IF NOT EXISTS user_id uuid;
UPDATE platform_account_action_limits r SET user_id=u.id FROM platform_users u
 WHERE r.user_id IS NULL AND r.target_hash=encode(sha256(
  convert_to('career-companion:account-email-target:v1','UTF8')||decode('00','hex')||convert_to(u.email,'UTF8')),'hex');
-- Unknown/previously deleted recipients cannot send account mail. Their legacy
-- one-hour counters have no owner to cascade; anonymous IP admission remains.
DELETE FROM platform_account_action_limits WHERE user_id IS NULL;
ALTER TABLE platform_account_action_limits ALTER COLUMN user_id SET NOT NULL;
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conname='account_action_limits_owner_fk' AND conrelid='platform_account_action_limits'::regclass) THEN
  ALTER TABLE platform_account_action_limits ADD CONSTRAINT account_action_limits_owner_fk
   FOREIGN KEY(user_id) REFERENCES platform_users(id) ON DELETE CASCADE;
 END IF;
END $$;
CREATE INDEX IF NOT EXISTS account_action_limits_owner ON platform_account_action_limits(user_id);

-- Already-redeemed invitations with no surviving recipient are not reusable
-- invitations. Remove their legacy recipient digest as well as their code hash.
DELETE FROM platform_invites WHERE redeemed_at IS NOT NULL AND redeemed_user_id IS NULL;
CREATE INDEX IF NOT EXISTS invitations_recipient_digest ON platform_invites(email_digest);
CREATE INDEX IF NOT EXISTS invitations_redeemed_owner ON platform_invites(redeemed_user_id);
CREATE OR REPLACE FUNCTION privacy_remove_account_invitations() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 DELETE FROM platform_invites WHERE redeemed_user_id=OLD.id
  OR (redeemed_user_id IS NULL AND email_digest=encode(sha256(convert_to(OLD.email,'UTF8')),'hex'));
 RETURN OLD;
END $$;
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgname='privacy_remove_account_invitations' AND tgrelid='platform_users'::regclass) THEN
  CREATE TRIGGER privacy_remove_account_invitations BEFORE DELETE ON platform_users
   FOR EACH ROW EXECUTE FUNCTION privacy_remove_account_invitations();
 END IF;
END $$;
