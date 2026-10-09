-- Original accepted session and task preparation; reference-only notifications.
CREATE TABLE platform_first_letter_requests (
 id uuid PRIMARY KEY,
 user_id uuid NOT NULL REFERENCES platform_users(id) ON DELETE CASCADE,
 task_id uuid NOT NULL,
 preparation_id text NOT NULL CHECK(preparation_id ~ '^first_letter_preparation_[a-f0-9]{64}$'),
 auth_version bigint NOT NULL CHECK(auth_version>=0),
 payload_digest text NOT NULL CHECK(payload_digest ~ '^[a-f0-9]{64}$'),
 payload_ciphertext bytea NOT NULL CHECK(octet_length(payload_ciphertext) BETWEEN 29 AND 65565),
 accepted_at timestamptz NOT NULL,
 UNIQUE(user_id,task_id),UNIQUE(id,user_id,task_id),
 FOREIGN KEY(task_id,user_id) REFERENCES platform_first_letter_tasks(id,user_id) ON DELETE CASCADE
);
CREATE TABLE platform_first_letter_outbox (
 request_id uuid PRIMARY KEY,
 user_id uuid NOT NULL,
 task_id uuid NOT NULL,
 dispatched_at timestamptz,
 held_reason text CHECK(held_reason IN ('authorization','configuration','source_changed','storage','terminal')),
 created_at timestamptz NOT NULL,
 FOREIGN KEY(request_id,user_id,task_id) REFERENCES platform_first_letter_requests(id,user_id,task_id) ON DELETE CASCADE
);
CREATE INDEX platform_first_letter_outbox_dispatch ON platform_first_letter_outbox(dispatched_at,request_id);
COMMENT ON TABLE platform_first_letter_requests IS
 'Encrypted original session, route and preparation. Neither a Redis notification nor another login renews this authority.';
