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

const { PostgresDiscussionRepository } = await import(
  "../src/server/adapters/postgresDiscussionRepository.ts"
);

test("claims owner-scoped user and pending assistant rows before generation", async () => {
  const queries = [];
  const repository = new PostgresDiscussionRepository({
    async query(statement, params) {
      const normalized = normalizeQuery(statement);
      queries.push({ statement: normalized, params });

      if (normalized.startsWith("INSERT INTO article_discussion_messages") && normalized.includes("FROM articles AS article")) {
        return [
          row({
            id: params[0],
            requestId: params[3],
            role: "user",
            status: "complete",
            content: params[4],
            scope: params[5],
            selection: params[6],
            createdAt: params[7],
            updatedAt: params[7],
          }),
        ];
      }

      if (normalized.startsWith("INSERT INTO article_discussion_messages")) {
        return [
          row({
            id: params[0],
            requestId: params[3],
            role: "assistant",
            status: "pending",
            content: "",
            attemptId: params[4],
            model: params[5],
            createdAt: params[6],
            updatedAt: params[6],
          }),
        ];
      }

      throw new Error(`Unexpected query: ${normalized}`);
    },
  });

  const result = await repository.claimTurn({
    ownerEmail: " Reader@Example.com ",
    articleId: "article-1",
    requestId: "turn-1",
    message: "Explain this.",
    scope: "selection",
    selection: "Selected passage.",
    model: "gpt-5.6-sol",
  });

  assert.equal(result.kind, "claimed");
  assert.equal(result.user.selection, "Selected passage.");
  assert.equal(result.assistant.status, "pending");
  assert.equal(result.assistant.model, "gpt-5.6-sol");
  assert.equal(queries.length, 2);
  assert.match(queries[0].statement, /FROM articles AS article/);
  assert.match(
    queries[0].statement,
    /WHERE article\.owner_email = \$2 AND article\.id = \$3/,
  );
  assert.equal(queries[0].params[1], "reader@example.com");
  assert.match(
    queries[1].statement,
    /ON CONFLICT \(owner_email, article_id, request_id, role\)/,
  );
  assert.match(queries[1].statement, /status = 'error'/);
  assert.equal(queries[1].params[5], "gpt-5.6-sol");
  assert.match(queries[1].statement, /updated_at < now\(\) - INTERVAL '2 minutes'/);
});

test("detects a request ID rebound before creating an assistant placeholder", async () => {
  let queryCount = 0;
  const repository = new PostgresDiscussionRepository({
    async query(statement) {
      queryCount += 1;
      const normalized = normalizeQuery(statement);

      if (normalized.startsWith("INSERT INTO article_discussion_messages")) {
        return [];
      }

      if (normalized.startsWith("SELECT") && normalized.includes("role = $4")) {
        return [
          row({
            role: "user",
            status: "complete",
            content: "Original question",
            scope: "whole",
          }),
        ];
      }

      throw new Error(`Unexpected query: ${normalized}`);
    },
  });

  const result = await repository.claimTurn({
    ownerEmail: "reader@example.com",
    articleId: "article-1",
    requestId: "turn-reused",
    message: "Changed question",
    scope: "whole",
    model: "gpt-5.6-sol",
  });

  assert.deepEqual(result, { kind: "conflict" });
  assert.equal(queryCount, 2);
});

test("a stale duplicate is failed without claiming a second model attempt", async () => {
  let queryCount = 0;
  const repository = new PostgresDiscussionRepository({
    async query(statement, params) {
      queryCount += 1;
      const normalized = normalizeQuery(statement);

      if (normalized.includes("FROM articles AS article")) {
        return [
          row({
            id: params[0],
            requestId: params[3],
            role: "user",
            status: "complete",
            content: params[4],
            scope: params[5],
            createdAt: params[7],
            updatedAt: params[7],
          }),
        ];
      }

      if (normalized.startsWith("INSERT INTO article_discussion_messages")) {
        return [
          {
            ...row({
              role: "assistant",
              status: "error",
              content: "",
              model: params[5],
              createdAt: params[6],
              updatedAt: params[6],
            }),
            error_code: "internal",
          },
        ];
      }

      throw new Error(`Unexpected query: ${normalized}`);
    },
  });

  const result = await repository.claimTurn({
    ownerEmail: "reader@example.com",
    articleId: "article-1",
    requestId: "turn-stale",
    message: "Question",
    scope: "whole",
    model: "gpt-5.6-sol",
  });

  assert.equal(result.kind, "existing");
  assert.equal(result.assistant.status, "error");
  assert.equal(result.attemptId, undefined);
  assert.equal(queryCount, 2);
});

