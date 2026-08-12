import {
  articleExcerpt,
  articleThumbnailUrl,
} from "../../lib/articlePreview.ts";
import type {
  ArticleListLocation,
  ArticleListSortMode,
} from "@/lib/articleList";
import type {
  Article,
  ArticleFolder,
  ArticleSummary,
  ReadingProgress,
} from "@/lib/types";
import type { ArticleDeduplicationCandidate } from "@/server/articles/articleDeduplication";

export type ArticleProgressPatch = Partial<Pick<ReadingProgress, "percent" | "sentenceIndex">>;

export type ArticleOrganizationPatch = {
  archived?: boolean;
  folderId?: string;
};

export type ArticleOrganizationResult = {
  id: string;
  folderId: string | null;
  archivedAt: string | null;
  updatedAt: string;
};

export type ArticleListPageQuery = {
  location: ArticleListLocation;
  sort: ArticleListSortMode;
  limit: number;
  offset: number;
};

export type ArticleListPageResult = {
  articles: ArticleSummary[];
  total: number;
  activeTotal: number;
  nextOffset: number | null;
};

export interface ArticleRepository {
  list(ownerEmail: string): Promise<ArticleSummary[]>;
  listPage(
    ownerEmail: string,
    query: ArticleListPageQuery,
  ): Promise<ArticleListPageResult>;
  listFolders(ownerEmail: string): Promise<ArticleFolder[]>;
  createFolder(name: string, ownerEmail: string): Promise<ArticleFolder>;
  listDeduplicationCandidates(
    ownerEmail: string,
  ): Promise<ArticleDeduplicationCandidate[]>;
  findById(id: string, ownerEmail: string): Promise<Article | null>;
  create(article: Article, ownerEmail: string): Promise<Article>;
  updateProgress(
    id: string,
    ownerEmail: string,
    progress: ArticleProgressPatch,
  ): Promise<Article | null>;
  advanceProgress(
    id: string,
    ownerEmail: string,
    percent: number,
  ): Promise<Article | null>;
  addProcessingCost(id: string, ownerEmail: string, costUsd: number): Promise<Article | null>;
  updateOrganization(
    id: string,
    ownerEmail: string,
    organization: ArticleOrganizationPatch,
  ): Promise<ArticleOrganizationResult | null>;
  deleteById(id: string, ownerEmail: string): Promise<boolean>;
  deleteByIdIfUnreferenced(
    id: string,
    ownerEmail: string,
  ): Promise<boolean>;
}

export function toArticleSummary(article: Article): ArticleSummary {
  return {
    id: article.id,
    title: article.title,
    sourceType: article.sourceType,
    sourceUrl: article.sourceUrl,
    excerpt: article.excerpt ?? articleExcerpt(article),
    thumbnailUrl: article.thumbnailUrl ?? articleThumbnailUrl(article),
    folderId: article.folderId,
    archivedAt: article.archivedAt,
    createdAt: article.createdAt,
    updatedAt: article.updatedAt,
    wordCount: article.wordCount,
    estimatedMinutes: article.estimatedMinutes,
    sentenceCount: article.sentenceCount,
    processingCostUsd: article.processingCostUsd ?? 0,
    progress: article.progress,
  };
}
