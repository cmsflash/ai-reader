export function articleImageSourceCandidates(
  src: string | undefined,
  originalSrc: string | undefined,
  articleSourceUrl?: string,
) {
  const candidates: string[] = [];
  const primary = nonEmptySource(src);

  if (primary) {
    candidates.push(proxiedImageSrc(primary, articleSourceUrl));
  }

  const original = remoteHttpSource(originalSrc);

  if (original) {
    const fallback = proxiedImageSrc(original, articleSourceUrl);

    if (!candidates.includes(fallback)) {
      candidates.push(fallback);
    }
  }

  return candidates;
}

export function shouldLoadArticleImageEagerly(
  src: string | undefined,
  originalSrc: string | undefined,
) {
  return Boolean(
    src?.trim().startsWith("/api/artifacts/") &&
      remoteHttpSource(originalSrc),
  );
}

export function proxiedImageSrc(src: string, sourceUrl?: string) {
  try {
    const imageUrl = new URL(src);

    if (!["http:", "https:"].includes(imageUrl.protocol)) {
      return src;
    }

    const params = new URLSearchParams({ url: imageUrl.href });

    if (sourceUrl) {
      params.set("source", sourceUrl);
    }

    return `/api/image?${params.toString()}`;
  } catch {
    return src;
  }
}

function nonEmptySource(value: string | undefined) {
  const normalized = value?.trim();
  return normalized || undefined;
}

function remoteHttpSource(value: string | undefined) {
  const normalized = nonEmptySource(value);

  if (!normalized) {
    return undefined;
  }

  try {
    const url = new URL(normalized);
    return ["http:", "https:"].includes(url.protocol) ? url.href : undefined;
  } catch {
    return undefined;
  }
}
