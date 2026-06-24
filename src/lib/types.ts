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

export type ArticleSummary = {
  id: string;
  title: string;
  sourceType: SourceType;
  sourceUrl?: string;
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
};

export type ArticleStore = {
  version: 1;
  articles: Article[];
};
