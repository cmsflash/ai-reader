import {
  BlobNotFoundError,
  del,
  get,
  head,
  put,
  type BlobAccessType,
} from "@vercel/blob";
import type {
  ArtifactBody,
  ArtifactStorage,
  StoreArtifactInput,
  StoredArtifact,
} from "@/server/ports/artifactStorage";

export class VercelBlobArtifactStorage implements ArtifactStorage {
  async put(input: StoreArtifactInput): Promise<StoredArtifact> {
    const key = normalizeKey(input.key);
    const access: BlobAccessType = input.visibility === "private" ? "private" : "public";
    const blob = await put(key, input.body, {
      access,
      allowOverwrite: true,
      cacheControlMaxAge: 31536000,
      contentType: input.contentType,
    });

    return {
      key: blob.pathname,
      url: blob.url,
      contentType: blob.contentType,
      byteLength: input.body.byteLength,
    };
  }

  async get(key: string): Promise<ArtifactBody | null> {
    const normalizedKey = normalizeKey(key);
    const result = await get(normalizedKey, { access: "public" });

    if (!result || result.statusCode !== 200) {
      return null;
    }

    const body = Buffer.from(await new Response(result.stream).arrayBuffer());

    return {
      key: result.blob.pathname,
      body,
      url: result.blob.url,
      contentType: result.blob.contentType,
      byteLength: result.blob.size,
    };
  }

  async getUrl(key: string) {
    try {
      const blob = await head(normalizeKey(key));
      return blob.url;
    } catch (error) {
      if (error instanceof BlobNotFoundError) {
        return null;
      }

      throw error;
    }
  }

  async delete(key: string) {
    try {
      await del(normalizeKey(key));
    } catch (error) {
      if (!(error instanceof BlobNotFoundError)) {
        throw error;
      }
    }
  }
}

function normalizeKey(key: string) {
  const parts = key
    .split("/")
    .map((part) => part.trim())
    .filter(Boolean);

  if (parts.length === 0 || parts.some((part) => part === "." || part === "..")) {
    throw new Error("Invalid artifact key.");
  }

  return parts.join("/");
}
