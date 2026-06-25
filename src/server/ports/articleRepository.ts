import type { Article, ArticleSummary, ReadingProgress } from "@/lib/types";

export type ArticleProgressPatch = Partial<Pick<ReadingProgress, "percent" | "sentenceIndex">>;

export interface ArticleRepository {
  list(ownerEmail: string): Promise<ArticleSummary[]>;
  findById(id: string, ownerEmail: string): Promise<Article | null>;
  create(article: Article, ownerEmail: string): Promise<Article>;
  updateProgress(
    id: string,
    ownerEmail: string,
    progress: ArticleProgressPatch,
  ): Promise<Article | null>;
  addProcessingCost(id: string, ownerEmail: string, costUsd: number): Promise<Article | null>;
  deleteById(id: string, ownerEmail: string): Promise<boolean>;
}

export function toArticleSummary(article: Article): ArticleSummary {
  return {
    id: article.id,
    title: article.title,
    sourceType: article.sourceType,
    sourceUrl: article.sourceUrl,
    createdAt: article.createdAt,
    updatedAt: article.updatedAt,
    wordCount: article.wordCount,
    estimatedMinutes: article.estimatedMinutes,
    sentenceCount: article.sentenceCount,
    processingCostUsd: article.processingCostUsd ?? 0,
    progress: article.progress,
  };
}
