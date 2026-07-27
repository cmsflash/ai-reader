import { promises as fs } from "node:fs";
import path from "node:path";
import type { Article, ArticleStore, ReadingProgress } from "@/lib/types";
import {
  type ArticleProgressPatch,
  type ArticleRepository,
  toArticleSummary,
} from "../ports/articleRepository.ts";

type LocalJsonArticleRepositoryOptions = {
  storePath?: string;
};

type StoredArticle = Article & {
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
    const store = await this.readCurrentStore();
    return store.articles
      .filter((article) => articleBelongsToOwner(article, ownerEmail))
      .map(toArticleSummary);
  }

  async findById(id: string, ownerEmail: string) {
    const store = await this.readCurrentStore();
    return (
      store.articles.find(
        (article) => article.id === id && articleBelongsToOwner(article, ownerEmail),
      ) ?? null
    );
  }

  async create(article: Article, ownerEmail: string) {
    return this.mutateStore((store) => {
      const existing = store.articles.find(
        (candidate) =>
          candidate.id === article.id &&
          articleBelongsToOwner(candidate, ownerEmail),
      );

      if (existing) {
        return { value: existing };
      }

      const storedArticle: StoredArticle = {
        ...article,
        ownerEmail: normalizeOwnerEmail(ownerEmail),
      };

      return {
        store: {
          ...store,
          articles: [storedArticle, ...store.articles],
        },
        value: article,
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

function normalizeOwnerEmail(ownerEmail: string) {
  return ownerEmail.trim().toLowerCase();
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
