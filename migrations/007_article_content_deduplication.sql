ALTER TABLE articles
  ADD COLUMN IF NOT EXISTS content_fingerprint text;

CREATE UNIQUE INDEX IF NOT EXISTS articles_owner_content_fingerprint_uidx
  ON articles (owner_email, content_fingerprint)
  WHERE content_fingerprint IS NOT NULL;

CREATE INDEX IF NOT EXISTS external_imports_owner_article_idx
  ON external_imports (owner_email, article_id)
  WHERE article_id IS NOT NULL;
