import type {
  ArticleListLocation,
  ArticleListSortMode,
} from "@/lib/articleList";

export type ArticleListCursorQuery = {
  location: ArticleListLocation;
  sort: ArticleListSortMode;
  limit: number;
};

const articleListCursorVersion = 1;
const maxCursorLength = 1_024;
const maxCursorOffset = 10_000_000;

type ArticleListCursorPayload = ArticleListCursorQuery & {
  v: typeof articleListCursorVersion;
  offset: number;
};

export class ArticleListCursorError extends Error {
  constructor() {
    super("Invalid or mismatched article list cursor.");
    this.name = "ArticleListCursorError";
  }
}

export function encodeArticleListCursor(
  query: ArticleListCursorQuery,
  offset: number,
) {
  if (!isValidOffset(offset)) {
    throw new Error("Invalid article list cursor offset.");
  }

  const payload: ArticleListCursorPayload = {
    v: articleListCursorVersion,
    location: query.location,
    sort: query.sort,
    limit: query.limit,
    offset,
  };

  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

export function decodeArticleListCursor(
  cursor: string,
  query: ArticleListCursorQuery,
) {
  try {
    if (
      !cursor ||
      cursor.length > maxCursorLength ||
      !/^[A-Za-z0-9_-]+$/u.test(cursor)
    ) {
      throw new Error("Malformed cursor.");
    }

    const decoded = Buffer.from(cursor, "base64url");

    if (decoded.toString("base64url") !== cursor) {
      throw new Error("Non-canonical cursor.");
    }

    const payload = JSON.parse(decoded.toString("utf8")) as Partial<
      ArticleListCursorPayload
    >;

    if (
      payload.v !== articleListCursorVersion ||
      payload.location !== query.location ||
      payload.sort !== query.sort ||
      payload.limit !== query.limit ||
      !isValidOffset(payload.offset)
    ) {
      throw new Error("Cursor does not match the article list query.");
    }

    return payload.offset;
  } catch {
    throw new ArticleListCursorError();
  }
}

function isValidOffset(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value > 0 &&
    value <= maxCursorOffset
  );
}
