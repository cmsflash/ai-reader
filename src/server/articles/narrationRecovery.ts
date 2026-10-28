import type { Article } from "../../lib/types.ts";

/** Metadata checks only: never downloads or regenerates paid narration. */
export async function missingNarrationKeys(article: Article, exists: (key: string) => Promise<boolean>) {
  if (!article.narration) return [];
  const keys = article.narration.segments?.length
    ? article.narration.segments.map(segment => segment.artifactKey)
    : [article.narration.artifactKey];
  const unique = [...new Set(keys)];
  const available = await Promise.all(unique.map(exists));
  return unique.filter((_, index) => !available[index]);
}
