import { promises as fs } from "node:fs";
import path from "node:path";
import type {
  ArtifactBody,
  ArtifactStorage,
  StoreArtifactInput,
  StoredArtifact,
} from "@/server/ports/artifactStorage";

type LocalFileArtifactStorageOptions = {
  rootPath?: string;
};

type ArtifactMetadata = {
  contentType: string;
  byteLength: number;
};

export class LocalFileArtifactStorage implements ArtifactStorage {
  private readonly rootPath: string;

  constructor(options: LocalFileArtifactStorageOptions = {}) {
    this.rootPath = resolveRootPath(options.rootPath);
  }

  async put(input: StoreArtifactInput): Promise<StoredArtifact> {
    const key = normalizeKey(input.key);
    const artifactPath = this.pathForKey(key);
    const metadataPath = this.metadataPathForKey(key);

    await fs.mkdir(path.dirname(artifactPath), { recursive: true });
    await fs.writeFile(artifactPath, input.body);
    await fs.writeFile(
      metadataPath,
      `${JSON.stringify(
        {
          contentType: input.contentType,
          byteLength: input.body.byteLength,
        } satisfies ArtifactMetadata,
        null,
        2,
      )}\n`,
      "utf8",
    );

    return {
      key,
      url: artifactUrl(key),
      contentType: input.contentType,
      byteLength: input.body.byteLength,
    };
  }

  async get(key: string): Promise<ArtifactBody | null> {
    const normalizedKey = normalizeKey(key);
    const artifactPath = this.pathForKey(normalizedKey);

    try {
      const [body, metadata] = await Promise.all([
        fs.readFile(artifactPath),
        this.readMetadata(normalizedKey),
      ]);

      return {
        key: normalizedKey,
        body,
        contentType: metadata?.contentType ?? inferContentType(normalizedKey),
        byteLength: metadata?.byteLength ?? body.byteLength,
        url: artifactUrl(normalizedKey),
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return null;
      }

      throw error;
    }
  }

  async getUrl(key: string) {
    return artifactUrl(normalizeKey(key));
  }

  async delete(key: string) {
    const normalizedKey = normalizeKey(key);
    await Promise.allSettled([
      fs.unlink(this.pathForKey(normalizedKey)),
      fs.unlink(this.metadataPathForKey(normalizedKey)),
    ]);
  }

  private async readMetadata(key: string): Promise<ArtifactMetadata | null> {
    try {
      const raw = await fs.readFile(this.metadataPathForKey(key), "utf8");
      return JSON.parse(raw) as ArtifactMetadata;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return null;
      }

      throw error;
    }
  }

  private pathForKey(key: string) {
    const artifactPath = path.join(this.rootPath, ...key.split("/"));
    const relative = path.relative(this.rootPath, artifactPath);

    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new Error("Artifact key escapes the storage root.");
    }

    return artifactPath;
  }

  private metadataPathForKey(key: string) {
    return `${this.pathForKey(key)}.metadata.json`;
  }
}

function resolveRootPath(configuredPath?: string) {
  const rootPath = configuredPath ?? process.env.LOCAL_ARTIFACT_STORAGE_PATH ?? "data/artifacts";

  return path.isAbsolute(rootPath)
    ? rootPath
    : path.join(/*turbopackIgnore: true*/ process.cwd(), rootPath);
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

function artifactUrl(key: string) {
  return `/api/artifacts/${key.split("/").map(encodeURIComponent).join("/")}`;
}

function inferContentType(key: string) {
  const extension = key.split(".").at(-1)?.toLowerCase();

  switch (extension) {
    case "gif":
      return "image/gif";
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "png":
      return "image/png";
    case "svg":
      return "image/svg+xml";
    case "webp":
      return "image/webp";
    case "avif":
      return "image/avif";
    case "pdf":
      return "application/pdf";
    default:
      return "application/octet-stream";
  }
}
