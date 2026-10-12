-- Private list of local WeChat groups available for selection in the admin UI.
CREATE TABLE wechat_group_catalog (
  account text NOT NULL,
  group_id text NOT NULL CHECK (group_id LIKE '%@chatroom'),
  name text NOT NULL,
  selected boolean NOT NULL DEFAULT false,
  discovered_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account, group_id)
);

INSERT INTO wechat_group_catalog (account, group_id, name, selected)
SELECT account, group_id, name, enabled FROM wechat_groups
ON CONFLICT (account, group_id) DO NOTHING;
