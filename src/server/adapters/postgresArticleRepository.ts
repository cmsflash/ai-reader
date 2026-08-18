import { createHash, randomUUID } from "node:crypto";
import { neon, type NeonQueryFunction } from "@neondatabase/serverless";
import {
  articleExcerpt,
  articleThumbnailUrl,
  compactPreviewText,
} from "@/lib/articlePreview";
import type {
  Article,
  ArticleBlock,
  ArticleFolder,
  ArticleNarration,
  ReadingProgress,
  SourceType,
} from "@/lib/types";
import { articleContentFingerprint } from "@/server/articles/articleDeduplication";
import {
  type ArticleListPageQuery,
  type ArticleOrganizationPatch,
  type ArticleOrganizationResult,
  type ArticleProgressPatch,
  type ArticleRepository,
} from "@/server/ports/articleRepository";

type PostgresArticleRow = {
  id: string;
  owner_email: string | null;
  title: string;
  source_type: SourceType;
  source_url: string | null;
  folder_id: string | null;
  archived_at: string | Date | null;
  excerpt: string | null;
  thumbnail_url: string | null;
  created_at: string | Date;
  updated_at: string | Date;
  word_count: number | string;
  estimated_minutes: number | string;
  sentence_count: number | string;
  processing_cost_usd: number | string | null;
  progress_sentence_index: number | string;
  progress_percent: number | string;
  progress_updated_at: string | Date;
  content_html: string;
  text_content: string;
  blocks: ArticleBlock[] | string;
  narration: ArticleNarration | string | null;
};

type PostgresArticleSummaryRow = Omit<
  PostgresArticleRow,
  "owner_email" | "content_html" | "text_content" | "blocks" | "narration"
> & {
  excerpt: string | null;
  thumbnail_url: string | null;
};

type PostgresArticleFolderRow = {
  id: string;
  name: string;
  slug: string;
  is_archive: boolean;
  created_at: string | Date;
  updated_at: string | Date;
};

type PostgresArticleOrganizationRow = {
  id: string;
  folder_id: string | null;
  archived_at: string | Date | null;
  updated_at: string | Date;
};

type PostgresArticleListCountRow = {
  total: number | string;
  active_total: number | string;
};

type PostgresArticleDeduplicationRow = Pick<
  PostgresArticleRow,
  "id" | "title" | "source_url" | "text_content"
>;

type QueryClient = {
  query(statement: string, params?: unknown[]): Promise<unknown[]>;
};

let sqlClient: NeonQueryFunction<false, false> | null = null;

export class PostgresArticleRepository implements ArticleRepository {
  private readonly queryClient?: QueryClient;

  constructor(queryClient?: QueryClient) {
    this.queryClient = queryClient;
  }

  async list(ownerEmail: string) {
    const normalizedOwner = normalizeOwnerEmail(ownerEmail);
    const defaultFolder = await this.ensureDefaultFolder(normalizedOwner);
    await this.queryRows<{ id: string }>(
      `
        UPDATE articles
        SET folder_id = $2
        WHERE owner_email = $1 AND folder_id IS NULL
        RETURNING id
      `,
      [normalizedOwner, defaultFolder.id],
    );
    const rows = await this.queryRows<PostgresArticleSummaryRow>(
      `
        SELECT ${articleSummaryColumns}
        FROM articles
        WHERE owner_email = $1
        ORDER BY created_at DESC
      `,
      [normalizedOwner],
    );

    return rows.map(rowToArticleSummary);
  }

