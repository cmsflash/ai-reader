import fs from "node:fs";
import { registerHooks } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { neon } from "@neondatabase/serverless";
import { loadLocalEnv } from "./lib/env.mjs";

const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

registerHooks({
  resolve(specifier, context, nextResolve) {
    let basePath;

    if (specifier.startsWith("@/")) {
      basePath = path.join(projectRoot, "src", specifier.slice(2));
    } else if (
      (specifier.startsWith("./") || specifier.startsWith("../")) &&
      context.parentURL?.startsWith("file:")
    ) {
      basePath = path.resolve(
        path.dirname(fileURLToPath(context.parentURL)),
        specifier,
      );
    }

    const resolvedPath = basePath && resolveSourceFile(basePath);

    if (resolvedPath) {
      return {
        url: pathToFileURL(resolvedPath).href,
        shortCircuit: true,
      };
    }

    return nextResolve(specifier, context);
  },
});

function resolveSourceFile(basePath) {
  for (const candidate of [basePath, `${basePath}.ts`, `${basePath}.tsx`]) {
    try {
      if (fs.statSync(candidate).isFile()) {
        return candidate;
      }
    } catch {
      continue;
    }
  }

  return undefined;
}

const {
  ArticleExtractionError,
  repairArticleExtraction,
} = await import("../src/lib/extractors.ts");
const {
  ArticleDeduplicationIndex,
  articleContentFingerprint,
  canonicalizeArticleUrl,
} = await import("../src/server/articles/articleDeduplication.ts");
const { getArtifactStorage } = await import(
  "../src/server/runtime/artifactStorage.ts"
);

const apply = process.argv.includes("--apply");
const targetHosts = [
  "163.com",
  "linkedin.com",
  "music.youtube.com",
  "nvidianews.nvidia.com",
  "periodic.com",
  "trajectory.ai",
  "x.com",
  "zoom.com",
];
const invalidArticleError =
  "No readable article content was found after extraction-quality validation.";

loadLocalEnv();

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL is required.");
}

const sql = neon(process.env.DATABASE_URL);
const rows = await sql.query(`
  SELECT
    a.*,
    COALESCE(
      array_agg(DISTINCT e.provider)
        FILTER (WHERE e.provider IS NOT NULL),
      '{}'
    ) AS providers
  FROM articles a
  LEFT JOIN external_imports e
    ON e.article_id = a.id
    AND e.status = 'completed'
  GROUP BY a.id
  ORDER BY a.id
`);
const articles = rows.map(rowToArticle);
const repairs = new Map();
const invalid = [];

for (const article of articles) {
  if (!isTargetArticle(article)) {
    continue;
  }

  try {
    const repaired = repairArticleExtraction(article);

    if (repaired !== article) {
      repairs.set(article.id, repaired);
    }
  } catch (error) {
    if (error instanceof ArticleExtractionError) {
      invalid.push(article);
      continue;
    }

    throw error;
  }
}

const projectedArticles = articles
  .filter((article) => !invalid.some((invalidArticle) => invalidArticle.id === article.id))
  .map((article) => repairs.get(article.id) ?? article);
const duplicateGroups = findDuplicateGroups(projectedArticles);
const mergePlans = duplicateGroups.map((group) => {
  const selectedCanonical = [...group].sort(compareCanonicalCandidates)[0];
  const maxPercent = Math.max(
    ...group.map((article) => article.progress.percent),
  );
  const maxProgressUpdatedAt = group
    .filter((article) => article.progress.percent === maxPercent)
    .map((article) => article.progress.updatedAt)
    .sort()
    .at(-1);
  const bestTitle = [...group]
    .map((article) => article.title)
    .sort(compareTitles)[0];
  const canonical = {
    ...selectedCanonical,
    title: bestTitle,
    progress: {
      sentenceIndex: Math.round(
        maxPercent * Math.max(selectedCanonical.sentenceCount - 1, 0),
      ),
      percent: maxPercent,
      updatedAt: maxProgressUpdatedAt,
    },
  };

  return {
    canonical,
    duplicates: group.filter((article) => article.id !== canonical.id),
  };
});
const duplicateIds = new Set(
  mergePlans.flatMap((plan) => plan.duplicates.map((article) => article.id)),
);
const standaloneRepairs = [...repairs.values()].filter(
  (article) => !duplicateIds.has(article.id),
);
const standaloneContentRepairs = standaloneRepairs.filter(contentChanged);
const standaloneProgressRepairs = standaloneRepairs.filter(progressChanged);

