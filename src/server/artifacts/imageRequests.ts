export const imageRequestHeaders = {
  accept: "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
  "accept-language": "zh-CN,zh;q=0.9,en-US;q=0.8,en;q=0.7",
  "user-agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
};

export function imageFetchHeaders(imageUrl: URL, sourceUrl: URL | null) {
  const headers = new Headers(imageRequestHeaders);
  const referer = refererForImage(imageUrl, sourceUrl);

  if (referer) {
    headers.set("referer", referer);
  }

  return headers;
}

export function normalizedImageContentType(contentType: string, imageUrl: URL) {
  const normalized = contentType.split(";", 1)[0]?.trim().toLowerCase();

  if (normalized?.startsWith("image/")) {
    return normalized;
  }

  if (
    normalized !== "application/octet-stream" &&
    normalized !== "binary/octet-stream"
  ) {
    return null;
  }

  const extension = imageUrl.pathname.split(".").at(-1)?.toLowerCase();

  switch (extension) {
    case "avif":
      return "image/avif";
    case "gif":
      return "image/gif";
    case "jpeg":
    case "jpg":
      return "image/jpeg";
    case "png":
      return "image/png";
    case "webp":
      return "image/webp";
    default:
      return null;
  }
}

function refererForImage(imageUrl: URL, sourceUrl: URL | null) {
  if (!sourceUrl) {
    return undefined;
  }

  const imageHost = imageUrl.hostname.toLowerCase();
  const sourceHost = sourceUrl.hostname.toLowerCase();

  if (isWeChatImageHost(imageHost) && sourceHost === "mp.weixin.qq.com") {
    return sourceUrl.href;
  }

  return undefined;
}

function isWeChatImageHost(hostname: string) {
  return hostname === "mmbiz.qpic.cn" || hostname.endsWith(".mmbiz.qpic.cn");
}
