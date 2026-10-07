-- Account kind is server-owned. Existing and publicly registered accounts remain students.
ALTER TABLE platform_users ADD COLUMN IF NOT EXISTS account_kind text NOT NULL DEFAULT 'student'
  CHECK (account_kind IN ('student','staff'));

CREATE TABLE IF NOT EXISTS platform_orgs (
  id uuid PRIMARY KEY,
  slug text NOT NULL UNIQUE CHECK (slug ~ '^[a-z][a-z0-9_-]{0,63}$'),
  display_name text NOT NULL CHECK (length(btrim(display_name)) BETWEEN 1 AND 120),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS platform_org_roles (
  org_id uuid NOT NULL REFERENCES platform_orgs(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES platform_users(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('content_editor','content_reviewer','mentor','ops','org_admin','safety_reviewer')),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','revoked')),
  granted_by uuid REFERENCES platform_users(id) ON DELETE SET NULL,
  granted_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  PRIMARY KEY (org_id,user_id,role),
  CHECK ((status='active' AND revoked_at IS NULL) OR (status='revoked' AND revoked_at IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS platform_org_roles_owner ON platform_org_roles(user_id,org_id) WHERE status='active';

-- The service only appends receipts. No message, email, query, credential or provider payload is stored.
CREATE TABLE IF NOT EXISTS platform_staff_audit (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES platform_users(id) ON DELETE CASCADE,
  -- The requested UUID can refer to an unknown organization; missing context is NULL.
  org_id uuid,
  role text CHECK (role IN ('content_editor','content_reviewer','mentor','ops','org_admin','safety_reviewer')),
  action text NOT NULL CHECK (action IN ('organization_viewed','staff_memberships_viewed','provider_details_viewed')),
  outcome text NOT NULL CHECK (outcome IN ('allow','deny')),
  reason text NOT NULL CHECK (reason IN ('authorized','student_account','organization_missing','organization_unavailable','role_unavailable','feature_disabled')),
  target_id uuid,
  record_count integer NOT NULL CHECK (record_count >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((outcome='allow' AND role IS NOT NULL AND reason='authorized' AND org_id IS NOT NULL)
    OR (outcome='deny' AND role IS NULL AND reason<>'authorized' AND record_count=0))
);
CREATE INDEX IF NOT EXISTS platform_staff_audit_owner ON platform_staff_audit(user_id,created_at);