  async listPage(ownerEmail: string, query: ArticleListPageQuery) {
    if (
      !Number.isSafeInteger(query.limit) ||
      query.limit < 1 ||
      !Number.isSafeInteger(query.offset) ||
      query.offset < 0
    ) {
      throw new Error("Invalid article list page.");
    }

    const normalizedOwner = normalizeOwnerEmail(ownerEmail);
    const folderId =
      query.location === "default"
        ? (await this.ensureDefaultFolder(normalizedOwner)).id
        : query.location.startsWith("folder:")
          ? query.location.slice("folder:".length)
          : null;
    const locationCondition = articleListLocationCondition(
      query.location,
      folderId,
    );
    const filterParams: unknown[] = [normalizedOwner];

    if (folderId) {
      filterParams.push(folderId);
    }

    const limitParameter = filterParams.length + 1;
    const offsetParameter = filterParams.length + 2;
    const [countRows, rows] = await Promise.all([
      this.queryRows<PostgresArticleListCountRow>(
        `
          SELECT
            COUNT(*) FILTER (WHERE ${locationCondition}) AS total,
            COUNT(*) FILTER (WHERE archived_at IS NULL) AS active_total
          FROM articles
          WHERE owner_email = $1
        `,
        filterParams,
      ),
      this.queryRows<PostgresArticleSummaryRow>(
        `
          SELECT ${articleSummaryColumns}
          FROM articles
          WHERE owner_email = $1 AND ${locationCondition}
          ORDER BY ${articleListOrderBy(query.sort)}
          LIMIT $${limitParameter}
          OFFSET $${offsetParameter}
        `,
        [...filterParams, query.limit, query.offset],
      ),
    ]);
    const total = numberValue(countRows[0]?.total ?? 0);
    const activeTotal = numberValue(countRows[0]?.active_total ?? 0);
    const articles = rows.map(rowToArticleSummary);
    const nextOffset = query.offset + articles.length;

    return {
      articles,
      total,
      activeTotal,
      nextOffset: nextOffset < total ? nextOffset : null,
    };
  }

  async listFolders(ownerEmail: string) {
    await this.ensureDefaultFolder(ownerEmail);
    const rows = await this.queryRows<PostgresArticleFolderRow>(
      `
        SELECT id, name, slug, is_archive, created_at, updated_at
        FROM reading_folders
        WHERE owner_email = $1
        ORDER BY sort_order, lower(name), name
      `,
      [normalizeOwnerEmail(ownerEmail)],
    );

    return rows.map(rowToArticleFolder);
  }

  async createFolder(name: string, ownerEmail: string) {
    const folderName = cleanFolderName(name);
    const normalizedName = normalizeFolderName(folderName);

    if (!normalizedName) {
      throw new Error("Folder name is required.");
    }

    if (normalizedName === "default") {
      return this.ensureDefaultFolder(ownerEmail);
    }

    const normalizedOwner = normalizeOwnerEmail(ownerEmail);
    const existing = await this.queryRows<PostgresArticleFolderRow>(
      `
        SELECT id, name, slug, is_archive, created_at, updated_at
        FROM reading_folders
        WHERE owner_email = $1 AND lower(name) = $2
        ORDER BY sort_order, created_at
        LIMIT 1
      `,
      [normalizedOwner, normalizedName],
    );

    if (existing[0]) {
      return rowToArticleFolder(existing[0]);
    }

    const now = new Date().toISOString();
    const id = `folder-${randomUUID()}`;
    const rows = await this.queryRows<PostgresArticleFolderRow>(
      `
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
        VALUES (
          $1,
          $2,
          $3,
          $4,
          false,
          COALESCE(
            (SELECT MAX(sort_order) + 1 FROM reading_folders WHERE owner_email = $2),
            0
          ),
          $5::timestamptz,
          $5::timestamptz
        )
        ON CONFLICT (owner_email, slug) DO UPDATE
        SET updated_at = reading_folders.updated_at
        RETURNING id, name, slug, is_archive, created_at, updated_at
      `,
      [
        id,
        normalizedOwner,
        folderName,
        folderStorageSlug(folderName),
        now,
      ],
    );

    if (!rows[0]) {
      throw new Error("Could not create folder.");
    }

    return rowToArticleFolder(rows[0]);
  }