test("model history is owner-scoped, completed-pair-only, and bounded", async () => {
  let captured;
  const repository = new PostgresDiscussionRepository({
    async query(statement, params) {
      captured = { statement: normalizeQuery(statement), params };
      return Array.from({ length: 7 }, (_, index) => ({
        sequence: index + 1,
        role: index % 2 === 0 ? "user" : "assistant",
        content: String(index).repeat(4_000),
      }));
    },
  });

  const history = await repository.listModelHistory(
    " Reader@Example.com ",
    "article-1",
  );

  assert.equal(history.length, 6);
  assert.equal(history.reduce((sum, item) => sum + item.content.length, 0), 24_000);
  assert.equal(history[0].content[0], "1");
  assert.equal(history.at(-1).content[0], "6");
  assert.deepEqual(captured.params.slice(0, 2), [
    "reader@example.com",
    "article-1",
  ]);
  assert.match(captured.statement, /completed_assistant\.status = 'complete'/);
  assert.match(captured.statement, /ORDER BY message\.sequence DESC LIMIT \$3/);
});

test("completed replies retain model, response, usage, and context metadata", async () => {
  let captured;
  const repository = new PostgresDiscussionRepository({
    async query(statement, params) {
      captured = { statement: normalizeQuery(statement), params };
      return [
        {
          ...row({
            role: "assistant",
            status: "complete",
            content: params[4],
            model: params[6],
            updatedAt: params[16],
          }),
          response_id: params[5],
          incomplete: params[7],
          input_tokens: params[8],
          output_tokens: params[9],
          total_tokens: params[10],
          context_scope: params[11],
          context_truncated: params[12],
          context_original_characters: params[13],
          context_included_characters: params[14],
          context_note: params[15],
        },
      ];
    },
  });

  const completed = await repository.completeAssistant({
    ownerEmail: "reader@example.com",
    articleId: "article-1",
    requestId: "turn-1",
    attemptId: "attempt-1",
    reply: "Stored answer.",
    responseId: "resp-1",
    model: "gpt-5.6-sol-2026-07-01",
    incomplete: false,
    usage: {
      inputTokens: 100,
      outputTokens: 20,
      totalTokens: 120,
    },
    context: {
      scope: "selection",
      truncated: false,
      originalCharacters: 55,
      includedCharacters: 55,
      note: "Selected passage",
    },
  });

  assert.equal(completed.responseId, "resp-1");
  assert.equal(completed.model, "gpt-5.6-sol-2026-07-01");
  assert.deepEqual(completed.usage, {
    inputTokens: 100,
    outputTokens: 20,
    totalTokens: 120,
  });
  assert.deepEqual(completed.context, {
    scope: "selection",
    truncated: false,
    originalCharacters: 55,
    includedCharacters: 55,
    note: "Selected passage",
  });
  assert.match(captured.statement, /AND attempt_id = \$4/);
});

test("an abandoned pending row is surfaced as a safe failed turn", async () => {
  const repository = new PostgresDiscussionRepository({
    async query() {
      return [
        row({
          role: "assistant",
          status: "pending",
          content: "",
          model: "gpt-5.6-sol",
          createdAt: "2000-01-01T00:00:00.000Z",
          updatedAt: "2000-01-01T00:00:00.000Z",
        }),
      ];
    },
  });

  const result = await repository.listArticleMessages(
    "reader@example.com",
    "article-1",
  );

  assert.equal(result.messages[0].status, "error");
  assert.equal(result.messages[0].errorCode, "internal");
  assert.equal(result.messages[0].model, "gpt-5.6-sol");
});

function row({
  id = "message-1",
  requestId = "turn-1",
  role,
  status,
  content,
  scope = null,
  selection = null,
  attemptId = null,
  model = null,
  createdAt = "2026-08-02T12:00:00.000Z",
  updatedAt = "2026-08-02T12:00:01.000Z",
}) {
  return {
    sequence: role === "user" ? "1" : "2",
    id,
    request_id: requestId,
    role,
    status,
    content,
    scope,
    selection_text: selection,
    attempt_id: attemptId,
    response_id: null,
    model,
    incomplete: null,
    input_tokens: null,
    output_tokens: null,
    total_tokens: null,
    context_scope: null,
    context_truncated: null,
    context_original_characters: null,
    context_included_characters: null,
    context_note: null,
    error_code: null,
    created_at: createdAt,
    updated_at: updatedAt,
  };
}

function normalizeQuery(statement) {
  return statement.replace(/\s+/g, " ").trim();
}

function resolveSourceFile(basePath) {
  for (const candidate of [basePath, `${basePath}.ts`, `${basePath}.tsx`]) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
      return candidate;
    }
  }

  return undefined;
}
