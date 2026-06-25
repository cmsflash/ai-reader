ALTER TABLE articles ADD COLUMN IF NOT EXISTS owner_email text;

CREATE INDEX IF NOT EXISTS articles_owner_created_at_idx
  ON articles (owner_email, created_at DESC);
