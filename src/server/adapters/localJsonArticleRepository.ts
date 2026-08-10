import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import type {
  Article,
  ArticleFolder,
  ArticleStore,
  ReadingProgress,
} from "@/lib/types";
import {
  type ArticleOrganizationPatch,
  type ArticleOrganizationResult,
  type ArticleProgressPatch,
  type ArticleRepository,
  toArticleSummary,
} from "../ports/articleRepository.ts";
import { articleContentFingerprint } from "../articles/articleDeduplication.ts";

type LocalJsonArticleRepositoryOptions = {
  storePath?: string;
};

type StoredArticle = Article & {
  ownerEmail?: string;
};

type StoredFolder = ArticleFolder & {
  ownerEmail?: string;
};

type StoreMutation<T> = {
  store?: ArticleStore;
  value: T;
};

export class LocalJsonArticleRepository implements ArticleRepository {
  private readonly storePath: string;
  private mutationQueue = Promise.resolve();

  constructor(options: LocalJsonArticleRepositoryOptions = {}) {
    this.storePath = resolveStorePath(options.storePath);
  }

  async list(ownerEmail: string) {
    return (await this.listArticles(ownerEmail)).map(toArticleSummary);
  }

  async listFolders(ownerEmail: string) {
    await this.ensureDefaultFolder(ownerEmail);
    const store = await this.readCurrentStore();
    return ((store.folders ?? []) as StoredFolder[])
      .filter((folder) => folderBelongsToOwner(folder, ownerEmail))
      .map(({ id, name, slug, isArchive, createdAt, updatedAt }) => ({
        id,
        name,
        slug,
        isArchive: Boolean(isArchive),
        createdAt,
        updatedAt,
      }))
      .sort((left, right) =>
        left.name.localeCompare(right.name, undefined, {
          sensitivity: "base",
          numeric: true,
        }),
      );
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

    return this.mutateStore((store) => {
      const folders = (store.folders ?? []) as StoredFolder[];
      const existing = folders.find(
        (folder) =>
          folderBelongsToOwner(folder, ownerEmail) &&
          normalizeFolderName(folder.name) === normalizedName,
      );

      if (existing) {
        return {
          value: {
            id: existing.id,
            name: existing.name,
            slug: existing.slug,
            isArchive: Boolean(existing.isArchive),
            createdAt: existing.createdAt,
            updatedAt: existing.updatedAt,
          },
        };
      }

      const now = new Date().toISOString();
      const folder: StoredFolder = {
        id: `folder-${randomUUID()}`,
        name: folderName,
        slug: folderSlug(folderName),
        isArchive: false,
        createdAt: now,
        updatedAt: now,
        ownerEmail: normalizeOwnerEmail(ownerEmail),
      };

      return {
        store: {
          ...store,
          folders: [...folders, folder],
        },
        value: {
          id: folder.id,
          name: folder.name,
          slug: folder.slug,
          isArchive: folder.isArchive,
          createdAt: folder.createdAt,
          updatedAt: folder.updatedAt,
        },
      };
    });
  }

  async listArticles(ownerEmail: string) {
    await this.ensureDefaultFolder(ownerEmail);
    const store = await this.readCurrentStore();
    return store.articles
      .filter((article) => articleBelongsToOwner(article, ownerEmail));
  }

  async listDeduplicationCandidates(ownerEmail: string) {
    return (await this.listArticles(ownerEmail)).map((article) => ({
      id: article.id,
      title: article.title,
      sourceUrl: article.sourceUrl,
      textContent: article.textContent,
    }));
  }

  async findById(id: string, ownerEmail: string) {
    const articles = await this.listArticles(ownerEmail);
    return (
      articles.find((article) => article.id === id) ?? null
    );
  }

  async create(article: Article, ownerEmail: string) {
    return this.mutateStore((store) => {
      const prepared = prepareStoreForOwner(store, ownerEmail);
      const existing = prepared.store.articles.find(
        (candidate) =>
          candidate.id === article.id &&
          articleBelongsToOwner(candidate, ownerEmail),
      );

      if (existing) {
        return {
          store: prepared.changed ? prepared.store : undefined,
          value: existing,
        };
      }

      const contentFingerprint = articleContentFingerprint(article);
      const duplicate = contentFingerprint
        ? prepared.store.articles.find(
            (candidate) =>
              articleBelongsToOwner(candidate, ownerEmail) &&
              articleContentFingerprint(candidate) === contentFingerprint,
          )
        : undefined;

      if (duplicate) {
        return {
          store: prepared.changed ? prepared.store : undefined,
          value: duplicate,
        };
      }

      const storedArticle: StoredArticle = {
        ...article,
        folderId: article.folderId ?? prepared.defaultFolder.id,
        ownerEmail: normalizeOwnerEmail(ownerEmail),
      };

      return {
        store: {
          ...prepared.store,
          articles: [storedArticle, ...prepared.store.articles],
        },
        value: storedArticle,
      };
    });
  }

