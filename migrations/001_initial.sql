CREATE TABLE IF NOT EXISTS articles (
  id text PRIMARY KEY,
  title text NOT NULL,
  source_type text NOT NULL CHECK (source_type IN ('url', 'pdf', 'docx', 'markdown', 'text')),
  source_url text,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  word_count integer NOT NULL CHECK (word_count >= 0),
  estimated_minutes integer NOT NULL CHECK (estimated_minutes >= 0),
  sentence_count integer NOT NULL CHECK (sentence_count >= 0),
  processing_cost_usd numeric(12, 6) NOT NULL DEFAULT 0,
  progress_sentence_index integer NOT NULL DEFAULT 0,
  progress_percent double precision NOT NULL DEFAULT 0 CHECK (progress_percent >= 0 AND progress_percent <= 1),
  progress_updated_at timestamptz NOT NULL,
  content_html text NOT NULL,
  text_content text NOT NULL,
  blocks jsonb NOT NULL
);

CREATE INDEX IF NOT EXISTS articles_created_at_idx ON articles (created_at DESC);
CREATE INDEX IF NOT EXISTS articles_source_url_idx ON articles (source_url);
