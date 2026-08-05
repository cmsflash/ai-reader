ALTER TABLE external_imports
  DROP CONSTRAINT IF EXISTS external_imports_status_check;

ALTER TABLE external_imports
  ADD CONSTRAINT external_imports_status_check
  CHECK (status IN ('pending', 'completed', 'failed', 'dismissed'));

ALTER TABLE external_imports
  ADD COLUMN IF NOT EXISTS cleanup_article_id text
  REFERENCES articles(id)
  ON DELETE SET NULL;

DROP TRIGGER IF EXISTS articles_dismiss_external_imports
  ON articles;

DROP FUNCTION IF EXISTS dismiss_external_imports_on_article_delete();

DROP RULE IF EXISTS articles_dismiss_external_imports
  ON articles;

CREATE RULE articles_dismiss_external_imports AS
ON DELETE TO articles
DO ALSO (
  UPDATE external_imports
  SET
    status = 'dismissed',
    article_id = NULL,
    attempt_id = NULL,
    error_message = NULL,
    updated_at = now()
  WHERE article_id = OLD.id
);
