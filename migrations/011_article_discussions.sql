CREATE UNIQUE INDEX IF NOT EXISTS articles_owner_id_uidx
  ON articles (owner_email, id);

CREATE TABLE IF NOT EXISTS article_discussion_messages (
  sequence bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  id text NOT NULL UNIQUE,
  owner_email text NOT NULL,
  article_id text NOT NULL,
  request_id text NOT NULL CHECK (char_length(request_id) BETWEEN 1 AND 128),
  role text NOT NULL CHECK (role IN ('user', 'assistant')),
  status text NOT NULL CHECK (status IN ('pending', 'complete', 'error')),
  content text NOT NULL,
  scope text CHECK (scope IN ('whole', 'selection')),
  selection_text text,
  attempt_id text,
  response_id text,
  model text,
  incomplete boolean,
  input_tokens integer CHECK (input_tokens IS NULL OR input_tokens >= 0),
  output_tokens integer CHECK (output_tokens IS NULL OR output_tokens >= 0),
  total_tokens integer CHECK (total_tokens IS NULL OR total_tokens >= 0),
  context_scope text CHECK (context_scope IN ('whole', 'selection')),
  context_truncated boolean,
  context_original_characters integer CHECK (
    context_original_characters IS NULL OR context_original_characters >= 0
  ),
  context_included_characters integer CHECK (
    context_included_characters IS NULL OR context_included_characters >= 0
  ),
  context_note text,
  error_code text CHECK (
    error_code IN (
      'configuration',
      'network',
      'timeout',
      'upstream',
      'invalid-response',
      'internal'
    )
  ),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  UNIQUE (owner_email, article_id, request_id, role),
  FOREIGN KEY (owner_email, article_id)
    REFERENCES articles (owner_email, id)
    ON DELETE CASCADE,
  CHECK (
    (role = 'user' AND status = 'complete' AND scope IS NOT NULL)
    OR (role = 'assistant' AND scope IS NULL AND selection_text IS NULL)
  ),
  CHECK (
    (scope = 'selection' AND selection_text IS NOT NULL)
    OR (scope = 'whole' AND selection_text IS NULL)
    OR scope IS NULL
  ),
  CHECK (role <> 'assistant' OR status <> 'complete' OR content <> '')
);

CREATE INDEX IF NOT EXISTS article_discussion_messages_owner_article_sequence_idx
  ON article_discussion_messages (owner_email, article_id, sequence);
