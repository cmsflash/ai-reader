import type { SourceType } from "@/lib/types";

export type ImportJobSource =
  | {
      type: "url";
      url: string;
    }
  | {
      type: Exclude<SourceType, "url">;
      artifactKey: string;
      fileName: string;
      contentType: string;
    };

export type ImportJob = {
  id: string;
  userId?: string;
  source: ImportJobSource;
  status: "queued" | "running" | "completed" | "failed";
};

export interface ImportQueue {
  enqueue(source: ImportJobSource, options?: { userId?: string }): Promise<ImportJob>;
}
