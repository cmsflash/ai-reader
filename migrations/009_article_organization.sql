CREATE TABLE IF NOT EXISTS reading_folders (
  id text PRIMARY KEY,
  owner_email text NOT NULL,
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 80),
  slug text NOT NULL,
  is_archive boolean NOT NULL DEFAULT false,
  sort_order integer NOT NULL DEFAULT 0,
  speed_zh numeric(4, 2) NOT NULL DEFAULT 1.00,
  speed_en numeric(4, 2) NOT NULL DEFAULT 1.00,
  speed_other numeric(4, 2) NOT NULL DEFAULT 1.00,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  UNIQUE (owner_email, slug)
);

CREATE INDEX IF NOT EXISTS reading_folders_owner_sort_idx
  ON reading_folders (owner_email, sort_order, created_at);

ALTER TABLE articles
  ADD COLUMN IF NOT EXISTS folder_id text;

ALTER TABLE articles
  ADD COLUMN IF NOT EXISTS archived_at timestamptz;

UPDATE articles AS article
SET archived_at = COALESCE(article.archived_at, article.updated_at)
FROM reading_folders AS folder
WHERE
  article.folder_id = folder.id
  AND article.owner_email = folder.owner_email
  AND folder.is_archive = true
  AND article.archived_at IS NULL;

ALTER TABLE articles
  DROP CONSTRAINT IF EXISTS articles_folder_owner_fkey;

ALTER TABLE articles
  DROP CONSTRAINT IF EXISTS articles_folder_id_fkey;

ALTER TABLE articles
  ADD CONSTRAINT articles_folder_id_fkey
  FOREIGN KEY (folder_id)
  REFERENCES reading_folders (id)
  ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS articles_owner_archived_created_idx
  ON articles (owner_email, archived_at, created_at DESC);

CREATE INDEX IF NOT EXISTS articles_owner_folder_created_idx
  ON articles (owner_email, folder_id, created_at DESC);