  async listDeduplicationCandidates(ownerEmail: string) {
    const rows = await this.queryRows<PostgresArticleDeduplicationRow>(
      `
        SELECT
          id,
          title,
          source_url,
          text_content
        FROM articles
        WHERE owner_email = $1
        ORDER BY id
      `,
      [normalizeOwnerEmail(ownerEmail)],
    );

    return rows.map((row) => ({
      id: row.id,
      title: row.title,
      sourceUrl: row.source_url ?? undefined,
      textContent: row.text_content,
    }));
  }

  async findById(id: string, ownerEmail: string) {
    const rows = await this.queryArticles(
      `
        SELECT ${articleColumns}
        FROM articles
        WHERE id = $1 AND owner_email = $2
        LIMIT 1
      `,
      [id, normalizeOwnerEmail(ownerEmail)],
    );

    return rows[0] ? rowToArticle(rows[0]) : null;
  }

  async create(article: Article, ownerEmail: string) {
    const normalizedOwner = normalizeOwnerEmail(ownerEmail);
    const defaultFolder = await this.ensureDefaultFolder(normalizedOwner);
    const articleToSave = {
      ...article,
      folderId: article.folderId ?? defaultFolder.id,
    };
    const contentFingerprint = articleContentFingerprint(articleToSave);
    const saved = await this.queryArticles(
      `
        INSERT INTO articles (
          id,
          owner_email,
          title,
          source_type,
          source_url,
          folder_id,
          archived_at,
          created_at,
          updated_at,
          word_count,
          estimated_minutes,
          sentence_count,
          processing_cost_usd,
          progress_sentence_index,
          progress_percent,
          progress_updated_at,
          content_html,
          text_content,
          blocks,
          narration,
          excerpt,
          thumbnail_url,
          preview_version,
          content_fingerprint
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7::timestamptz, $8::timestamptz, $9::timestamptz, $10, $11, $12, $13, $14, $15, $16::timestamptz, $17, $18, $19::jsonb, $20::jsonb, $21, $22, 2, $23)
        ON CONFLICT DO NOTHING
        RETURNING ${articleColumns}
      `,
      [
        articleToSave.id,
        normalizedOwner,
        ...articleParams(articleToSave).slice(1),
        articleToSave.excerpt ?? articleExcerpt(articleToSave),
        articleToSave.thumbnailUrl ?? articleThumbnailUrl(articleToSave),
        contentFingerprint ?? null,
      ],
    );

    if (saved[0]) {
      return rowToArticle(saved[0]);
    }

    const existing = await this.findById(articleToSave.id, ownerEmail);

    if (existing) {
      return existing;
    }

    if (contentFingerprint) {
      const duplicates = await this.queryArticles(
        `
          SELECT ${articleColumns}
          FROM articles
          WHERE owner_email = $1 AND content_fingerprint = $2
          LIMIT 1
        `,
        [normalizedOwner, contentFingerprint],
      );

      if (duplicates[0]) {
        return rowToArticle(duplicates[0]);
      }
    }

    throw new Error("An article with this identifier already belongs to another owner.");
  }

  async updateProgress(id: string, ownerEmail: string, progress: ArticleProgressPatch) {
    const article = await this.findById(id, ownerEmail);

    if (!article) {
      return null;
    }

    const now = new Date().toISOString();
    const nextProgress: ReadingProgress = {
      sentenceIndex: clampInteger(
        progress.sentenceIndex ?? article.progress.sentenceIndex,
        0,
        Math.max(article.sentenceCount - 1, 0),
      ),
      percent: clampNumber(progress.percent ?? article.progress.percent, 0, 1),
      updatedAt: now,
    };

    const rows = await this.queryArticles(
      `
        UPDATE articles
        SET
          updated_at = $2::timestamptz,
          progress_sentence_index = $3,
          progress_percent = $4,
          progress_updated_at = $5::timestamptz
        WHERE id = $1 AND owner_email = $6
        RETURNING ${articleColumns}
      `,
      [
        id,
        now,
        nextProgress.sentenceIndex,
        nextProgress.percent,
        nextProgress.updatedAt,
        normalizeOwnerEmail(ownerEmail),
      ],
    );

    return rows[0] ? rowToArticle(rows[0]) : null;
  }

