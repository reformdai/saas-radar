-- Private inbox only: no relationship to articles or publication queues.
CREATE TABLE wechat_groups (
  account text NOT NULL,
  group_id text NOT NULL,
  name text NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  reconcile_through bigint NOT NULL CHECK (reconcile_through > 0),
  last_received_at timestamptz,
  last_checked_at timestamptz,
  PRIMARY KEY (account, group_id),
  CHECK (group_id LIKE '%@chatroom')
);

CREATE TABLE wechat_messages (
  account text NOT NULL,
  group_id text NOT NULL,
  message_id text NOT NULL,
  sender_id text NOT NULL DEFAULT '',
  sender_name text NOT NULL DEFAULT '',
  content text NOT NULL DEFAULT '',
  sent_at bigint NOT NULL CHECK (sent_at > 0),
  revoked boolean NOT NULL DEFAULT false,
  received_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account, group_id, message_id),
  FOREIGN KEY (account, group_id) REFERENCES wechat_groups (account, group_id),
  CHECK (NOT revoked OR content = '')
);

CREATE INDEX wechat_messages_group_time ON wechat_messages (account, group_id, sent_at DESC, message_id DESC);
