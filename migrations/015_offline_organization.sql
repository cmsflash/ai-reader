ALTER TABLE articles ADD COLUMN IF NOT EXISTS organization_updated_at timestamptz;
UPDATE articles SET organization_updated_at = updated_at WHERE organization_updated_at IS NULL;
ALTER TABLE articles ALTER COLUMN organization_updated_at SET DEFAULT now();
