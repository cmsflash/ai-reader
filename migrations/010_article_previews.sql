ALTER TABLE articles
  ADD COLUMN IF NOT EXISTS excerpt text;

ALTER TABLE articles
  ADD COLUMN IF NOT EXISTS thumbnail_url text;

ALTER TABLE articles
  ADD COLUMN IF NOT EXISTS preview_version smallint NOT NULL DEFAULT 0;

UPDATE articles AS target
SET
  excerpt = COALESCE(
    (
      SELECT LEFT(
        REGEXP_REPLACE(preview_block.value->>'text', E'\\s+', ' ', 'g'),
        361
      )
      FROM jsonb_array_elements(target.blocks) WITH ORDINALITY AS preview_block(value, position)
      WHERE
        preview_block.value->>'type' IN ('paragraph', 'quote')
        AND BTRIM(COALESCE(preview_block.value->>'text', '')) <> ''
        AND NOT (
          LOWER(BTRIM(preview_block.value->>'text')) ~
            '^(updated|published|posted|last updated)[[:space:]]+(on[[:space:]]+)?'
          OR LOWER(BTRIM(preview_block.value->>'text')) ~
            '^(share this( post)?|in this (blog|article))$'
          OR (
            BTRIM(preview_block.value->>'text') !~ '[.!?][”"'']?$'
            AND LOWER(BTRIM(preview_block.value->>'text')) ~
              '(student researcher|researcher|fellow|vice president|vp|chief [a-z -]+ officer|editor|writer)'
            AND BTRIM(preview_block.value->>'text') LIKE '%,%'
          )
          OR LOWER(BTRIM(preview_block.value->>'text')) ~
            '^[^.!?]{1,80} (is|was) (the|a|an) (chief|vice president|vp|president|director|professor|researcher|writer|editor|founder|co-founder)'
          OR LOWER(BTRIM(preview_block.value->>'text')) ~
            '^[^.!?]{1,80} (received|earned|holds?) (his|her|their|a) (ph\.?d|doctorate|master)'
        )
      ORDER BY
        CASE
          WHEN char_length(BTRIM(preview_block.value->>'text')) >= 80 THEN 0
          WHEN char_length(BTRIM(preview_block.value->>'text')) >= 40 THEN 1
          ELSE 2
        END,
        preview_block.position
      LIMIT 1
    ),
    LEFT(REGEXP_REPLACE(target.text_content, E'\\s+', ' ', 'g'), 361)
  ),
  thumbnail_url = (
    SELECT COALESCE(
      NULLIF(image_block.value->>'src', ''),
      NULLIF(image_block.value->>'originalSrc', '')
    )
    FROM jsonb_array_elements(target.blocks) WITH ORDINALITY AS image_block(value, position)
    WHERE
      image_block.value->>'type' = 'image'
      AND COALESCE(
        NULLIF(image_block.value->>'src', ''),
        NULLIF(image_block.value->>'originalSrc', '')
      ) IS NOT NULL
    ORDER BY
      CASE
        WHEN LOWER(
          CONCAT_WS(
            ' ',
            image_block.value->>'alt',
            image_block.value->>'src',
            image_block.value->>'originalSrc'
          )
        ) ~ '(avatar|emoji|favicon|icon|logo|profile)'
        THEN 1
        ELSE 0
      END,
      image_block.position
    LIMIT 1
  ),
  preview_version = 2
WHERE target.preview_version < 2;
