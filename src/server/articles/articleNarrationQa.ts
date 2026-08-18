import { createHash } from "node:crypto";

export type ArticleNarrationQa = {
  ok: boolean;
  expectedCharacters: number;
  transcriptCharacters: number;
  characterErrorRate: number;
  orderedCoverage: number;
  maxContiguousSourceDeletion: number;
  paragraphCount: number;
  paragraphAnchorsMatched: number;
  repeatedCoupletCounts: number[];
  forbiddenQuoteMarkers: string[];
  failures: string[];
};

export function canonicalNarrationSource(title: string, textContent: string) {
  return `${title.trim()}\n\n${textContent.trim()}`;
}

export function normalizeNarrationInput(text: string) {
  return text
    .normalize("NFKC")
    .replace(/[\u00ad\u200b-\u200d\u2060\ufeff]/gu, "")
    .replace(/[“”‘’「」『』]/gu, "")
    .replace(/(?:…{2,}|\.{3,})/gu, "。")
    .replace(/[ \t]+\n/gu, "\n")
    .replace(/\n[ \t]+/gu, "\n")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
}

export function narrationSourceSha256(title: string, textContent: string) {
  return sha256Text(canonicalNarrationSource(title, textContent));
}

export function sha256Text(text: string) {
  return createHash("sha256").update(text).digest("hex");
}

export function evaluateNarrationTranscript(
  expectedText: string,
  transcript: string,
): ArticleNarrationQa {
  const expected = comparableNarrationText(expectedText);
  const actual = comparableNarrationText(transcript);
  const editDistance = levenshteinDistance(expected, actual);
  const lcs = longestCommonSubsequence(expected, actual);
  const characterErrorRate =
    expected.length > 0
      ? editDistance / expected.length
      : actual.length === 0
        ? 0
        : 1;
  const orderedCoverage =
    expected.length > 0 ? lcs.length / expected.length : 1;
  const paragraphs = expectedParagraphs(expectedText);
  const paragraphAnchors = orderedParagraphAnchors(actual, paragraphs);
  const repeatedCouplets = paragraphs
    .slice(1, 3)
    .map((couplet) => countFuzzyOccurrences(actual, couplet));
  const finalAnchor = paragraphs.at(-1) ?? "";
  const forbiddenQuoteMarkers = [
    "right",
    "left",
    "handed",
    "quotation",
    "quote",
    "mark",
    "引号",
    "引號",
    "双引号",
    "雙引號",
  ].filter((marker) => transcript.toLocaleLowerCase().includes(marker));
  const failures: string[] = [];

  if (characterErrorRate > 0.08) {
    failures.push(
      `character error rate ${(characterErrorRate * 100).toFixed(2)}% exceeds 8%`,
    );
  }
  if (orderedCoverage < 0.95) {
    failures.push(
      `ordered coverage ${(orderedCoverage * 100).toFixed(2)}% is below 95%`,
    );
  }
  if (lcs.maxSourceGap > 4) {
    failures.push(
      `a contiguous source span of ${lcs.maxSourceGap} characters was not matched`,
    );
  }
  if (!paragraphAnchors.ok) {
    failures.push(
      `paragraph ${paragraphAnchors.failedParagraph} anchors were not found in order`,
    );
  }
  if (repeatedCouplets.some((count) => count < 2)) {
    failures.push(
      "the repeated opening and ending couplets were not both transcribed twice",
    );
  }
  if (
    finalAnchor &&
    levenshteinDistance(
      finalAnchor,
      actual.slice(-Math.min(finalAnchor.length, actual.length)),
    ) > 1
  ) {
    failures.push("the final couplet was not transcribed at the end");
  }
  if (forbiddenQuoteMarkers.length > 0) {
    failures.push(
      `spoken quote-marker words detected: ${forbiddenQuoteMarkers.join(", ")}`,
    );
  }

  return {
    ok: failures.length === 0,
    expectedCharacters: expected.length,
    transcriptCharacters: actual.length,
    characterErrorRate,
    orderedCoverage,
    maxContiguousSourceDeletion: lcs.maxSourceGap,
    paragraphCount: paragraphs.length,
    paragraphAnchorsMatched: paragraphAnchors.matched,
    repeatedCoupletCounts: repeatedCouplets,
    forbiddenQuoteMarkers,
    failures,
  };
}

export function comparableNarrationText(text: string) {
  return Array.from(
    text
      .normalize("NFKC")
      .toLocaleLowerCase()
      .replace(/[^\p{L}\p{N}]/gu, ""),
  ).join("");
}

