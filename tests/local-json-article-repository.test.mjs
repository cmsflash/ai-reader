import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { LocalJsonArticleRepository } from "../src/server/adapters/localJsonArticleRepository.ts";

test("serializes concurrent creates without losing either article", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "ai-reader-store-"));
  const repository = new LocalJsonArticleRepository({
    storePath: path.join(directory, "articles.json"),
  });

  try {
    await Promise.all([
      repository.create(article("first"), "reader@example.com"),
      repository.create(article("second"), "reader@example.com"),
    ]);

    const articles = await repository.list("reader@example.com");
    const folders = await repository.listFolders("reader@example.com");
    assert.deepEqual(
      new Set(articles.map((candidate) => candidate.id)),
      new Set(["first", "second"]),
    );
    assert.equal(folders.length, 1);
    assert.equal(folders[0].name, "Default");
    assert.equal(folders[0].slug, "default");
    assert.ok(
      articles.every((candidate) => candidate.folderId === folders[0].id),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("returns the stored article when a deterministic ID is retried", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "ai-reader-store-"));
  const repository = new LocalJsonArticleRepository({
    storePath: path.join(directory, "articles.json"),
  });

  try {
    const original = article("stable");
    const saved = await repository.create(original, "reader@example.com");
    const retried = await repository.create(
      { ...original, title: "Retry should not replace state" },
      "reader@example.com",
    );

    assert.equal(saved.title, "Article stable");
    assert.equal(retried.title, "Article stable");
    assert.equal(
      (await repository.list("reader@example.com")).length,
      1,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("returns compact deduplication candidates without changing local storage behavior", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "ai-reader-store-"));
  const repository = new LocalJsonArticleRepository({
    storePath: path.join(directory, "articles.json"),
  });

  try {
    await repository.create(
      {
        ...article(
          "candidate",
          "A sufficiently long article body for compact exact matching.",
        ),
        sourceType: "url",
        sourceUrl: "https://example.com/candidate",
      },
      "reader@example.com",
    );

    assert.deepEqual(
      await repository.listDeduplicationCandidates("reader@example.com"),
      [
        {
          id: "candidate",
          title: "Article candidate",
          sourceUrl: "https://example.com/candidate",
          textContent:
            "A sufficiently long article body for compact exact matching.",
        },
      ],
    );
    assert.equal(
      (await repository.findById("candidate", "reader@example.com"))
        ?.contentHtml,
      "<p>A sufficiently long article body for compact exact matching.</p>",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("atomically reuses one article for concurrent exact-content duplicates", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "ai-reader-store-"));
  const repository = new LocalJsonArticleRepository({
    storePath: path.join(directory, "articles.json"),
  });
  const sharedText =
    "The same normalized article body arrived from Instapaper and Dropbox at once.";

  try {
    const [instapaper, dropbox] = await Promise.all([
      repository.create(
        article("instapaper", sharedText),
        "reader@example.com",
      ),
      repository.create(
        article("dropbox", sharedText),
        "reader@example.com",
      ),
    ]);

    assert.equal(instapaper.id, dropbox.id);
    assert.equal(
      (await repository.list("reader@example.com")).length,
      1,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("import progress advances monotonically under concurrent updates", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "ai-reader-store-"));
  const repository = new LocalJsonArticleRepository({
    storePath: path.join(directory, "articles.json"),
  });

  try {
    await repository.create(
      { ...article("progress"), sentenceCount: 11 },
      "reader@example.com",
    );
    await Promise.all([
      repository.advanceProgress("progress", "reader@example.com", 0.8),
      repository.advanceProgress("progress", "reader@example.com", 0.5),
    ]);

    const stored = await repository.findById(
      "progress",
      "reader@example.com",
    );
    assert.equal(stored?.progress.percent, 0.8);
    assert.equal(stored?.progress.sentenceIndex, 8);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("persists and clears owner-scoped pre-generated narration", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "ai-reader-store-"));
  const storePath = path.join(directory, "articles.json");
  const repository = new LocalJsonArticleRepository({ storePath });
  const narration = {
    artifactKey: "articles/narrated/audio/body.mp3",
    artifactVisibility: "public",
    contentType: "audio/mpeg",
    byteLength: 42_000,
    sourceTextSha256: "a".repeat(64),
    model: "gpt-4o-mini-tts",
    voice: "cedar",
    generatedAt: "2026-08-18T04:00:00.000Z",
    durationSeconds: 31.25,
  };

  try {
    await repository.create(article("narrated"), "reader@example.com");

    assert.equal(
      await repository.updateNarration(
        "narrated",
        "other@example.com",
        narration,
      ),
      null,
    );

    const updated = await repository.updateNarration(
      "narrated",
      "reader@example.com",
      narration,
      0.042,
      true,
    );
    assert.deepEqual(updated?.narration, narration);
    assert.equal(updated?.processingCostUsd, 0.042);

    const persisted = JSON.parse(await readFile(storePath, "utf8"));
    assert.deepEqual(persisted.articles[0].narration, narration);

    const cleared = await repository.updateNarration(
      "narrated",
      "reader@example.com",
      null,
    );
    assert.equal(cleared?.narration, undefined);
    assert.equal(
      Object.hasOwn(
        JSON.parse(await readFile(storePath, "utf8")).articles[0],
        "narration",
      ),
      false,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("persists owner-scoped folders and archive state without affecting article content", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "ai-reader-store-"));
  const repository = new LocalJsonArticleRepository({
    storePath: path.join(directory, "articles.json"),
  });

  try {
    await repository.create(
      {
        ...article(
          "organized",
          "A concise article preview that remains readable after organization changes.",
        ),
        blocks: [
          {
            id: "image-0",
            type: "image",
            alt: "Research illustration",
            src: "https://cdn.example.com/research.jpg",
          },
          {
            id: "paragraph-0",
            type: "paragraph",
            text: "A concise article preview that remains readable after organization changes.",
          },
        ],
      },
      "reader@example.com",
    );
    const folder = await repository.createFolder(
      " Research ",
      "reader@example.com",
    );
    const reused = await repository.createFolder(
      "research",
      "reader@example.com",
    );
    const otherOwnerFolder = await repository.createFolder(
      "Research",
      "other@example.com",
    );
    const defaultFolder = (await repository.listFolders("reader@example.com"))
      .find((candidate) => candidate.slug === "default");

    assert.equal(reused.id, folder.id);
    assert.notEqual(otherOwnerFolder.id, folder.id);
    assert.ok(defaultFolder);
    assert.deepEqual(await repository.listFolders("reader@example.com"), [
      defaultFolder,
      folder,
    ]);

    const archived = await repository.updateOrganization(
      "organized",
      "reader@example.com",
      { archived: true, folderId: folder.id },
    );

    assert.equal(archived?.folderId, folder.id);
    assert.match(archived?.archivedAt ?? "", /^2026-|^20\d\d-/);
    assert.equal(
      (await repository.findById("organized", "reader@example.com"))
        ?.textContent,
      "A concise article preview that remains readable after organization changes.",
    );

    const [summary] = await repository.list("reader@example.com");
    assert.equal(summary.folderId, folder.id);
    assert.equal(summary.archivedAt, archived?.archivedAt);
    assert.equal(
      summary.excerpt,
      "A concise article preview that remains readable after organization changes.",
    );
    assert.equal(
      summary.thumbnailUrl,
      "https://cdn.example.com/research.jpg",
    );

    const restored = await repository.updateOrganization(
      "organized",
      "reader@example.com",
      { archived: false },
    );
    assert.equal(restored?.archivedAt, null);
    assert.equal(restored?.folderId, folder.id);

    await assert.rejects(
      repository.updateOrganization("organized", "reader@example.com", {
        folderId: otherOwnerFolder.id,
      }),
      /Folder not found/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("restoring a legacy archive-folder article returns it to a normal folder", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "ai-reader-store-"));
  const storePath = path.join(directory, "articles.json");
  const repository = new LocalJsonArticleRepository({ storePath });

  try {
    const defaultFolder = await repository.createFolder(
      "Default",
      "reader@example.com",
    );
    const archiveFolder = await repository.createFolder(
      "Archive",
      "reader@example.com",
    );
    const store = JSON.parse(await readFile(storePath, "utf8"));
    const storedArchive = store.folders.find(
      (folder) => folder.id === archiveFolder.id,
    );
    storedArchive.isArchive = true;
    storedArchive.slug = "archive";
    await writeFile(storePath, `${JSON.stringify(store, null, 2)}\n`, "utf8");

    await repository.create(article("legacy-archive"), "reader@example.com");
    await repository.updateOrganization(
      "legacy-archive",
      "reader@example.com",
      { archived: true, folderId: archiveFolder.id },
    );
    const restored = await repository.updateOrganization(
      "legacy-archive",
      "reader@example.com",
      { archived: false },
    );

    assert.equal(restored?.archivedAt, null);
    assert.equal(restored?.folderId, defaultFolder.id);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("paginates locally with location totals and stable list sorting", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "ai-reader-store-"));
  const repository = new LocalJsonArticleRepository({
    storePath: path.join(directory, "articles.json"),
  });

  try {
    await repository.create(
      {
        ...article("default-beta"),
        title: "Beta",
        createdAt: "2026-08-03T00:00:00.000Z",
      },
      "reader@example.com",
    );
    await repository.create(
      {
        ...article("default-alpha"),
        title: "Alpha",
        createdAt: "2026-08-03T00:00:00.000Z",
      },
      "reader@example.com",
    );
    await repository.create(
      {
        ...article("research"),
        createdAt: "2026-08-04T00:00:00.000Z",
      },
      "reader@example.com",
    );
    await repository.create(
      {
        ...article("archived"),
        createdAt: "2026-08-05T00:00:00.000Z",
      },
      "reader@example.com",
    );
    const researchFolder = await repository.createFolder(
      "Research",
      "reader@example.com",
    );
    await repository.updateOrganization(
      "research",
      "reader@example.com",
      { folderId: researchFolder.id },
    );
    await repository.updateOrganization(
      "archived",
      "reader@example.com",
      { archived: true },
    );

    const firstPage = await repository.listPage("reader@example.com", {
      location: "default",
      sort: "saved-desc",
      limit: 1,
      offset: 0,
    });
    const secondPage = await repository.listPage("reader@example.com", {
      location: "default",
      sort: "saved-desc",
      limit: 1,
      offset: firstPage.nextOffset,
    });
    const researchPage = await repository.listPage("reader@example.com", {
      location: `folder:${researchFolder.id}`,
      sort: "saved-desc",
      limit: 30,
      offset: 0,
    });
    const archivePage = await repository.listPage("reader@example.com", {
      location: "archive",
      sort: "saved-desc",
      limit: 30,
      offset: 0,
    });

    assert.deepEqual(firstPage.articles.map(({ id }) => id), [
      "default-alpha",
    ]);
    assert.equal(firstPage.total, 2);
    assert.equal(firstPage.activeTotal, 3);
    assert.equal(firstPage.nextOffset, 1);
    assert.deepEqual(secondPage.articles.map(({ id }) => id), [
      "default-beta",
    ]);
    assert.equal(secondPage.nextOffset, null);
    assert.deepEqual(researchPage.articles.map(({ id }) => id), ["research"]);
    assert.equal(researchPage.total, 1);
    assert.equal(researchPage.activeTotal, 3);
    assert.deepEqual(archivePage.articles.map(({ id }) => id), ["archived"]);
    assert.equal(archivePage.total, 1);
    assert.equal(archivePage.activeTotal, 3);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

function article(id, textContent = id) {
  const timestamp = "2026-07-27T12:00:00.000Z";

  return {
    id,
    title: `Article ${id}`,
    sourceType: "text",
    createdAt: timestamp,
    updatedAt: timestamp,
    wordCount: 1,
    estimatedMinutes: 1,
    sentenceCount: 1,
    processingCostUsd: 0,
    progress: {
      sentenceIndex: 0,
      percent: 0,
      updatedAt: timestamp,
    },
    contentHtml: `<p>${textContent}</p>`,
    textContent,
    blocks: [
      {
        id: "paragraph-0",
        type: "paragraph",
        text: textContent,
      },
    ],
  };
}
