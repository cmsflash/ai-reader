import { articleFromFile, articleFromUrl } from "@/lib/extractors";
import {
  archiveArticleArtifacts,
  deleteArticleArtifacts,
} from "@/server/artifacts/archiveArticleArtifacts";
import { getArticleRepository } from "@/server/runtime/articleRepository";
import type { ArticleProgressPatch } from "@/server/ports/articleRepository";
import { toArticleSummary } from "@/server/ports/articleRepository";

export async function listArticleSummaries() {
  return getArticleRepository().list();
}

export async function getSavedArticle(id: string) {
  return getArticleRepository().findById(id);
}

export async function importUrlArticle(url: string) {
  const article = await archiveArticleArtifacts(await articleFromUrl(url));
  const saved = await getArticleRepository().create(article);

  return {
    article: saved,
    summary: toArticleSummary(saved),
  };
}

export async function importFileArticle(file: File) {
  const article = await articleFromFile(file);
  const saved = await getArticleRepository().create(article);

  return {
    article: saved,
    summary: toArticleSummary(saved),
  };
}

export async function updateSavedArticleProgress(id: string, progress: ArticleProgressPatch) {
  const article = await getArticleRepository().updateProgress(id, progress);

  if (!article) {
    return null;
  }

  return {
    article,
    summary: toArticleSummary(article),
  };
}

export async function deleteSavedArticle(id: string) {
  const article = await getArticleRepository().findById(id);
  const deleted = await getArticleRepository().deleteById(id);

  if (deleted && article) {
    await deleteArticleArtifacts(article);
  }

  return deleted;
}
