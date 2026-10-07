-- Empty, server-managed money policies. These rows do not grant enrollment, consent or execution authority.
CREATE TABLE platform_model_prices (
  id uuid PRIMARY KEY,
  provider text NOT NULL CHECK (provider ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$'),
  model text NOT NULL CHECK (length(model) BETWEEN 1 AND 150),
  capability text NOT NULL CHECK (capability IN ('chat','background','job','realtime','speech','transcription','external_tool')),
  unit text NOT NULL CHECK (unit IN ('input_token','cached_input_token','output_token','audio_second','character','session_minute')),
  micros_per_unit numeric(20,6) NOT NULL CHECK (micros_per_unit > 0),
  effective_from timestamptz NOT NULL, effective_to timestamptz,
  CHECK (effective_to IS NULL OR effective_to > effective_from)
);
CREATE INDEX platform_model_prices_route ON platform_model_prices(provider,model,capability,unit,effective_from);

CREATE TABLE platform_cost_global_policy (
  singleton boolean PRIMARY KEY CHECK (singleton),
  month_hard_micros bigint NOT NULL CHECK (month_hard_micros > 0),
  day_hard_micros bigint NOT NULL CHECK (day_hard_micros > 0),
  approved_by uuid REFERENCES platform_users(id) ON DELETE SET NULL,
  approved_at timestamptz NOT NULL,
  effective_from timestamptz NOT NULL, effective_to timestamptz,
  CHECK (effective_to IS NULL OR effective_to > effective_from)
);
CREATE TABLE platform_cost_user_policy (
  user_id uuid PRIMARY KEY REFERENCES platform_users(id) ON DELETE CASCADE,
  policy_key text NOT NULL CHECK (length(policy_key) BETWEEN 1 AND 80),
  period text NOT NULL CHECK (period IN ('week','month')),
  soft_behavior text NOT NULL CHECK (soft_behavior IN ('notify','degrade')),
  soft_micros bigint NOT NULL CHECK (soft_micros > 0),
  hard_micros bigint NOT NULL CHECK (hard_micros >= soft_micros),
  day_micros bigint CHECK (day_micros > 0),
  approved_by uuid REFERENCES platform_users(id) ON DELETE SET NULL,
  approved_at timestamptz NOT NULL,
  effective_from timestamptz NOT NULL, effective_to timestamptz,
  CHECK (effective_to IS NULL OR effective_to > effective_from)
);

CREATE TABLE platform_cost_reservations (
  id uuid PRIMARY KEY,
  user_id uuid REFERENCES platform_users(id) ON DELETE SET NULL,
  source_kind text NOT NULL CHECK (source_kind IN ('chat_call','realtime_session','tts','transcription','job','external_tool')),
  source_id uuid NOT NULL,
  capability text NOT NULL CHECK (capability IN ('chat','background')),
  purpose text NOT NULL CHECK (length(purpose) BETWEEN 1 AND 80),
  provider text NOT NULL CHECK (provider ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$'),
  model text NOT NULL CHECK (length(model) BETWEEN 1 AND 150),
  max_input_tokens integer NOT NULL CHECK (max_input_tokens BETWEEN 0 AND 2147483647),
  max_output_tokens integer NOT NULL CHECK (max_output_tokens BETWEEN 0 AND 2147483647),
  input_price_id uuid NOT NULL REFERENCES platform_model_prices(id),
  output_price_id uuid NOT NULL REFERENCES platform_model_prices(id),
  input_micros_per_unit numeric(20,6) NOT NULL CHECK (input_micros_per_unit > 0),
  output_micros_per_unit numeric(20,6) NOT NULL CHECK (output_micros_per_unit > 0),
  estimate_micros bigint NOT NULL CHECK (estimate_micros > 0),
  ttl_seconds integer NOT NULL CHECK (ttl_seconds BETWEEN 1 AND 3600),
  status text NOT NULL CHECK (status IN ('reserved','admitted','committed','released')),
  expires_at timestamptz NOT NULL, admitted_at timestamptz, finished_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(id,user_id,capability,source_kind,source_id,provider,model,purpose),
  CHECK ((capability='chat' AND source_kind='chat_call') OR (capability='background' AND source_kind='job')),
  CHECK ((status='reserved' AND admitted_at IS NULL AND finished_at IS NULL)
    OR (status='admitted' AND admitted_at IS NOT NULL AND finished_at IS NULL)
    OR (status='committed' AND admitted_at IS NOT NULL AND finished_at IS NOT NULL)
    OR (status='released' AND admitted_at IS NULL AND finished_at IS NOT NULL))
);
CREATE INDEX platform_cost_reservations_pending ON platform_cost_reservations(user_id,created_at)
  WHERE status IN ('reserved','admitted');
CREATE TABLE platform_cost_ledger (
  reservation_id uuid PRIMARY KEY REFERENCES platform_cost_reservations(id),
  user_id uuid REFERENCES platform_users(id) ON DELETE SET NULL,
  capability text NOT NULL CHECK (capability IN ('chat','background')),
  source_kind text NOT NULL CHECK (source_kind IN ('chat_call','job')),
  source_id uuid NOT NULL,
  provider text NOT NULL, model text NOT NULL,
  units jsonb NOT NULL CHECK (jsonb_typeof(units)='object'),
  cost_micros bigint NOT NULL CHECK (cost_micros >= 0),
  estimated boolean NOT NULL,
  usage_status text NOT NULL CHECK (usage_status IN ('reported','missing','invalid','expired')),
  purpose text NOT NULL,
  created_at timestamptz NOT NULL,
  settled_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY(reservation_id,user_id,capability,source_kind,source_id,provider,model,purpose)
    REFERENCES platform_cost_reservations(id,user_id,capability,source_kind,source_id,provider,model,purpose),
  CHECK (estimated=(usage_status<>'reported'))
);
CREATE INDEX platform_cost_ledger_owner_period ON platform_cost_ledger(user_id,created_at);