  async advanceProgress(id: string, ownerEmail: string, percent: number) {
    const nextPercent = clampNumber(percent, 0, 1);
    const now = new Date().toISOString();
    const rows = await this.queryArticles(
      `
        UPDATE articles
        SET
          updated_at = $2::timestamptz,
          progress_sentence_index = ROUND(
            $3::double precision * GREATEST(sentence_count - 1, 0)
          )::integer,
          progress_percent = $3,
          progress_updated_at = $2::timestamptz
        WHERE
          id = $1
          AND owner_email = $4
          AND progress_percent < $3
        RETURNING ${articleColumns}
      `,
      [id, now, nextPercent, normalizeOwnerEmail(ownerEmail)],
    );

    return rows[0] ? rowToArticle(rows[0]) : this.findById(id, ownerEmail);
  }

  async addProcessingCost(id: string, ownerEmail: string, costUsd: number) {
    const safeCost = clampNumber(costUsd, 0, Number.MAX_SAFE_INTEGER);

    if (safeCost === 0) {
      return this.findById(id, ownerEmail);
    }

    const rows = await this.queryArticles(
      `
        UPDATE articles
        SET
          updated_at = $2::timestamptz,
          processing_cost_usd = ROUND((processing_cost_usd + $3::numeric), 6)
        WHERE id = $1 AND owner_email = $4
        RETURNING ${articleColumns}
      `,
      [id, new Date().toISOString(), safeCost, normalizeOwnerEmail(ownerEmail)],
    );

    return rows[0] ? rowToArticle(rows[0]) : null;
  }

  async updateNarration(
    id: string,
    ownerEmail: string,
    narration: ArticleNarration | null,
    costUsd = 0,
    onlyIfEmpty = false,
  ) {
    const safeCost = clampNumber(costUsd, 0, Number.MAX_SAFE_INTEGER);
    const rows = await this.queryArticles(
      `
        UPDATE articles
        SET
          updated_at = $2::timestamptz,
          narration = $3::jsonb,
          processing_cost_usd = ROUND((processing_cost_usd + $4::numeric), 6)
        WHERE
          id = $1
          AND owner_email = $5
          AND (NOT $6::boolean OR narration IS NULL)
        RETURNING ${articleColumns}
      `,
      [
        id,
        new Date().toISOString(),
        narration ? JSON.stringify(narration) : null,
        safeCost,
        normalizeOwnerEmail(ownerEmail),
        onlyIfEmpty,
      ],
    );

    return rows[0] ? rowToArticle(rows[0]) : null;
  }

