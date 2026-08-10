INSERT INTO reading_folders (
  id,
  owner_email,
  name,
  slug,
  is_archive,
  sort_order,
  created_at,
  updated_at
)
SELECT
  'folder-default-' || md5(owners.owner_email),
  owners.owner_email,
  'Default',
  'default',
  false,
  -1,
  NOW(),
  NOW()
FROM (
  SELECT DISTINCT owner_email
  FROM articles
) AS owners
WHERE NOT EXISTS (
  SELECT 1
  FROM reading_folders AS existing
  WHERE
    existing.owner_email = owners.owner_email
    AND (existing.slug = 'default' OR lower(existing.name) = 'default')
)
ON CONFLICT (owner_email, slug) DO NOTHING;

UPDATE reading_folders
SET
  name = 'Default',
  is_archive = false,
  sort_order = LEAST(sort_order, -1)
WHERE slug = 'default' OR lower(name) = 'default';

UPDATE articles AS article
SET folder_id = (
  SELECT folder.id
  FROM reading_folders AS folder
  WHERE
    folder.owner_email = article.owner_email
    AND (folder.slug = 'default' OR lower(folder.name) = 'default')
  ORDER BY
    CASE WHEN folder.slug = 'default' THEN 0 ELSE 1 END,
    folder.sort_order,
    folder.created_at
  LIMIT 1
)
WHERE article.folder_id IS NULL;

ALTER TABLE articles
  DROP CONSTRAINT IF EXISTS articles_folder_id_fkey;

ALTER TABLE articles
  ALTER COLUMN folder_id SET NOT NULL;

ALTER TABLE articles
  ADD CONSTRAINT articles_folder_id_fkey
  FOREIGN KEY (folder_id)
  REFERENCES reading_folders (id)
  ON DELETE RESTRICT;
