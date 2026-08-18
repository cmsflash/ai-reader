ALTER TABLE articles
  ADD COLUMN IF NOT EXISTS narration jsonb;
