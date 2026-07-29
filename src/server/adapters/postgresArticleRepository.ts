import { neon, type NeonQueryFunction } from "@neondatabase/serverless";
import type { Article, ArticleBlock, ReadingProgress, SourceType } from "@/lib/types";
import { articleContentFingerprint } from "@/server/articles/articleDeduplication";
import {
  type ArticleProgressPatch,
  type ArticleRepository,
} from "@/server/ports/articleRepository";

type PostgresArticleRow = {
  id: string;
  owner_email: string | null;
  title: string;
  source_type: SourceType;
  source_url: string | null;
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
};

type PostgresArticleSummaryRow = Omit<
  PostgresArticleRow,
  "owner_email" | "content_html" | "text_content" | "blocks"
>;

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
    const rows = await this.queryRows<PostgresArticleSummaryRow>(
      `
        SELECT ${articleSummaryColumns}
        FROM articles
        WHERE owner_email = $1
        ORDER BY created_at DESC
      `,
      [normalizeOwnerEmail(ownerEmail)],
    );

    return rows.map(rowToArticleSummary);
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
    const contentFingerprint = articleContentFingerprint(article);
    const saved = await this.queryArticles(
      `
        INSERT INTO articles (
          id,
          owner_email,
          title,
          source_type,
          source_url,
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
          content_fingerprint
        )
        VALUES ($1, $2, $3, $4, $5, $6::timestamptz, $7::timestamptz, $8, $9, $10, $11, $12, $13, $14::timestamptz, $15, $16, $17::jsonb, $18)
        ON CONFLICT DO NOTHING
        RETURNING ${articleColumns}
      `,
      [
        article.id,
        normalizedOwner,
        ...articleParams(article).slice(1),
        contentFingerprint ?? null,
      ],
    );

    if (saved[0]) {
      return rowToArticle(saved[0]);
    }

    const existing = await this.findById(article.id, ownerEmail);

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
}

const articleSummaryColumns = `
  id,
  title,
  source_type,
  source_url,
  created_at,
  updated_at,
  word_count,
  estimated_minutes,
  sentence_count,
  processing_cost_usd,
  progress_sentence_index,
  progress_percent,
  progress_updated_at
`;

const articleColumns = `
  id,
  owner_email,
  title,
  source_type,
  source_url,
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
  blocks
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
  ];
}

function normalizeOwnerEmail(ownerEmail: string) {
  return ownerEmail.trim().toLowerCase();
}

function rowToArticle(row: PostgresArticleRow): Article {
  return {
    id: row.id,
    title: row.title,
    sourceType: row.source_type,
    sourceUrl: row.source_url ?? undefined,
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
    blocks: parseBlocks(row.blocks),
  };
}

function rowToArticleSummary(row: PostgresArticleSummaryRow) {
  return {
    id: row.id,
    title: row.title,
    sourceType: row.source_type,
    sourceUrl: row.source_url ?? undefined,
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

function parseBlocks(blocks: ArticleBlock[] | string): ArticleBlock[] {
  if (Array.isArray(blocks)) {
    return blocks;
  }

  const parsed = JSON.parse(blocks) as unknown;
  return Array.isArray(parsed) ? (parsed as ArticleBlock[]) : [];
}

function isoString(value: string | Date) {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function numberValue(value: number | string) {
  return typeof value === "number" ? value : Number(value);
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
