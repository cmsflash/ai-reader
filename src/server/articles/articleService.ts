import {
  articleFromFile,
  articleFromHtml,
  articleFromUrl,
} from "@/lib/extractors";
import {
  archiveArticleArtifacts,
  deleteArticleArtifacts,
} from "@/server/artifacts/archiveArticleArtifacts";
import type {
  ArticleDeduplicationIndex,
  ArticleDeduplicationReason,
} from "@/server/articles/articleDeduplication";
import { getArticleRepository } from "@/server/runtime/articleRepository";
import { dismissLocalImportsForArticle } from "@/server/integrations/importRecords";
import type {
  ArticleOrganizationPatch,
  ArticleProgressPatch,
} from "@/server/ports/articleRepository";
import { toArticleSummary } from "@/server/ports/articleRepository";
import type { Article } from "@/lib/types";

type ImportedArticleOptions = {
  deduplication?: ArticleDeduplicationIndex;
  excludeArticleId?: string;
};

export async function listArticleSummaries(ownerEmail: string) {
  return getArticleRepository().list(ownerEmail);
}

export async function listArticleFolders(ownerEmail: string) {
  return getArticleRepository().listFolders(ownerEmail);
}

export async function createArticleFolder(name: string, ownerEmail: string) {
  const folderName = name.normalize("NFKC").replace(/\s+/gu, " ").trim();

  if (!folderName) {
    throw new Error("Folder name is required.");
  }

  if (folderName.length > 80) {
    throw new Error("Folder names must be 80 characters or fewer.");
  }

  return getArticleRepository().createFolder(folderName, ownerEmail);
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
  } & ImportedArticleOptions = {},
) {
  const extracted = await articleFromUrl(url);
  const titled =
    options.title && extracted.title === "Untitled"
      ? { ...extracted, title: options.title }
      : extracted;
  const article = withImportedProgress(
    withImportedId(titled, options.id),
    options.progress,
  );
  return persistImportedArticle(article, ownerEmail, options);
}

export async function importFileArticle(
  file: File,
  ownerEmail: string,
  options: {
    id?: string;
  } & ImportedArticleOptions = {},
) {
  const article = withImportedId(
    await articleFromFile(file),
    options.id,
  );
  return persistImportedArticle(article, ownerEmail, options);
}

export async function importHtmlArticle(
  html: string,
  ownerEmail: string,
  options: {
    id?: string;
    title?: string;
    sourceUrl?: string;
    progress?: number;
  } & ImportedArticleOptions = {},
) {
  let article = withImportedId(
    await articleFromHtml(html, {
      title: options.title,
      sourceUrl: options.sourceUrl,
    }),
    options.id,
  );

  article = withImportedProgress(article, options.progress);
  return persistImportedArticle(article, ownerEmail, options);
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

export async function updateSavedArticleOrganization(
  id: string,
  ownerEmail: string,
  organization: ArticleOrganizationPatch,
) {
  return getArticleRepository().updateOrganization(
    id,
    ownerEmail,
    organization,
  );
}

export async function advanceSavedArticleProgress(
  id: string,
  ownerEmail: string,
  percent: number,
) {
  const article = await getArticleRepository().advanceProgress(
    id,
    ownerEmail,
    percent,
  );

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

export async function deleteSavedArticleIfUnreferenced(
  id: string,
  ownerEmail: string,
) {
  const repository = getArticleRepository();
  const article = await repository.findById(id, ownerEmail);

  if (!article) {
    return true;
  }

  const deleted = await repository.deleteByIdIfUnreferenced(id, ownerEmail);

  if (deleted) {
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

async function persistImportedArticle(
  article: Article,
  ownerEmail: string,
  options: ImportedArticleOptions,
): Promise<{
  article: Article;
  summary: ReturnType<typeof toArticleSummary>;
  created: boolean;
  deduplicated: boolean;
  deduplicationReason?: ArticleDeduplicationReason;
  deduplicationSimilarity?: number;
  importSourceUrl?: string;
}> {
  const duplicate = options.deduplication?.find(article, {
    excludeArticleId: options.excludeArticleId,
  });

  if (duplicate) {
    const storedDuplicate = await getArticleRepository().findById(
      duplicate.article.id,
      ownerEmail,
    );

    if (storedDuplicate) {
      const canonical = await preserveHigherImportedProgress(
        storedDuplicate,
        article,
        ownerEmail,
      );
      options.deduplication?.add(canonical);

      return {
        article: canonical,
        summary: toArticleSummary(canonical),
        created: false,
        deduplicated: true,
        deduplicationReason: duplicate.reason,
        deduplicationSimilarity: duplicate.similarity,
        importSourceUrl: article.sourceUrl,
      };
    }
  }

  const archived = await archiveArticleArtifacts(article);
  const saved = await saveImportedArticle(archived, ownerEmail);
  options.deduplication?.add(saved);

  if (saved.id !== archived.id) {
    await deleteArticleArtifacts(archived).catch(() => undefined);
    const canonical = await preserveHigherImportedProgress(
      saved,
      article,
      ownerEmail,
    );
    options.deduplication?.add(canonical);

    return {
      article: canonical,
      summary: toArticleSummary(canonical),
      created: false,
      deduplicated: true,
      deduplicationReason: "exact-content",
      deduplicationSimilarity: 1,
      importSourceUrl: article.sourceUrl,
    };
  }

  return {
    article: saved,
    summary: toArticleSummary(saved),
    created: true,
    deduplicated: false,
    importSourceUrl: article.sourceUrl,
  };
}

async function preserveHigherImportedProgress(
  canonical: Article,
  incoming: Article,
  ownerEmail: string,
) {
  if (incoming.progress.percent <= canonical.progress.percent) {
    return canonical;
  }

  return (
    (await getArticleRepository().advanceProgress(
      canonical.id,
      ownerEmail,
      incoming.progress.percent,
    )) ?? canonical
  );
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
