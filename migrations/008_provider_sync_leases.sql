CREATE TABLE IF NOT EXISTS provider_sync_leases (
  owner_email text PRIMARY KEY,
  lease_id text NOT NULL,
  expires_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS provider_sync_leases_expires_at_idx
  ON provider_sync_leases (expires_at);
