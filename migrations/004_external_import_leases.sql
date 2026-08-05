ALTER TABLE external_imports
  ADD COLUMN IF NOT EXISTS attempt_id text;

ALTER TABLE external_imports
  DROP CONSTRAINT IF EXISTS external_imports_article_id_fkey;

ALTER TABLE external_imports
  ADD CONSTRAINT external_imports_article_id_fkey
  FOREIGN KEY (article_id)
  REFERENCES articles(id)
  ON DELETE SET NULL;
