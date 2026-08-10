import assert from "node:assert/strict";
import fs from "node:fs";
import { registerHooks } from "node:module";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

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

const { PostgresArticleRepository } = await import(
  "../src/server/adapters/postgresArticleRepository.ts"
);

test("library listing selects and returns summary fields only", async () => {
  const queries = [];
  const defaultFolder = {
    id: "folder-default",
    name: "Default",
    slug: "default",
    is_archive: false,
    created_at: "2026-07-29T07:00:00.000Z",
    updated_at: "2026-07-29T07:00:00.000Z",
  };
  const repository = new PostgresArticleRepository({
    async query(statement, params) {
      const normalized = normalizeQuery(statement);
      queries.push({ statement: normalized, params });

      if (normalized.includes("AND (slug = 'default' OR lower(name) = 'default')")) {
        return [defaultFolder];
      }

      if (normalized.startsWith("UPDATE articles SET folder_id")) {
        return [];
      }

      return [
        {
          id: "article-1",
          title: "A compact summary",
          source_type: "url",
          source_url: "https://example.com/read",
          folder_id: "folder-research",
          archived_at: null,
          created_at: "2026-07-29T08:00:00.000Z",
          updated_at: "2026-07-29T09:00:00.000Z",
          word_count: "420",
          estimated_minutes: 2,
          sentence_count: "18",
          processing_cost_usd: "0.125",
          progress_sentence_index: "4",
          progress_percent: "0.25",
          progress_updated_at: "2026-07-29T09:00:00.000Z",
          excerpt:
            "A compact summary A useful preview without the complete article body.",
          thumbnail_url: "https://cdn.example.com/preview.jpg",
        },
      ];
    },
  });

  const summaries = await repository.list(" Reader@Example.com ");
  const normalizedQuery = queries[2].statement;

  assert.equal(queries.length, 3);
  assert.deepEqual(queries[0].params, ["reader@example.com"]);
  assert.deepEqual(queries[1].params, [
    "reader@example.com",
    "folder-default",
  ]);
  assert.deepEqual(queries[2].params, ["reader@example.com"]);
  assert.match(queries[1].statement, /folder_id IS NULL/);
  assert.doesNotMatch(normalizedQuery, /\bcontent_html\b/);
  assert.match(normalizedQuery, /\bexcerpt\b/);
  assert.match(normalizedQuery, /\bthumbnail_url\b/);
  assert.doesNotMatch(normalizedQuery, /\btext_content\b|\bblocks\b/);
  assert.deepEqual(summaries, [
    {
      id: "article-1",
      title: "A compact summary",
      sourceType: "url",
      sourceUrl: "https://example.com/read",
      excerpt: "A useful preview without the complete article body.",
      thumbnailUrl: "https://cdn.example.com/preview.jpg",
      folderId: "folder-research",
      archivedAt: undefined,
      createdAt: "2026-07-29T08:00:00.000Z",
      updatedAt: "2026-07-29T09:00:00.000Z",
      wordCount: 420,
      estimatedMinutes: 2,
      sentenceCount: 18,
      processingCostUsd: 0.125,
      progress: {
        sentenceIndex: 4,
        percent: 0.25,
        updatedAt: "2026-07-29T09:00:00.000Z",
      },
    },
  ]);
});

test("deduplication listing transfers only fields used by the matcher", async () => {
  const queries = [];
  const repository = new PostgresArticleRepository({
    async query(statement, params) {
      queries.push({ statement, params });
      return [
        {
          id: "canonical",
          title: "Canonical article",
          source_url: null,
          text_content:
            "This compact row has enough normalized text for exact matching.",
        },
      ];
    },
  });

  const candidates = await repository.listDeduplicationCandidates(
    "reader@example.com",
  );
  const normalizedQuery = normalizeQuery(queries[0].statement);

  assert.equal(queries.length, 1);
  assert.deepEqual(queries[0].params, ["reader@example.com"]);
  assert.match(normalizedQuery, /\btext_content\b/);
  assert.doesNotMatch(normalizedQuery, /\bcontent_html\b/);
  assert.doesNotMatch(normalizedQuery, /\bblocks\b/);
  assert.doesNotMatch(normalizedQuery, /\bprogress_percent\b/);
  assert.deepEqual(candidates, [
    {
      id: "canonical",
      title: "Canonical article",
      sourceUrl: undefined,
      textContent:
        "This compact row has enough normalized text for exact matching.",
    },
  ]);
});

test("folder listing creates a real Default folder when one is missing", async () => {
  const queries = [];
  const defaultRow = {
    id: "folder-default",
    name: "Default",
    slug: "default",
    is_archive: false,
    created_at: "2026-08-10T12:00:00.000Z",
    updated_at: "2026-08-10T12:00:00.000Z",
  };
  const repository = new PostgresArticleRepository({
    async query(statement, params) {
      const normalized = normalizeQuery(statement);
      queries.push({ statement: normalized, params });

      if (normalized.includes("AND (slug = 'default' OR lower(name) = 'default')")) {
        return [];
      }

      if (normalized.startsWith("INSERT INTO reading_folders")) {
        return [defaultRow];
      }

      if (normalized.startsWith("SELECT id, name, slug, is_archive")) {
        return [defaultRow];
      }

      throw new Error(`Unexpected query: ${normalized}`);
    },
  });

  assert.deepEqual(await repository.listFolders(" Reader@Example.com "), [
    {
      id: "folder-default",
      name: "Default",
      slug: "default",
      isArchive: false,
      createdAt: "2026-08-10T12:00:00.000Z",
      updatedAt: "2026-08-10T12:00:00.000Z",
    },
  ]);
  assert.equal(queries.length, 3);
  assert.deepEqual(queries[0].params, ["reader@example.com"]);
  assert.equal(queries[1].params[1], "reader@example.com");
  assert.equal(queries[1].params.length, 3);
  assert.deepEqual(queries[2].params, ["reader@example.com"]);
});