const report = {
  mode: apply ? "apply" : "dry-run",
  scanned: articles.length,
  targeted: articles.filter(isTargetArticle).length,
  repaired: standaloneRepairs.map(repairSummary),
  invalidRemoved: invalid.map(articleSummary),
  merged: mergePlans.map((plan) => ({
    canonical: articleSummary(plan.canonical),
    duplicates: plan.duplicates.map(articleSummary),
  })),
  counts: {
    contentRepairs: standaloneContentRepairs.length,
    progressRepairs: standaloneProgressRepairs.length,
    invalidArticles: invalid.length,
    duplicateArticles: duplicateIds.size,
  },
};

if (!apply) {
  console.log(JSON.stringify(report, null, 2));
  process.exit(0);
}

const articlesToDelete = [
  ...invalid,
  ...mergePlans.flatMap((plan) => plan.duplicates),
];

await sql.transaction((tx) => {
  const queries = [];

  for (const article of invalid) {
    queries.push(tx`
      UPDATE external_imports
      SET
        status = 'failed',
        article_id = NULL,
        attempt_id = NULL,
        error_message = ${invalidArticleError},
        updated_at = now()
      WHERE article_id = ${article.id}
    `);
    queries.push(tx`DELETE FROM articles WHERE id = ${article.id}`);
  }

  for (const plan of mergePlans) {
    for (const duplicate of plan.duplicates) {
      queries.push(tx`
        UPDATE external_imports
        SET
          article_id = ${plan.canonical.id},
          metadata = jsonb_set(
            metadata,
            '{deduplication}',
            ${JSON.stringify({
              articleId: plan.canonical.id,
              reason: "source-corroborated-content",
            })}::jsonb,
            true
          ),
          updated_at = now()
        WHERE article_id = ${duplicate.id}
      `);
    }

    for (const duplicate of plan.duplicates) {
      queries.push(tx`DELETE FROM articles WHERE id = ${duplicate.id}`);
    }
  }

  for (const article of standaloneRepairs) {
    queries.push(updateArticleQuery(tx, article));
  }

  for (const plan of mergePlans) {
    queries.push(updateArticleQuery(tx, plan.canonical));
  }

  return queries;
});

const artifactCleanup = await Promise.allSettled(
  articlesToDelete.map((article) => deleteAndVerifyArtifacts(article)),
);
const artifactCleanupFailures = artifactCleanup.filter(
  (result) => result.status === "rejected",
).length;

console.log(
  JSON.stringify(
    {
      ...report,
      artifactCleanupFailures,
    },
    null,
    2,
  ),
);

function updateArticleQuery(tx, article) {
  return tx`
    UPDATE articles
    SET
      title = ${article.title},
      updated_at = ${article.updatedAt}::timestamptz,
      word_count = ${article.wordCount},
      estimated_minutes = ${article.estimatedMinutes},
      sentence_count = ${article.sentenceCount},
      progress_sentence_index = ${article.progress.sentenceIndex},
      progress_percent = ${article.progress.percent},
      progress_updated_at = ${article.progress.updatedAt}::timestamptz,
      content_html = ${article.contentHtml},
      text_content = ${article.textContent},
      blocks = ${JSON.stringify(article.blocks)}::jsonb,
      content_fingerprint = ${articleContentFingerprint(article) ?? null}
    WHERE id = ${article.id}
  `;
}

function rowToArticle(row) {
  return {
    id: row.id,
    title: row.title,
    sourceType: row.source_type,
    sourceUrl: row.source_url ?? undefined,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
    wordCount: Number(row.word_count),
    estimatedMinutes: Number(row.estimated_minutes),
    sentenceCount: Number(row.sentence_count),
    processingCostUsd: Number(row.processing_cost_usd ?? 0),
    progress: {
      sentenceIndex: Number(row.progress_sentence_index),
      percent: Number(row.progress_percent),
      updatedAt: new Date(row.progress_updated_at).toISOString(),
    },
    contentHtml: row.content_html,
    textContent: row.text_content,
    blocks: Array.isArray(row.blocks) ? row.blocks : JSON.parse(row.blocks),
    providers: row.providers,
    ownerEmail: row.owner_email,
  };
}

function isTargetArticle(article) {
  try {
    const host = new URL(article.sourceUrl).hostname.toLowerCase();
    return targetHosts.some(
      (target) => host === target || host.endsWith(`.${target}`),
    );
  } catch {
    return false;
  }
}