  async updateOrganization(
    id: string,
    ownerEmail: string,
    organization: ArticleOrganizationPatch,
  ) {
    const normalizedOwner = normalizeOwnerEmail(ownerEmail);
    const hasFolderId = Object.hasOwn(organization, "folderId");
    const folderId = organization.folderId ?? null;

    if (hasFolderId && !folderId) {
      throw new Error("Folder is required.");
    }

    const rows = await this.queryRows<PostgresArticleOrganizationRow>(
      `
        UPDATE articles
        SET
          updated_at = $3::timestamptz,
          archived_at = CASE
            WHEN $4::boolean IS NULL THEN archived_at
            WHEN $4::boolean THEN COALESCE(archived_at, $3::timestamptz)
            ELSE NULL
          END,
          folder_id = CASE
            WHEN $5::boolean THEN $6::text
            WHEN $4::boolean IS FALSE AND EXISTS (
              SELECT 1
              FROM reading_folders AS current_folder
              WHERE
                current_folder.owner_email = $2
                AND current_folder.id = articles.folder_id
                AND current_folder.is_archive = true
            )
            THEN (
              SELECT fallback.id
              FROM reading_folders AS fallback
              WHERE fallback.owner_email = $2 AND fallback.is_archive = false
              ORDER BY
                CASE WHEN fallback.slug = 'default' THEN 0 ELSE 1 END,
                fallback.sort_order,
                fallback.created_at
              LIMIT 1
            )
            ELSE folder_id
          END
        WHERE
          id = $1
          AND owner_email = $2
          AND (
            NOT $5::boolean
            OR EXISTS (
              SELECT 1
              FROM reading_folders
              WHERE owner_email = $2 AND id = $6::text
            )
          )
        RETURNING id, folder_id, archived_at, updated_at
      `,
      [
        id,
        normalizedOwner,
        new Date().toISOString(),
        typeof organization.archived === "boolean"
          ? organization.archived
          : null,
        hasFolderId,
        folderId,
      ],
    );

    if (rows[0]) {
      return rowToArticleOrganization(rows[0]);
    }

    if (hasFolderId && folderId) {
      const folders = await this.queryRows<{ id: string }>(
        "SELECT id FROM reading_folders WHERE owner_email = $1 AND id = $2 LIMIT 1",
        [normalizedOwner, folderId],
      );

      if (folders.length === 0) {
        throw new Error("Folder not found.");
      }
    }

    return null;
  }

  async deleteById(id: string, ownerEmail: string) {
    const rows = await this.queryRows<{ id: string }>(
      "DELETE FROM articles WHERE id = $1 AND owner_email = $2 RETURNING id",
      [id, normalizeOwnerEmail(ownerEmail)],
    );

    return rows.length > 0;
  }

  async deleteByIdIfUnreferenced(id: string, ownerEmail: string) {
    const rows = await this.queryRows<{ id: string }>(
      `
        DELETE FROM articles AS target
        WHERE
          target.id = $1
          AND target.owner_email = $2
          AND NOT EXISTS (
            SELECT 1
            FROM external_imports
            WHERE
              owner_email = $2
              AND article_id = target.id
              AND status <> 'dismissed'
          )
        RETURNING target.id
      `,
      [id, normalizeOwnerEmail(ownerEmail)],
    );

    return rows.length > 0;
  }

  private queryArticles(query: string, params: unknown[] = []) {
    return this.queryRows<PostgresArticleRow>(query, params);
  }

  private async queryRows<T>(query: string, params: unknown[] = []) {
    const client = this.queryClient ?? getSql();
    return (await client.query(query, params)) as T[];
  }

  private async ensureDefaultFolder(ownerEmail: string) {
    const normalizedOwner = normalizeOwnerEmail(ownerEmail);
    const existing = await this.queryRows<PostgresArticleFolderRow>(
      `
        SELECT id, name, slug, is_archive, created_at, updated_at
        FROM reading_folders
        WHERE
          owner_email = $1
          AND (slug = 'default' OR lower(name) = 'default')
        ORDER BY
          CASE WHEN slug = 'default' THEN 0 ELSE 1 END,
          sort_order,
          created_at
        LIMIT 1
      `,
      [normalizedOwner],
    );

    if (existing[0]) {
      return rowToArticleFolder(existing[0]);
    }

    const now = new Date().toISOString();
    const rows = await this.queryRows<PostgresArticleFolderRow>(
      `
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
        VALUES ($1, $2, 'Default', 'default', false, -1, $3::timestamptz, $3::timestamptz)
        ON CONFLICT (owner_email, slug) DO UPDATE SET
          name = 'Default',
          is_archive = false,
          sort_order = LEAST(reading_folders.sort_order, -1)
        RETURNING id, name, slug, is_archive, created_at, updated_at
      `,
      [`folder-${randomUUID()}`, normalizedOwner, now],
    );

    if (!rows[0]) {
      throw new Error("Could not create the Default folder.");
    }

    return rowToArticleFolder(rows[0]);
  }
}