test("creates owner-scoped folders and atomically archives and moves an article", async () => {
  const queries = [];
  const repository = new PostgresArticleRepository({
    async query(statement, params) {
      const normalized = normalizeQuery(statement);
      queries.push({ statement: normalized, params });

      if (normalized.startsWith("SELECT id, name, slug, is_archive")) {
        return [];
      }

      if (normalized.startsWith("INSERT INTO reading_folders")) {
        return [
          {
            id: params[0],
            name: params[2],
            slug: params[3],
            is_archive: false,
            created_at: params[4],
            updated_at: params[4],
          },
        ];
      }

      if (normalized.startsWith("UPDATE articles")) {
        return [
          {
            id: "article-1",
            folder_id: params[5],
            archived_at: params[2],
            updated_at: params[2],
          },
        ];
      }

      throw new Error(`Unexpected query: ${normalized}`);
    },
  });

  const folder = await repository.createFolder(
    "  Research   Notes  ",
    " Reader@Example.com ",
  );
  const updated = await repository.updateOrganization(
    "article-1",
    " Reader@Example.com ",
    { archived: true, folderId: folder.id },
  );

  assert.match(folder.id, /^folder-/);
  assert.equal(folder.name, "Research Notes");
  assert.equal(folder.isArchive, false);
  assert.deepEqual(queries[0].params, [
    "reader@example.com",
    "research notes",
  ]);
  assert.deepEqual(queries[1].params.slice(1, 3), [
    "reader@example.com",
    "Research Notes",
  ]);
  assert.match(queries[1].params[3], /^research-notes-[a-f0-9]{12}$/);
  assert.match(
    queries[1].statement,
    /ON CONFLICT \(owner_email, slug\) DO UPDATE/,
  );
  assert.match(queries[2].statement, /EXISTS \( SELECT 1 FROM reading_folders/);
  assert.deepEqual(queries[2].params.slice(0, 2), [
    "article-1",
    "reader@example.com",
  ]);
  assert.equal(queries[2].params[3], true);
  assert.equal(queries[2].params[4], true);
  assert.equal(queries[2].params[5], folder.id);
  assert.equal(updated?.folderId, folder.id);
  assert.ok(updated?.archivedAt);
  assert.match(
    queries[2].statement,
    /RETURNING id, folder_id, archived_at, updated_at$/,
  );
  assert.match(queries[2].statement, /current_folder\.is_archive = true/);
  assert.doesNotMatch(queries[2].statement, /content_html|text_content|blocks/);
});

test("archive-only updates preserve the folder and null folder moves are rejected", async () => {
  const queries = [];
  const repository = new PostgresArticleRepository({
    async query(statement, params) {
      const normalized = normalizeQuery(statement);
      queries.push({ statement: normalized, params });

      if (normalized.startsWith("UPDATE articles")) {
        return [
          {
            id: "article-1",
            folder_id: "folder-default",
            archived_at: params[2],
            updated_at: params[2],
          },
        ];
      }

      throw new Error(`Unexpected query: ${normalized}`);
    },
  });

  const archived = await repository.updateOrganization(
    "article-1",
    " Reader@Example.com ",
    { archived: true },
  );
  await assert.rejects(
    repository.updateOrganization(
      "article-1",
      " Reader@Example.com ",
      { folderId: null },
    ),
    /Folder is required/,
  );

  assert.equal(queries.length, 1);
  assert.equal(queries[0].params[3], true);
  assert.equal(queries[0].params[4], false);
  assert.equal(queries[0].params[5], null);
  assert.match(queries[0].statement, /WHEN \$5::boolean THEN \$6::text/);
  assert.doesNotMatch(queries[0].statement, /OR \$6::text IS NULL/);
  assert.match(queries[0].statement, /id = \$6::text/);
  assert.equal(archived?.folderId, "folder-default");
  assert.ok(archived?.archivedAt);
});

function normalizeQuery(statement) {
  return statement.replace(/\s+/g, " ").trim();
}

function resolveSourceFile(basePath) {
  const candidates = [
    basePath,
    `${basePath}.ts`,
    `${basePath}.tsx`,
    `${basePath}.js`,
    `${basePath}.mjs`,
    path.join(basePath, "index.ts"),
    path.join(basePath, "index.tsx"),
    path.join(basePath, "index.js"),
  ];

  return candidates.find((candidate) => {
    try {
      return fs.statSync(candidate).isFile();
    } catch {
      return false;
    }
  });
}
