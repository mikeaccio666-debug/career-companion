-- Process reports are operational observations, never task execution receipts.
CREATE TABLE platform_worker_heartbeats (
  instance_id uuid PRIMARY KEY,
  queue_name text NOT NULL CHECK (queue_name ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$'),
  code_version text NOT NULL CHECK (code_version ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$'),
  -- First successful database report time, not an asserted operating-system boot time.
  started_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  reported_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  process_state text NOT NULL CHECK (process_state IN ('starting', 'running', 'stopping')),
  redis_ready boolean NOT NULL,
  worker_running boolean NOT NULL,
  worker_paused boolean NOT NULL,
  pool_total integer NOT NULL CHECK (pool_total >= 0),
  pool_idle integer NOT NULL CHECK (pool_idle >= 0 AND pool_idle <= pool_total),
  pool_waiting integer NOT NULL CHECK (pool_waiting >= 0),
  pool_max integer NOT NULL CHECK (pool_max > 0 AND pool_total <= pool_max)
);
CREATE INDEX platform_worker_heartbeats_queue_report ON platform_worker_heartbeats(queue_name, reported_at DESC);
