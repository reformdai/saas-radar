-- Private, evidence-backed group summaries; never projected into public articles.
CREATE TABLE wechat_digests (
  account text NOT NULL,
  group_id text NOT NULL,
  day date NOT NULL,
  revision bigint NOT NULL DEFAULT 1,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'ready', 'error')),
  input_hash text,
  points jsonb NOT NULL DEFAULT '[]',
  message_count integer NOT NULL DEFAULT 0,
  error text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  attempted_at timestamptz,
  PRIMARY KEY (account, group_id, day),
  FOREIGN KEY (account, group_id) REFERENCES wechat_groups (account, group_id)
);

CREATE INDEX wechat_digests_pending ON wechat_digests (status, attempted_at);