  async updateProgress(id: string, ownerEmail: string, progress: ArticleProgressPatch) {
    return this.mutateStore((store) => {
      const articleIndex = store.articles.findIndex(
        (article) =>
          article.id === id && articleBelongsToOwner(article, ownerEmail),
      );

      if (articleIndex === -1) {
        return { value: null };
      }

      const now = new Date().toISOString();
      const article = store.articles[articleIndex];
      const nextProgress: ReadingProgress = {
        sentenceIndex: clampInteger(
          progress.sentenceIndex ?? article.progress.sentenceIndex,
          0,
          Math.max(article.sentenceCount - 1, 0),
        ),
        percent: clampNumber(progress.percent ?? article.progress.percent, 0, 1),
        updatedAt: now,
      };
      const updatedArticle: Article = {
        ...article,
        updatedAt: now,
        progress: nextProgress,
      };
      const nextArticles = [...store.articles];
      nextArticles[articleIndex] = updatedArticle;

      return {
        store: {
          ...store,
          articles: nextArticles,
        },
        value: updatedArticle,
      };
    });
  }

  async advanceProgress(id: string, ownerEmail: string, percent: number) {
    return this.mutateStore((store) => {
      const articleIndex = store.articles.findIndex(
        (article) =>
          article.id === id && articleBelongsToOwner(article, ownerEmail),
      );

      if (articleIndex === -1) {
        return { value: null };
      }

      const article = store.articles[articleIndex];
      const nextPercent = clampNumber(percent, 0, 1);

      if (nextPercent <= article.progress.percent) {
        return { value: article };
      }

      const now = new Date().toISOString();
      const updatedArticle: Article = {
        ...article,
        updatedAt: now,
        progress: {
          sentenceIndex: Math.round(
            nextPercent * Math.max(article.sentenceCount - 1, 0),
          ),
          percent: nextPercent,
          updatedAt: now,
        },
      };
      const nextArticles = [...store.articles];
      nextArticles[articleIndex] = updatedArticle;

      return {
        store: {
          ...store,
          articles: nextArticles,
        },
        value: updatedArticle,
      };
    });
  }

  async addProcessingCost(id: string, ownerEmail: string, costUsd: number) {
    return this.mutateStore((store) => {
      const articleIndex = store.articles.findIndex(
        (article) =>
          article.id === id && articleBelongsToOwner(article, ownerEmail),
      );

      if (articleIndex === -1) {
        return { value: null };
      }

      const safeCost = clampNumber(costUsd, 0, Number.MAX_SAFE_INTEGER);

      if (safeCost === 0) {
        return { value: store.articles[articleIndex] };
      }

      const now = new Date().toISOString();
      const article = store.articles[articleIndex];
      const updatedArticle: Article = {
        ...article,
        updatedAt: now,
        processingCostUsd: roundCost(
          (article.processingCostUsd ?? 0) + safeCost,
        ),
      };
      const nextArticles = [...store.articles];
      nextArticles[articleIndex] = updatedArticle;

      return {
        store: {
          ...store,
          articles: nextArticles,
        },
        value: updatedArticle,
      };
    });
  }

  async updateOrganization(
    id: string,
    ownerEmail: string,
    organization: ArticleOrganizationPatch,
  ) {
    return this.mutateStore((store) => {
      const prepared = prepareStoreForOwner(store, ownerEmail);
      const articleIndex = prepared.store.articles.findIndex(
        (article) =>
          article.id === id && articleBelongsToOwner(article, ownerEmail),
      );

      if (articleIndex === -1) {
        return {
          store: prepared.changed ? prepared.store : undefined,
          value: null,
        };
      }

      const hasFolderId = Object.hasOwn(organization, "folderId");
      const folderId = organization.folderId ?? null;

      if (hasFolderId && !folderId) {
        throw new Error("Folder is required.");
      }

      if (
        hasFolderId &&
        folderId &&
        !((prepared.store.folders ?? []) as StoredFolder[]).some(
          (folder) =>
            folder.id === folderId &&
            folderBelongsToOwner(folder, ownerEmail),
        )
      ) {
        throw new Error("Folder not found.");
      }

      const article = prepared.store.articles[articleIndex];
      const now = new Date().toISOString();
      const ownerFolders = ((prepared.store.folders ?? []) as StoredFolder[]).filter(
        (folder) => folderBelongsToOwner(folder, ownerEmail),
      );
      const currentFolder = ownerFolders.find(
        (folder) => folder.id === article.folderId,
      );
      const defaultFolder =
        ownerFolders.find(
          (folder) => !folder.isArchive && folder.slug === "default",
        ) ?? ownerFolders.find((folder) => !folder.isArchive);
      const restoredFolderId =
        organization.archived === false && currentFolder?.isArchive
          ? defaultFolder?.id
          : article.folderId;
      const updatedArticle: Article = {
        ...article,
        updatedAt: now,
        folderId: hasFolderId ? folderId ?? undefined : restoredFolderId,
        archivedAt:
          typeof organization.archived === "boolean"
            ? organization.archived
              ? article.archivedAt ?? now
              : undefined
            : article.archivedAt,
      };
      const nextArticles = [...prepared.store.articles];
      nextArticles[articleIndex] = updatedArticle;

      return {
        store: {
          ...prepared.store,
          articles: nextArticles,
        },
        value: organizationResult(updatedArticle),
      };
    });
  }

