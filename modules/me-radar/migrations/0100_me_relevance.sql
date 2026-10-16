CREATE TABLE me_relevance (
  article_id     text PRIMARY KEY REFERENCES articles (id) ON DELETE CASCADE,
  score          integer NOT NULL,
  why            text NOT NULL DEFAULT '',
  model          text NOT NULL DEFAULT '',
  prompt_version text NOT NULL DEFAULT '',
  receipt_ids    bigint[] NOT NULL DEFAULT '{}',
  pushed_at      timestamptz,
  decided_at     timestamptz NOT NULL DEFAULT now()
);
