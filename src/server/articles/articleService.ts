import { articleFromFile, articleFromUrl } from "@/lib/extractors";
import {
  archiveArticleArtifacts,
  deleteArticleArtifacts,
} from "@/server/artifacts/archiveArticleArtifacts";
import { getArticleRepository } from "@/server/runtime/articleRepository";
import type { ArticleProgressPatch } from "@/server/ports/articleRepository";
import { toArticleSummary } from "@/server/ports/articleRepository";

export async function listArticleSummaries(ownerEmail: string) {
  return getArticleRepository().list(ownerEmail);
}

export async function getSavedArticle(id: string, ownerEmail: string) {
  return getArticleRepository().findById(id, ownerEmail);
}

export async function importUrlArticle(url: string, ownerEmail: string) {
  const article = await archiveArticleArtifacts(await articleFromUrl(url));
  const saved = await getArticleRepository().create(article, ownerEmail);

  return {
    article: saved,
    summary: toArticleSummary(saved),
  };
}

export async function importFileArticle(file: File, ownerEmail: string) {
  const article = await articleFromFile(file);
  const saved = await getArticleRepository().create(article, ownerEmail);

  return {
    article: saved,
    summary: toArticleSummary(saved),
  };
}

export async function updateSavedArticleProgress(
  id: string,
  ownerEmail: string,
  progress: ArticleProgressPatch,
) {
  const article = await getArticleRepository().updateProgress(id, ownerEmail, progress);

  if (!article) {
    return null;
  }

  return {
    article,
    summary: toArticleSummary(article),
  };
}

export async function deleteSavedArticle(id: string, ownerEmail: string) {
  const article = await getArticleRepository().findById(id, ownerEmail);
  const deleted = await getArticleRepository().deleteById(id, ownerEmail);

  if (deleted && article) {
    await deleteArticleArtifacts(article);
  }

  return deleted;
}