function findDuplicateGroups(candidates) {
  const byCanonicalUrl = new Map();

  for (const article of candidates) {
    const canonicalUrl = canonicalizeArticleUrl(article.sourceUrl);

    if (
      !canonicalUrl ||
      article.id.startsWith("gmail-rundown-") ||
      new URL(canonicalUrl).hostname === "mail.google.com"
    ) {
      continue;
    }

    const groupKey = `${article.ownerEmail}\0${canonicalUrl}`;
    const group = byCanonicalUrl.get(groupKey);

    if (group) {
      group.push(article);
    } else {
      byCanonicalUrl.set(groupKey, [article]);
    }
  }

  const groups = [];

  for (const candidatesAtUrl of byCanonicalUrl.values()) {
    if (candidatesAtUrl.length < 2) {
      continue;
    }

    const parent = candidatesAtUrl.map((_, index) => index);
    const find = (index) => {
      while (parent[index] !== index) {
        parent[index] = parent[parent[index]];
        index = parent[index];
      }
      return index;
    };
    const union = (left, right) => {
      const leftRoot = find(left);
      const rightRoot = find(right);

      if (leftRoot !== rightRoot) {
        parent[rightRoot] = leftRoot;
      }
    };

    for (let left = 0; left < candidatesAtUrl.length; left += 1) {
      const index = new ArticleDeduplicationIndex([candidatesAtUrl[left]]);

      for (let right = left + 1; right < candidatesAtUrl.length; right += 1) {
        if (index.find(candidatesAtUrl[right])) {
          union(left, right);
        }
      }
    }

    const components = new Map();

    candidatesAtUrl.forEach((article, index) => {
      const root = find(index);
      const component = components.get(root);

      if (component) {
        component.push(article);
      } else {
        components.set(root, [article]);
      }
    });

    groups.push(
      ...[...components.values()].filter((component) => component.length > 1),
    );
  }

  return groups;
}

function compareCanonicalCandidates(left, right) {
  const progressDifference = right.progress.percent - left.progress.percent;

  if (progressDifference) {
    return progressDifference;
  }

  const repairDifference = repairFraction(left) - repairFraction(right);

  if (Math.abs(repairDifference) >= 0.05) {
    return repairDifference;
  }

  const artifactDifference = artifactCount(right) - artifactCount(left);

  if (artifactDifference) {
    return artifactDifference;
  }

  const titleDifference = compareTitles(left.title, right.title);

  if (titleDifference) {
    return titleDifference;
  }

  return right.textContent.length - left.textContent.length;
}

function repairFraction(article) {
  const original = articles.find((candidate) => candidate.id === article.id);

  if (!original || original.textContent.length === 0) {
    return 0;
  }

  return Math.max(
    0,
    (original.textContent.length - article.textContent.length) /
      original.textContent.length,
  );
}

function compareTitles(left, right) {
  return titlePenalty(left) - titlePenalty(right) || left.length - right.length;
}

function titlePenalty(title) {
  return (
    (title.match(/\uFFFD/g)?.length ?? 0) * 10_000 +
    (title.match(/[|｜]/g)?.length ?? 0) * 500
  );
}

function artifactCount(article) {
  return article.blocks.filter(
    (block) => block.type === "image" && block.artifactKey,
  ).length;
}

function repairSummary(article) {
  const original = articles.find((candidate) => candidate.id === article.id);

  return {
    ...articleSummary(article),
    beforeWords: original?.wordCount,
    removedWords: original ? original.wordCount - article.wordCount : 0,
  };
}

function contentChanged(article) {
  const original = articles.find((candidate) => candidate.id === article.id);
  return Boolean(
    original &&
      (
        original.textContent !== article.textContent ||
        JSON.stringify(original.blocks) !== JSON.stringify(article.blocks)
      ),
  );
}

function progressChanged(article) {
  const original = articles.find((candidate) => candidate.id === article.id);
  return Boolean(
    original &&
      (
        original.progress.sentenceIndex !== article.progress.sentenceIndex ||
        original.progress.percent !== article.progress.percent
      ),
  );
}

function articleSummary(article) {
  return {
    id: article.id,
    title: article.title,
    host: new URL(article.sourceUrl).hostname,
    words: article.wordCount,
    artifacts: artifactCount(article),
    providers: article.providers,
  };
}

async function deleteAndVerifyArtifacts(article) {
  const keys = article.blocks
    .filter((block) => block.type === "image" && block.artifactKey)
    .map((block) => block.artifactKey);
  const storage = getArtifactStorage();

  for (const key of keys) {
    await storage.delete(key);

    if (await storage.get(key)) {
      throw new Error("An obsolete article artifact still exists after deletion.");
    }
  }
}
