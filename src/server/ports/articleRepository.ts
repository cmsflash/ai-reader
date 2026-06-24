import type { Article, ArticleSummary, ReadingProgress } from "@/lib/types";

export type ArticleProgressPatch = Partial<Pick<ReadingProgress, "percent" | "sentenceIndex">>;

export interface ArticleRepository {
  list(): Promise<ArticleSummary[]>;
  findById(id: string): Promise<Article | null>;
  create(article: Article): Promise<Article>;
  updateProgress(id: string, progress: ArticleProgressPatch): Promise<Article | null>;
  addProcessingCost(id: string, costUsd: number): Promise<Article | null>;
  deleteById(id: string): Promise<boolean>;
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