const articleSummaryColumns = `
  id,
  title,
  source_type,
  source_url,
  folder_id,
  archived_at,
  created_at,
  updated_at,
  word_count,
  estimated_minutes,
  sentence_count,
  processing_cost_usd,
  progress_sentence_index,
  progress_percent,
  progress_updated_at,
  excerpt,
  thumbnail_url
`;

const articleColumns = `
  id,
  owner_email,
  title,
  source_type,
  source_url,
  folder_id,
  archived_at,
  excerpt,
  thumbnail_url,
  created_at,
  updated_at,
  word_count,
  estimated_minutes,
  sentence_count,
  processing_cost_usd,
  progress_sentence_index,
  progress_percent,
  progress_updated_at,
  content_html,
  text_content,
  blocks,
  narration
`;

function getSql() {
  if (sqlClient) {
    return sqlClient;
  }

  const databaseUrl = process.env.DATABASE_URL;

  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required when ARTICLE_REPOSITORY_DRIVER=postgres.");
  }

  sqlClient = neon(databaseUrl);
  return sqlClient;
}

function articleParams(article: Article) {
  return [
    article.id,
    article.title,
    article.sourceType,
    article.sourceUrl ?? null,
    article.folderId ?? null,
    article.archivedAt ?? null,
    article.createdAt,
    article.updatedAt,
    article.wordCount,
    article.estimatedMinutes,
    article.sentenceCount,
    article.processingCostUsd ?? 0,
    article.progress.sentenceIndex,
    article.progress.percent,
    article.progress.updatedAt,
    article.contentHtml,
    article.textContent,
    JSON.stringify(article.blocks),
    article.narration ? JSON.stringify(article.narration) : null,
  ];
}

function normalizeOwnerEmail(ownerEmail: string) {
  return ownerEmail.trim().toLowerCase();
}

function cleanFolderName(name: string) {
  return name.normalize("NFKC").replace(/\s+/gu, " ").trim();
}

function normalizeFolderName(name: string) {
  return cleanFolderName(name).toLocaleLowerCase();
}

function folderSlug(name: string) {
  return (
    name
      .normalize("NFKD")
      .toLocaleLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, "-")
      .replace(/^-+|-+$/gu, "") || "folder"
  );
}

function folderStorageSlug(name: string) {
  const normalizedName = normalizeFolderName(name);
  const fingerprint = createHash("sha256")
    .update(normalizedName)
    .digest("hex")
    .slice(0, 12);

  return `${folderSlug(name)}-${fingerprint}`;
}

function rowToArticle(row: PostgresArticleRow): Article {
  const blocks = parseBlocks(row.blocks);
  const previewSource = {
    title: row.title,
    textContent: row.text_content,
    blocks,
  };

  return {
    id: row.id,
    title: row.title,
    sourceType: row.source_type,
    sourceUrl: row.source_url ?? undefined,
    excerpt: compactPreviewText(row.excerpt ?? undefined, row.title) ??
      articleExcerpt(previewSource),
    thumbnailUrl: row.thumbnail_url ?? articleThumbnailUrl(previewSource),
    folderId: row.folder_id ?? undefined,
    archivedAt: row.archived_at ? isoString(row.archived_at) : undefined,
    createdAt: isoString(row.created_at),
    updatedAt: isoString(row.updated_at),
    wordCount: numberValue(row.word_count),
    estimatedMinutes: numberValue(row.estimated_minutes),
    sentenceCount: numberValue(row.sentence_count),
    processingCostUsd: numberValue(row.processing_cost_usd ?? 0),
    progress: {
      sentenceIndex: numberValue(row.progress_sentence_index),
      percent: numberValue(row.progress_percent),
      updatedAt: isoString(row.progress_updated_at),
    },
    contentHtml: row.content_html,
    textContent: row.text_content,
    blocks,
    narration: parseNarration(row.narration),
  };
}

