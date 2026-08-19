export type AppView = "library" | "add" | "reader" | "settings";

export type AppHistoryEntry = {
  view: AppView;
  articleId?: string;
  depth: number;
};

const articleQueryParameter = "article";

export function articleIdFromAppUrl(url: string) {
  try {
    const value = new URL(url, "https://ai-reader.invalid")
      .searchParams.get(articleQueryParameter)
      ?.trim();

    return value && value.length <= 512 ? value : null;
  } catch {
    return null;
  }
}

export function appUrlForHistoryEntry(
  currentUrl: string,
  entry: AppHistoryEntry,
) {
  const url = new URL(currentUrl, "https://ai-reader.invalid");

  if (entry.view === "reader" && entry.articleId) {
    url.searchParams.set(articleQueryParameter, entry.articleId);
  } else {
    url.searchParams.delete(articleQueryParameter);
  }

  return `${url.pathname}${url.search}${url.hash}`;
}

export function appHistoryEntry(state: unknown): AppHistoryEntry | null {
  if (!state || typeof state !== "object") {
    return null;
  }

  const entry = (state as { aiReader?: unknown }).aiReader;

  if (!entry || typeof entry !== "object") {
    return null;
  }

  const candidate = entry as Partial<AppHistoryEntry>;

  if (
    !["library", "add", "reader", "settings"].includes(candidate.view ?? "") ||
    !Number.isSafeInteger(candidate.depth) ||
    (candidate.depth ?? -1) < 0
  ) {
    return null;
  }

  if (
    candidate.view === "reader" &&
    (typeof candidate.articleId !== "string" ||
      !candidate.articleId ||
      candidate.articleId.length > 512)
  ) {
    return null;
  }

  return candidate as AppHistoryEntry;
}