function expectedParagraphs(text: string) {
  return text
    .split(/\n+/u)
    .map(comparableNarrationText)
    .filter(Boolean);
}

function orderedParagraphAnchors(transcript: string, paragraphs: string[]) {
  let cursor = 0;
  let matched = 0;

  for (const [index, paragraph] of paragraphs.entries()) {
    if (paragraph.length <= 8) {
      const paragraphIndex = findFuzzy(transcript, paragraph, cursor);

      if (paragraphIndex < 0) {
        return { ok: false, matched, failedParagraph: index + 1 };
      }

      cursor = paragraphIndex + paragraph.length;
      matched += 1;
      continue;
    }

    const first = paragraph.slice(0, Math.min(4, paragraph.length));
    const last = paragraph.slice(-Math.min(4, paragraph.length));
    const firstIndex = findFuzzy(transcript, first, cursor);
    const lastIndex =
      firstIndex < 0
        ? -1
        : findFuzzy(transcript, last, firstIndex + first.length);

    if (firstIndex < 0 || lastIndex < 0) {
      return { ok: false, matched, failedParagraph: index + 1 };
    }
    cursor = lastIndex + last.length;
    matched += 1;
  }

  return { ok: true, matched, failedParagraph: null };
}

function findFuzzy(text: string, needle: string, fromIndex: number) {
  const exact = text.indexOf(needle, fromIndex);
  if (exact >= 0) {
    return exact;
  }

  for (
    let index = fromIndex;
    index <= text.length - Math.max(needle.length - 1, 1);
    index += 1
  ) {
    for (const length of [needle.length - 1, needle.length, needle.length + 1]) {
      if (
        length > 0 &&
        levenshteinDistance(needle, text.slice(index, index + length)) <= 1
      ) {
        return index;
      }
    }
  }
  return -1;
}

function longestCommonSubsequence(source: string, transcript: string) {
  const rows = source.length + 1;
  const columns = transcript.length + 1;
  const table = Array.from({ length: rows }, () => new Uint16Array(columns));

  for (let sourceIndex = 1; sourceIndex < rows; sourceIndex += 1) {
    for (let transcriptIndex = 1; transcriptIndex < columns; transcriptIndex += 1) {
      table[sourceIndex][transcriptIndex] =
        source[sourceIndex - 1] === transcript[transcriptIndex - 1]
          ? table[sourceIndex - 1][transcriptIndex - 1] + 1
          : Math.max(
              table[sourceIndex - 1][transcriptIndex],
              table[sourceIndex][transcriptIndex - 1],
            );
    }
  }

  const matchedSourceIndexes: number[] = [];
  let sourceIndex = source.length;
  let transcriptIndex = transcript.length;

  while (sourceIndex > 0 && transcriptIndex > 0) {
    if (source[sourceIndex - 1] === transcript[transcriptIndex - 1]) {
      matchedSourceIndexes.push(sourceIndex - 1);
      sourceIndex -= 1;
      transcriptIndex -= 1;
    } else if (
      table[sourceIndex - 1][transcriptIndex] >=
      table[sourceIndex][transcriptIndex - 1]
    ) {
      sourceIndex -= 1;
    } else {
      transcriptIndex -= 1;
    }
  }

  matchedSourceIndexes.reverse();
  let previous = -1;
  let maxSourceGap = 0;
  for (const matchedIndex of [...matchedSourceIndexes, source.length]) {
    maxSourceGap = Math.max(maxSourceGap, matchedIndex - previous - 1);
    previous = matchedIndex;
  }

  return { length: table[source.length][transcript.length], maxSourceGap };
}

function levenshteinDistance(left: string, right: string) {
  if (left.length === 0) return right.length;
  if (right.length === 0) return left.length;
  let previous = Array.from(
    { length: right.length + 1 },
    (_, index) => index,
  );

  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    const current = [leftIndex];
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      current[rightIndex] = Math.min(
        current[rightIndex - 1] + 1,
        previous[rightIndex] + 1,
        previous[rightIndex - 1] +
          (left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1),
      );
    }
    previous = current;
  }
  return previous[right.length];
}

function countFuzzyOccurrences(text: string, value: string) {
  let count = 0;
  let cursor = 0;

  while (value && cursor < text.length) {
    const match = findFuzzy(text, value, cursor);

    if (match < 0) {
      break;
    }

    count += 1;
    cursor = match + value.length;
  }

  return count;
}
