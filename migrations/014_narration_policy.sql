CREATE TABLE IF NOT EXISTS narration_folder_invalidations (
  owner_email text NOT NULL,
  folder_id text NOT NULL,
  requested_version bigint NOT NULL,
  completed_version bigint NOT NULL DEFAULT 0,
  claim_token text,
  claimed_version bigint,
  lease_expires_at timestamptz,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (owner_email, folder_id),
  CHECK (completed_version <= requested_version),
  CHECK (
    (claim_token IS NULL AND claimed_version IS NULL AND lease_expires_at IS NULL)
    OR
    (claim_token IS NOT NULL AND claimed_version IS NOT NULL AND lease_expires_at IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS narration_folder_invalidations_claim_idx
  ON narration_folder_invalidations (next_attempt_at, updated_at)
  WHERE requested_version > completed_version;

CREATE TABLE IF NOT EXISTS article_narration_jobs (
  id text PRIMARY KEY,
  owner_email text NOT NULL,
  article_id text NOT NULL,
  selection_folder_id text NOT NULL,
  selection_rank integer NOT NULL CHECK (selection_rank BETWEEN 1 AND 10),
  selection_folder_invalidation_version bigint NOT NULL DEFAULT 0,
  source_text_sha256 text NOT NULL,
  sentence_map_fingerprint text NOT NULL,
  generation_fingerprint text NOT NULL,
  language text NOT NULL,
  profile_id text NOT NULL,
  profile_version text NOT NULL,
  speech_model text NOT NULL,
  voice text NOT NULL,
  status text NOT NULL CHECK (
    status IN ('pending', 'running', 'completed', 'failed', 'cancelled')
  ),
  attempt_id text,
  workflow_run_id text,
  lease_expires_at timestamptz,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  cycle_attempt_count integer NOT NULL DEFAULT 0
    CHECK (cycle_attempt_count BETWEEN 0 AND 2),
  retry_cycle integer NOT NULL DEFAULT 0 CHECK (retry_cycle >= 0),
  failure_kind text CHECK (failure_kind IN ('transient', 'terminal')),
  cycle_exhausted_at timestamptz,
  failure_folder_invalidation_version bigint,
  estimated_cost_usd numeric(12, 6) NOT NULL DEFAULT 0
    CHECK (estimated_cost_usd >= 0),
  actual_cost_usd numeric(12, 6) NOT NULL DEFAULT 0
    CHECK (actual_cost_usd >= 0),
  cost_events jsonb NOT NULL DEFAULT '{}'::jsonb,
  article_cost_recorded_usd numeric(12, 6) NOT NULL DEFAULT 0
    CHECK (article_cost_recorded_usd >= 0),
  article_cost_recorded_at timestamptz,
  planned_segment_count integer
    CHECK (planned_segment_count IS NULL OR planned_segment_count >= 0),
  error_message text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  UNIQUE (owner_email, article_id, generation_fingerprint),
  FOREIGN KEY (owner_email, article_id)
    REFERENCES articles (owner_email, id)
    ON DELETE CASCADE,
  CHECK (
    (status = 'running' AND attempt_id IS NOT NULL AND lease_expires_at IS NOT NULL)
    OR
    (status <> 'running' AND attempt_id IS NULL AND lease_expires_at IS NULL)
  ),
  CHECK (
    article_cost_recorded_at IS NULL
    OR status IN ('completed', 'failed', 'cancelled')
  ),
  CHECK (article_cost_recorded_usd <= actual_cost_usd),
  CHECK (
    (cycle_exhausted_at IS NULL AND failure_folder_invalidation_version IS NULL)
    OR
    (
      cycle_exhausted_at IS NOT NULL
      AND failure_kind = 'transient'
      AND failure_folder_invalidation_version IS NOT NULL
    )
  )
);

ALTER TABLE article_narration_jobs
  ADD COLUMN IF NOT EXISTS selection_folder_invalidation_version bigint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS cycle_attempt_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS retry_cycle integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS failure_kind text,
  ADD COLUMN IF NOT EXISTS cycle_exhausted_at timestamptz,
  ADD COLUMN IF NOT EXISTS failure_folder_invalidation_version bigint,
  ADD COLUMN IF NOT EXISTS article_cost_recorded_usd numeric(12, 6) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS article_cost_recorded_at timestamptz;

CREATE INDEX IF NOT EXISTS article_narration_jobs_claim_idx
  ON article_narration_jobs (next_attempt_at, updated_at)
  WHERE status IN ('pending', 'failed', 'running');

CREATE INDEX IF NOT EXISTS article_narration_jobs_article_idx
  ON article_narration_jobs (owner_email, article_id, created_at DESC);

CREATE TABLE IF NOT EXISTS article_narration_job_segments (
  job_id text NOT NULL
    REFERENCES article_narration_jobs (id)
    ON DELETE CASCADE,
  segment_index integer NOT NULL CHECK (segment_index >= 0),
  input_text text NOT NULL,
  input_sha256 text NOT NULL,
  input_code_points integer NOT NULL CHECK (input_code_points >= 0),
  unit_map jsonb NOT NULL,
  status text NOT NULL CHECK (
    status IN ('pending', 'running', 'completed', 'failed', 'cancelled')
  ),
  attempt_id text,
  job_attempt_id text,
  lease_expires_at timestamptz,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  cycle_attempt_count integer NOT NULL DEFAULT 0
    CHECK (cycle_attempt_count BETWEEN 0 AND 2),
  retry_cycle integer NOT NULL DEFAULT 0 CHECK (retry_cycle >= 0),
  artifact_key text,
  artifact_visibility text CHECK (artifact_visibility IN ('private', 'public')),
  content_type text,
  byte_length integer CHECK (byte_length IS NULL OR byte_length >= 0),
  duration_seconds numeric(12, 3)
    CHECK (duration_seconds IS NULL OR duration_seconds >= 0),
  alignment_model text,
  transcript_sha256 text,
  qa jsonb,
  alignment jsonb,
  local_sentence_cues jsonb,
  tts_cost_usd numeric(12, 6) NOT NULL DEFAULT 0 CHECK (tts_cost_usd >= 0),
  alignment_cost_usd numeric(12, 6) NOT NULL DEFAULT 0
    CHECK (alignment_cost_usd >= 0),
  diagnostic_cost_usd numeric(12, 6) NOT NULL DEFAULT 0
    CHECK (diagnostic_cost_usd >= 0),
  error_message text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  PRIMARY KEY (job_id, segment_index),
  CHECK (
    (status = 'running' AND attempt_id IS NOT NULL AND job_attempt_id IS NOT NULL AND lease_expires_at IS NOT NULL)
    OR
    (status <> 'running' AND attempt_id IS NULL AND job_attempt_id IS NULL AND lease_expires_at IS NULL)
  )
);

ALTER TABLE article_narration_job_segments
  ADD COLUMN IF NOT EXISTS cycle_attempt_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS retry_cycle integer NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS article_narration_job_segments_claim_idx
  ON article_narration_job_segments (job_id, next_attempt_at, segment_index)
  WHERE status IN ('pending', 'failed', 'running');

CREATE OR REPLACE FUNCTION request_narration_folder_reconciliation(
  requested_owner_email text,
  requested_folder_id text
)
RETURNS void
LANGUAGE sql
AS $function$
  INSERT INTO narration_folder_invalidations (
    owner_email,
    folder_id,
    requested_version,
    completed_version,
    next_attempt_at,
    created_at,
    updated_at
  )
  SELECT
    requested_owner_email,
    requested_folder_id,
    txid_current(),
    0,
    now(),
    now(),
    now()
  FROM reading_folders AS folder
  WHERE
    requested_owner_email IS NOT NULL
    AND requested_folder_id IS NOT NULL
    AND folder.owner_email = requested_owner_email
    AND folder.id = requested_folder_id
    AND folder.is_archive = false
  ON CONFLICT (owner_email, folder_id) DO UPDATE
  SET
    requested_version = GREATEST(
      narration_folder_invalidations.requested_version,
      EXCLUDED.requested_version
    ),
    next_attempt_at = LEAST(
      narration_folder_invalidations.next_attempt_at,
      EXCLUDED.next_attempt_at
    ),
    last_error = NULL,
    updated_at = EXCLUDED.updated_at;
$function$;

CREATE OR REPLACE FUNCTION invalidate_narration_policy_for_article_change()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.archived_at IS NULL THEN
      PERFORM request_narration_folder_reconciliation(
        OLD.owner_email,
        OLD.folder_id
      );
    END IF;
    RETURN OLD;
  END IF;

  IF TG_OP = 'UPDATE' THEN
    IF
      OLD.owner_email IS NOT DISTINCT FROM NEW.owner_email AND
      OLD.folder_id IS NOT DISTINCT FROM NEW.folder_id AND
      OLD.archived_at IS NOT DISTINCT FROM NEW.archived_at AND
      OLD.created_at IS NOT DISTINCT FROM NEW.created_at AND
      OLD.title IS NOT DISTINCT FROM NEW.title
    THEN
      RETURN NEW;
    END IF;

    IF OLD.archived_at IS NULL THEN
      PERFORM request_narration_folder_reconciliation(
        OLD.owner_email,
        OLD.folder_id
      );
    END IF;
  END IF;

  IF NEW.archived_at IS NULL THEN
    PERFORM request_narration_folder_reconciliation(
      NEW.owner_email,
      NEW.folder_id
    );
  END IF;

  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS articles_invalidate_narration_policy
  ON articles;

CREATE TRIGGER articles_invalidate_narration_policy
AFTER INSERT OR DELETE OR UPDATE OF owner_email, folder_id, archived_at, created_at, title
ON articles
FOR EACH ROW
EXECUTE FUNCTION invalidate_narration_policy_for_article_change();

CREATE OR REPLACE FUNCTION invalidate_narration_policy_for_folder_change()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF OLD.is_archive = true AND NEW.is_archive = false THEN
    PERFORM request_narration_folder_reconciliation(
      NEW.owner_email,
      NEW.id
    );
  END IF;

  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS reading_folders_invalidate_narration_policy
  ON reading_folders;

CREATE TRIGGER reading_folders_invalidate_narration_policy
AFTER UPDATE OF is_archive
ON reading_folders
FOR EACH ROW
EXECUTE FUNCTION invalidate_narration_policy_for_folder_change();

INSERT INTO narration_folder_invalidations (
  owner_email,
  folder_id,
  requested_version,
  completed_version,
  next_attempt_at,
  created_at,
  updated_at
)
SELECT
  folder.owner_email,
  folder.id,
  txid_current(),
  0,
  now(),
  now(),
  now()
FROM reading_folders AS folder
WHERE folder.is_archive = false
ON CONFLICT (owner_email, folder_id) DO NOTHING;