  async deleteById(id: string, ownerEmail: string) {
    return this.mutateStore((store) => {
      const nextArticles = store.articles.filter(
        (article) =>
          article.id !== id || !articleBelongsToOwner(article, ownerEmail),
      );

      if (nextArticles.length === store.articles.length) {
        return { value: false };
      }

      return {
        store: {
          ...store,
          articles: nextArticles,
        },
        value: true,
      };
    });
  }

  async deleteByIdIfUnreferenced(id: string, ownerEmail: string) {
    return this.deleteById(id, ownerEmail);
  }

  private async readCurrentStore() {
    await this.mutationQueue;
    return this.readStore();
  }

  private async readStore(): Promise<ArticleStore> {
    try {
      const raw = await fs.readFile(this.storePath, "utf8");
      const parsed = JSON.parse(raw) as ArticleStore;

      if (parsed.version !== 1 || !Array.isArray(parsed.articles)) {
        return emptyStore();
      }

      return parsed;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return emptyStore();
      }

      throw error;
    }
  }

  private mutateStore<T>(
    mutation: (store: ArticleStore) => StoreMutation<T>,
  ): Promise<T> {
    const operation = this.mutationQueue.then(async () => {
      const result = mutation(await this.readStore());

      if (result.store) {
        await this.writeStore(result.store);
      }

      return result.value;
    });
    this.mutationQueue = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  private ensureDefaultFolder(ownerEmail: string) {
    return this.mutateStore((store) => {
      const prepared = prepareStoreForOwner(store, ownerEmail);
      return {
        store: prepared.changed ? prepared.store : undefined,
        value: publicFolder(prepared.defaultFolder),
      };
    });
  }

  private async writeStore(store: ArticleStore) {
    await fs.mkdir(path.dirname(this.storePath), { recursive: true });
    const tempPath = `${this.storePath}.${process.pid}.tmp`;
    await fs.writeFile(tempPath, `${JSON.stringify(store, null, 2)}\n`, "utf8");
    await fs.rename(tempPath, this.storePath);
  }
}

function articleBelongsToOwner(article: Article, ownerEmail: string) {
  return (article as StoredArticle).ownerEmail === normalizeOwnerEmail(ownerEmail);
}

function folderBelongsToOwner(folder: StoredFolder, ownerEmail: string) {
  return folder.ownerEmail === normalizeOwnerEmail(ownerEmail);
}

function prepareStoreForOwner(store: ArticleStore, ownerEmail: string) {
  const normalizedOwner = normalizeOwnerEmail(ownerEmail);
  const folders = (store.folders ?? []) as StoredFolder[];
  let defaultFolder = folders.find(
    (folder) =>
      folderBelongsToOwner(folder, normalizedOwner) &&
      !folder.isArchive &&
      (folder.slug === "default" ||
        normalizeFolderName(folder.name) === "default"),
  );
  let changed = false;
  let nextFolders = folders;

  if (!defaultFolder) {
    const now = new Date().toISOString();
    defaultFolder = {
      id: `folder-${randomUUID()}`,
      name: "Default",
      slug: "default",
      isArchive: false,
      createdAt: now,
      updatedAt: now,
      ownerEmail: normalizedOwner,
    };
    nextFolders = [defaultFolder, ...folders];
    changed = true;
  }

  const nextArticles = store.articles.map((article) => {
    if (!articleBelongsToOwner(article, normalizedOwner) || article.folderId) {
      return article;
    }

    changed = true;
    return {
      ...article,
      folderId: defaultFolder.id,
    };
  });

  return {
    changed,
    defaultFolder,
    store: changed
      ? {
          ...store,
          articles: nextArticles,
          folders: nextFolders,
        }
      : store,
  };
}

function publicFolder(folder: StoredFolder): ArticleFolder {
  return {
    id: folder.id,
    name: folder.name,
    slug: folder.slug,
    isArchive: Boolean(folder.isArchive),
    createdAt: folder.createdAt,
    updatedAt: folder.updatedAt,
  };
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

function organizationResult(article: Article): ArticleOrganizationResult {
  return {
    id: article.id,
    folderId: article.folderId ?? null,
    archivedAt: article.archivedAt ?? null,
    updatedAt: article.updatedAt,
  };
}

function emptyStore(): ArticleStore {
  return {
    version: 1,
    articles: [],
  };
}

function resolveStorePath(configuredPath?: string) {
  const storePath = configuredPath ?? process.env.LOCAL_ARTICLE_STORE_PATH;

  if (!storePath) {
    return path.join(process.cwd(), "data", "articles.json");
  }

  return path.isAbsolute(storePath)
    ? storePath
    : path.join(/*turbopackIgnore: true*/ process.cwd(), storePath);
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

function roundCost(value: number) {
  return Math.round(value * 1_000_000) / 1_000_000;
}
