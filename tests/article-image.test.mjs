import assert from "node:assert/strict";
import test from "node:test";
import {
  articleImageSourceCandidates,
  proxiedImageSrc,
  shouldLoadArticleImageEagerly,
} from "../src/lib/articleImage.ts";

test("falls back from a legacy artifact to a proxied original image", () => {
  const sourceUrl = "https://mp.weixin.qq.com/s/example?token=one";
  const originalSrc = "https://mmbiz.qpic.cn/example/640?wx_fmt=jpeg";
  const candidates = articleImageSourceCandidates(
    "/api/artifacts/articles/example/images/0.jpg",
    originalSrc,
    sourceUrl,
  );

  assert.equal(candidates[0], "/api/artifacts/articles/example/images/0.jpg");
  assert.equal(candidates[1], proxiedImageSrc(originalSrc, sourceUrl));
});

test("does not retry the same image source", () => {
  const sourceUrl = "https://example.com/article";
  const imageUrl = "https://cdn.example.com/image.jpg";

  assert.deepEqual(
    articleImageSourceCandidates(imageUrl, imageUrl, sourceUrl),
    [proxiedImageSrc(imageUrl, sourceUrl)],
  );
});

test("ignores original image fallbacks that are not remote HTTP resources", () => {
  const primary = "/api/artifacts/articles/example/images/0.jpg";

  for (const originalSrc of [
    "",
    "/another/local/image.jpg",
    "data:image/png;base64,AA==",
    "file:///tmp/image.jpg",
    "not a URL",
  ]) {
    assert.deepEqual(
      articleImageSourceCandidates(primary, originalSrc),
      [primary],
    );
  }
});

test("uses a valid original image when the primary source is absent", () => {
  const originalSrc = "https://cdn.example.com/image.png";

  assert.deepEqual(
    articleImageSourceCandidates(undefined, originalSrc),
    [proxiedImageSrc(originalSrc)],
  );
});

test("loads only obsolete artifact images eagerly for fallback recovery", () => {
  const originalSrc = "https://mmbiz.qpic.cn/example/640?wx_fmt=jpeg";

  assert.equal(
    shouldLoadArticleImageEagerly(
      "/api/artifacts/articles/example/images/0.jpg",
      originalSrc,
    ),
    true,
  );
  assert.equal(
    shouldLoadArticleImageEagerly(
      "https://example.public.blob.vercel-storage.com/image.jpg",
      originalSrc,
    ),
    false,
  );
  assert.equal(
    shouldLoadArticleImageEagerly(
      "/api/artifacts/articles/example/images/0.jpg",
      undefined,
    ),
    false,
  );
});
