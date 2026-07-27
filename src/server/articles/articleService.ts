import {
  articleFromFile,
  articleFromHtml,
  articleFromUrl,
} from "@/lib/extractors";
import {
  archiveArticleArtifacts,
  deleteArticleArtifacts,
} from "@/server/artifacts/archiveArticleArtifacts";
import { getArticleRepository } from "@/server/runtime/articleRepository";
import { dismissLocalImportsForArticle } from "@/server/integrations/importRecords";
import type { ArticleProgressPatch } from "@/server/ports/articleRepository";
import { toArticleSummary } from "@/server/ports/articleRepository";
import type { Article } from "@/lib/types";

export async function listArticleSummaries(ownerEmail: string) {
  return getArticleRepository().list(ownerEmail);
}

export async function getSavedArticle(id: string, ownerEmail: string) {
  return getArticleRepository().findById(id, ownerEmail);
}

export async function importUrlArticle(
  url: string,
  ownerEmail: string,
  options: {
    id?: string;
    title?: string;
    progress?: number;
  } = {},
) {
  const extracted = await articleFromUrl(url);
  const titled =
    options.title && extracted.title === "Untitled"
      ? { ...extracted, title: options.title }
      : extracted;
  const article = await archiveArticleArtifacts(
    withImportedProgress(withImportedId(titled, options.id), options.progress),
  );
  const saved = await saveImportedArticle(article, ownerEmail);

  return {
    article: saved,
    summary: toArticleSummary(saved),
  };
}

export async function importFileArticle(
  file: File,
  ownerEmail: string,
  options: {
    id?: string;
  } = {},
) {
  const article = await archiveArticleArtifacts(
    withImportedId(await articleFromFile(file), options.id),
  );
  const saved = await saveImportedArticle(article, ownerEmail);

  return {
    article: saved,
    summary: toArticleSummary(saved),
  };
}

export async function importHtmlArticle(
  html: string,
  ownerEmail: string,
  options: {
    id?: string;
    title?: string;
    sourceUrl?: string;
    progress?: number;
  } = {},
) {
  let article = await archiveArticleArtifacts(
    withImportedId(
      await articleFromHtml(html, {
        title: options.title,
        sourceUrl: options.sourceUrl,
      }),
      options.id,
    ),
  );

  article = withImportedProgress(article, options.progress);

  const saved = await saveImportedArticle(article, ownerEmail);

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
  dismissLocalImportsForArticle(ownerEmail, id);
  const deleted = await getArticleRepository().deleteById(id, ownerEmail);

  if (deleted && article) {
    await deleteArticleArtifacts(article);
  }

  return deleted;
}

async function saveImportedArticle(article: Article, ownerEmail: string) {
  const repository = getArticleRepository();

  try {
    return await repository.create(article, ownerEmail);
  } catch (error) {
    try {
      const existing = await repository.findById(article.id, ownerEmail);

      if (existing) {
        return existing;
      }
    } catch {
      // Keep archived artifacts when persistence may have committed without acknowledgement.
      throw error;
    }

    await deleteArticleArtifacts(article).catch(() => undefined);
    throw error;
  }
}

function withImportedProgress(article: Article, progress?: number): Article {
  if (typeof progress !== "number" || !Number.isFinite(progress)) {
    return article;
  }

  const percent = Math.min(Math.max(progress, 0), 1);
  return {
    ...article,
    progress: {
      sentenceIndex: Math.round(
        percent * Math.max(article.sentenceCount - 1, 0),
      ),
      percent,
      updatedAt: new Date().toISOString(),
    },
  };
}

function withImportedId(article: Article, id?: string): Article {
  const normalizedId = id?.trim();
  return normalizedId ? { ...article, id: normalizedId } : article;
}
