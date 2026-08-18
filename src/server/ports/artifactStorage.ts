export type ArtifactVisibility = "private" | "public";

export type StoreArtifactInput = {
  key: string;
  body: Buffer;
  contentType: string;
  visibility?: ArtifactVisibility;
};

export type StoredArtifact = {
  key: string;
  url?: string;
  contentType: string;
  byteLength: number;
};

export type ArtifactBody = StoredArtifact & {
  body: Buffer;
};

export interface ArtifactStorage {
  put(input: StoreArtifactInput): Promise<StoredArtifact>;
  get(
    key: string,
    visibility?: ArtifactVisibility,
  ): Promise<ArtifactBody | null>;
  getUrl(key: string): Promise<string | null>;
  delete(key: string): Promise<void>;
}
