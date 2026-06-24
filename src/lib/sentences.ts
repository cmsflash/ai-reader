import type { ArticleBlock } from "./types";

export type SentenceSegment = {
  sentenceIndex: number;
  text: string;
};

export type AnnotatedBlock =
  | (Extract<ArticleBlock, { type: "heading" | "paragraph" | "quote" | "code" }> & {
      chunks: SentenceSegment[];
    })
  | (Extract<ArticleBlock, { type: "list" }> & {
      itemChunks: SentenceSegment[][];
    })
  | (Extract<ArticleBlock, { type: "image" }> & {
      chunks: SentenceSegment[];
    })
  | (Extract<ArticleBlock, { type: "table" }> & {
      captionChunks: SentenceSegment[];
      cellChunks: SentenceSegment[][][];
    });

export function splitIntoSentences(text: string): string[] {
  const normalized = text.replace(/\s+/g, " ").trim();

  if (!normalized) {
    return [];
  }

  const matches = normalized.match(/[^.!?。！？]+(?:[.!?。！？]+["')\]]*|$)/g);
  const sentences = (matches ?? [normalized])
    .map((sentence) => sentence.trim())
    .filter(Boolean);

  return sentences.length > 0 ? sentences : [normalized];
}

export function annotateBlocks(blocks: ArticleBlock[]) {
  const sentences: SentenceSegment[] = [];
  let sentenceIndex = 0;

  const withSentenceIndexes = (text: string) => {
    const chunks = splitIntoSentences(text).map((sentence) => {
      const chunk = {
        sentenceIndex,
        text: sentence,
      };
      sentences.push(chunk);
      sentenceIndex += 1;
      return chunk;
    });

    return chunks;
  };

  const annotatedBlocks: AnnotatedBlock[] = blocks.map((block) => {
    if (block.type === "list") {
      return {
        ...block,
        itemChunks: block.items.map((item) => withSentenceIndexes(item)),
      };
    }

    if (block.type === "table") {
      return {
        ...block,
        captionChunks: block.caption ? withSentenceIndexes(block.caption) : [],
        cellChunks: block.rows.map((row) => row.map((cell) => withSentenceIndexes(cell))),
      };
    }

    if (block.type === "image") {
      return {
        ...block,
        chunks: withSentenceIndexes(imageText(block)),
      };
    }

    return {
      ...block,
      chunks: withSentenceIndexes(block.text),
    };
  });

  return {
    blocks: annotatedBlocks,
    sentences,
  };
}

function imageText(block: Extract<ArticleBlock, { type: "image" }>) {
  return [block.alt, block.caption].filter(Boolean).join(". ");
}
