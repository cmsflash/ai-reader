import { LocalFileArtifactStorage } from "@/server/adapters/localFileArtifactStorage";
import { VercelBlobArtifactStorage } from "@/server/adapters/vercelBlobArtifactStorage";
import type { ArtifactStorage } from "@/server/ports/artifactStorage";

type ArtifactStorageDriver = "local-file" | "vercel-blob" | "firebase" | "supabase" | "s3";

let storage: ArtifactStorage | null = null;

export function getArtifactStorage(): ArtifactStorage {
  if (storage) {
    return storage;
  }

  const driver = getDriver();

  switch (driver) {
    case "local-file":
      storage = new LocalFileArtifactStorage();
      return storage;
    case "vercel-blob":
      storage = new VercelBlobArtifactStorage();
      return storage;
    case "firebase":
    case "supabase":
    case "s3":
      throw new Error(
        `ARTIFACT_STORAGE_DRIVER=${driver} is configured, but its adapter is not implemented yet.`,
      );
    default:
      driver satisfies never;
      throw new Error("Unsupported artifact storage driver.");
  }
}

function getDriver(): ArtifactStorageDriver {
  const driver = process.env.ARTIFACT_STORAGE_DRIVER ?? "local-file";

  if (
    driver === "local-file" ||
    driver === "vercel-blob" ||
    driver === "firebase" ||
    driver === "supabase" ||
    driver === "s3"
  ) {
    return driver;
  }

  throw new Error(`Unsupported ARTIFACT_STORAGE_DRIVER=${driver}`);
}
