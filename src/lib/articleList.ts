import type { ArticleSummary } from "@/lib/types";

export type ArticleListLocation =
  | "default"
  | "all"
  | "archive"
  | `folder:${string}`;

export type ArticleListSortMode =
  | "saved-desc"
  | "saved-asc"
  | "read-desc"
  | "title-asc"
  | "duration-asc"
  | "duration-desc";

export type ArticleListPageResponse = {
  articles: ArticleSummary[];
  total: number;
  activeTotal: number;
  nextCursor: string | null;
};

export const ARTICLE_LIST_DEFAULT_PAGE_SIZE = 30;
export const ARTICLE_LIST_MAX_PAGE_SIZE = 500;

export const articleListSortModes = [
  "saved-desc",
  "saved-asc",
  "read-desc",
  "title-asc",
  "duration-asc",
  "duration-desc",
] as const satisfies readonly ArticleListSortMode[];

export function isArticleListLocation(
  value: string,
): value is ArticleListLocation {
  if (value === "default" || value === "all" || value === "archive") {
    return true;
  }

  return (
    value.startsWith("folder:") &&
    value.length > "folder:".length &&
    value.length <= 256 &&
    value.slice("folder:".length).trim() === value.slice("folder:".length)
  );
}

export function isArticleListSortMode(
  value: string,
): value is ArticleListSortMode {
  return (articleListSortModes as readonly string[]).includes(value);
}

export function articleMatchesLocation(
  article: ArticleSummary,
  location: ArticleListLocation,
  defaultFolderId?: string,
) {
  if (location === "archive") {
    return Boolean(article.archivedAt);
  }

  if (article.archivedAt) {
    return false;
  }

  if (location === "all") {
    return true;
  }

  if (location === "default") {
    return defaultFolderId
      ? article.folderId === defaultFolderId
      : !article.folderId;
  }

  return article.folderId === location.slice("folder:".length);
}

export function filterAndSortArticles(
  articles: readonly ArticleSummary[],
  location: ArticleListLocation,
  sort: ArticleListSortMode,
  defaultFolderId?: string,
) {
  return articles
    .filter((article) =>
      articleMatchesLocation(article, location, defaultFolderId),
    )
    .sort((left, right) => compareArticles(left, right, sort));
}

function compareArticles(
  left: ArticleSummary,
  right: ArticleSummary,
  sort: ArticleListSortMode,
) {
  const titleOrder = left.title.localeCompare(right.title, undefined, {
    sensitivity: "base",
    numeric: true,
  });
  const savedOrder = dateValue(right.createdAt) - dateValue(left.createdAt);
  const idOrder = compareIds(left.id, right.id);

  switch (sort) {
    case "saved-asc":
      return -savedOrder || titleOrder || idOrder;
    case "read-desc":
      return (
        dateValue(right.progress.updatedAt) -
          dateValue(left.progress.updatedAt) ||
        savedOrder ||
        titleOrder ||
        idOrder
      );
    case "title-asc":
      return titleOrder || savedOrder || idOrder;
    case "duration-asc":
      return (
        left.estimatedMinutes - right.estimatedMinutes ||
        titleOrder ||
        savedOrder ||
        idOrder
      );
    case "duration-desc":
      return (
        right.estimatedMinutes - left.estimatedMinutes ||
        titleOrder ||
        savedOrder ||
        idOrder
      );
    case "saved-desc":
      return savedOrder || titleOrder || idOrder;
    default:
      sort satisfies never;
      return idOrder;
  }
}

function dateValue(value: string) {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function compareIds(left: string, right: string) {
  return left < right ? -1 : left > right ? 1 : 0;
}
