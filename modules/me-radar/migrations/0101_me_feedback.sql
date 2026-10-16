CREATE TABLE me_feedback (
  id          bigserial PRIMARY KEY,
  article_id  text NOT NULL REFERENCES articles (id) ON DELETE CASCADE,
  value       text NOT NULL CHECK (value IN ('useful', 'useless')),
  created_at  timestamptz NOT NULL DEFAULT now()
);
