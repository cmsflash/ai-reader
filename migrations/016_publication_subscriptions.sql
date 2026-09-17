CREATE TABLE IF NOT EXISTS publication_subscriptions (
  owner_email text NOT NULL,
  source text NOT NULL,
  folder_id text NOT NULL REFERENCES reading_folders(id),
  last_checked_at timestamptz,
  last_error text,
  PRIMARY KEY (owner_email, source)
);
CREATE TABLE IF NOT EXISTS publication_items (
  owner_email text NOT NULL,
  source text NOT NULL,
  url text NOT NULL,
  article_id text NOT NULL,
  content_hash text NOT NULL,
  checked_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (owner_email, source, url)
);
