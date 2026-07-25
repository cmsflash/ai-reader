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
import type { ArticleProgressPatch } from "@/server/ports/articleRepository";
import { toArticleSummary } from "@/server/ports/articleRepository";

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
    title?: string;
  } = {},
) {
  const extracted = await articleFromUrl(url);
  const article = await archiveArticleArtifacts(
    options.title && extracted.title === "Untitled"
      ? { ...extracted, title: options.title }
      : extracted,
  );
  const saved = await getArticleRepository().create(article, ownerEmail);

  return {
    article: saved,
    summary: toArticleSummary(saved),
  };
}

export async function importFileArticle(file: File, ownerEmail: string) {
  const article = await archiveArticleArtifacts(await articleFromFile(file));
  const saved = await getArticleRepository().create(article, ownerEmail);

  return {
    article: saved,
    summary: toArticleSummary(saved),
  };
}

export async function importHtmlArticle(
  html: string,
  ownerEmail: string,
  options: {
    title?: string;
    sourceUrl?: string;
    progress?: number;
  } = {},
) {
  let article = await archiveArticleArtifacts(
    await articleFromHtml(html, {
      title: options.title,
      sourceUrl: options.sourceUrl,
    }),
  );

  if (typeof options.progress === "number" && Number.isFinite(options.progress)) {
    const percent = Math.min(Math.max(options.progress, 0), 1);
    article = {
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
