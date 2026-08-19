export type SourceType = "url" | "pdf" | "docx" | "markdown" | "text";

export type ArticleBlock =
  | {
      id: string;
      type: "heading";
      level: 1 | 2 | 3 | 4 | 5 | 6;
      text: string;
    }
  | {
      id: string;
      type: "paragraph" | "quote" | "code";
      text: string;
    }
  | {
      id: string;
      type: "list";
      ordered: boolean;
      items: string[];
    }
  | {
      id: string;
      type: "image";
      alt: string;
      src?: string;
      originalSrc?: string;
      artifactKey?: string;
      caption?: string;
    }
  | {
      id: string;
      type: "table";
      caption?: string;
      headerRows?: number;
      rows: string[][];
    };

export type ReadingProgress = {
  sentenceIndex: number;
  percent: number;
  updatedAt: string;
};

export type ArticleNarrationCue = {
  sentenceIndex: number;
  sentenceText: string;
  startSeconds: number;
  endSeconds: number;
};

export type ArticleNarrationAlignment = {
  version: 1;
  model: string;
  generatedAt: string;
  transcriptSha256: string;
  sentenceMapFingerprint: string;
  sourceCoverage: number;
  exactMatchRatio: number;
  maxUnmatchedSourceRun: number;
  maxUnmatchedTranscriptRun: number;
  sentenceCues: ArticleNarrationCue[];
};

export type ArticleNarrationSegment = {
  index: number;
  artifactKey: string;
  artifactVisibility: "private" | "public";
  contentType: string;
  byteLength: number;
  startSeconds: number;
  durationSeconds: number;
  inputSha256: string;
};

export type ArticleNarration = {
  version?: 1 | 2;
  artifactKey: string;
  artifactVisibility: "private" | "public";
  contentType: string;
  byteLength: number;
  sourceTextSha256: string;
  model: string;
  voice: string;
  generatedAt: string;
  durationSeconds?: number;
  generationFingerprint?: string;
  language?: "zh-CN" | "en-US";
  profileVersion?: number;
  segments?: ArticleNarrationSegment[];
  alignment?: ArticleNarrationAlignment;
};

export type ArticleFolder = {
  id: string;
  name: string;
  slug?: string;
  isArchive: boolean;
  createdAt: string;
  updatedAt: string;
};

export type ArticleSummary = {
  id: string;
  title: string;
  sourceType: SourceType;
  sourceUrl?: string;
  excerpt?: string;
  thumbnailUrl?: string;
  folderId?: string;
  archivedAt?: string;
  createdAt: string;
  updatedAt: string;
  wordCount: number;
  estimatedMinutes: number;
  sentenceCount: number;
  processingCostUsd: number;
  progress: ReadingProgress;
};

export type Article = ArticleSummary & {
  contentHtml: string;
  textContent: string;
  blocks: ArticleBlock[];
  narration?: ArticleNarration;
};

export type ArticleStore = {
  version: 1;
  articles: Article[];
  folders?: ArticleFolder[];
};