function rowToArticleSummary(row: PostgresArticleSummaryRow) {
  return {
    id: row.id,
    title: row.title,
    sourceType: row.source_type,
    sourceUrl: row.source_url ?? undefined,
    excerpt: compactPreviewText(row.excerpt ?? undefined, row.title),
    thumbnailUrl: row.thumbnail_url ?? undefined,
    folderId: row.folder_id ?? undefined,
    archivedAt: row.archived_at ? isoString(row.archived_at) : undefined,
    createdAt: isoString(row.created_at),
    updatedAt: isoString(row.updated_at),
    wordCount: numberValue(row.word_count),
    estimatedMinutes: numberValue(row.estimated_minutes),
    sentenceCount: numberValue(row.sentence_count),
    processingCostUsd: numberValue(row.processing_cost_usd ?? 0),
    progress: {
      sentenceIndex: numberValue(row.progress_sentence_index),
      percent: numberValue(row.progress_percent),
      updatedAt: isoString(row.progress_updated_at),
    },
  };
}

function rowToArticleFolder(row: PostgresArticleFolderRow): ArticleFolder {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    isArchive: row.is_archive,
    createdAt: isoString(row.created_at),
    updatedAt: isoString(row.updated_at),
  };
}

function rowToArticleOrganization(
  row: PostgresArticleOrganizationRow,
): ArticleOrganizationResult {
  return {
    id: row.id,
    folderId: row.folder_id,
    archivedAt: row.archived_at ? isoString(row.archived_at) : null,
    updatedAt: isoString(row.updated_at),
  };
}

function parseBlocks(blocks: ArticleBlock[] | string): ArticleBlock[] {
  if (Array.isArray(blocks)) {
    return blocks;
  }

  const parsed = JSON.parse(blocks) as unknown;
  return Array.isArray(parsed) ? (parsed as ArticleBlock[]) : [];
}

function parseNarration(
  narration: ArticleNarration | string | null,
): ArticleNarration | undefined {
  if (!narration) {
    return undefined;
  }

  return typeof narration === "string"
    ? (JSON.parse(narration) as ArticleNarration)
    : narration;
}

function isoString(value: string | Date) {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function numberValue(value: number | string) {
  return typeof value === "number" ? value : Number(value);
}

function articleListLocationCondition(
  location: ArticleListPageQuery["location"],
  folderId: string | null,
) {
  switch (location) {
    case "archive":
      return "archived_at IS NOT NULL";
    case "all":
      return "archived_at IS NULL";
    case "default":
      if (!folderId) {
        throw new Error("Default folder is unavailable.");
      }

      return "archived_at IS NULL AND folder_id = $2";
    default:
      if (!folderId) {
        throw new Error("Folder is required.");
      }

      return "archived_at IS NULL AND folder_id = $2";
  }
}

function articleListOrderBy(sort: ArticleListPageQuery["sort"]) {
  const titleAscending = `lower(title) COLLATE "C" ASC`;

  switch (sort) {
    case "saved-asc":
      return `created_at ASC, ${titleAscending}, id ASC`;
    case "read-desc":
      return `progress_updated_at DESC, created_at DESC, ${titleAscending}, id ASC`;
    case "title-asc":
      return `${titleAscending}, created_at DESC, id ASC`;
    case "duration-asc":
      return `estimated_minutes ASC, ${titleAscending}, created_at DESC, id ASC`;
    case "duration-desc":
      return `estimated_minutes DESC, ${titleAscending}, created_at DESC, id ASC`;
    case "saved-desc":
      return `created_at DESC, ${titleAscending}, id ASC`;
    default:
      sort satisfies never;
      return "id ASC";
  }
}

function clampNumber(value: number, min: number, max: number) {
  if (!Number.isFinite(value)) {
    return min;
  }

  return Math.min(Math.max(value, min), max);
}

function clampInteger(value: number, min: number, max: number) {
  return Math.round(clampNumber(value, min, max));
}
