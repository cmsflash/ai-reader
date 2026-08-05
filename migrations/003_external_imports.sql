CREATE TABLE IF NOT EXISTS external_imports (
  owner_email text NOT NULL,
  provider text NOT NULL,
  external_id text NOT NULL,
  source_hash text,
  article_id text REFERENCES articles(id) ON DELETE CASCADE,
  status text NOT NULL CHECK (status IN ('pending', 'completed', 'failed')),
  source_title text,
  source_url text,
  error_message text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (owner_email, provider, external_id)
);

CREATE INDEX IF NOT EXISTS external_imports_owner_provider_updated_idx
  ON external_imports (owner_email, provider, updated_at DESC);
