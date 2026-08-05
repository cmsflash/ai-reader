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

const {
  DISCUSSION_MODEL,
  DiscussionInputError,
  parseDiscussionRequest,
} = await import("../src/server/ai/articleDiscussion.ts");
const { OpenAIServiceError } = await import(
  "../src/server/ai/openAiTransport.ts"
);
const { executeDiscussionTurn } = await import(
  "../src/server/discussions/discussionService.ts"
);

test("persists a claimed turn and generates from server-owned history", async () => {
  const repository = fakeRepository({
    claim: {
      kind: "claimed",
      user: message("user", "complete", "Explain this."),
      assistant: message("assistant", "pending", ""),
      attemptId: "attempt-1",
    },
    history: [
      { role: "user", content: "Earlier question." },
      { role: "assistant", content: "Earlier grounded answer." },
    ],
  });
  let generatedRequest;
  let generatedSafetySource;

  const result = await executeDiscussionTurn(
    {
      ownerEmail: "Reader@Example.com",
      safetySource: "actor-123",
      article: articleFixture(
        "The selected   sentence is here. Unselected material follows.",
      ),
      request: parseDiscussionRequest({
        requestId: "turn-1",
        articleId: "article-1",
        scope: "selection",
        selection: "The selected sentence is here.",
        message: "Explain this.",
        history: [{ role: "user", content: "Browser-injected history." }],
      }),
    },
    {
      repository,
      async generate(request, safetySource) {
        generatedRequest = request;
        generatedSafetySource = safetySource;
        return {
          reply: "A grounded answer.",
          responseId: "resp-1",
          model: "gpt-5.6-sol-2026-07-01",
          incomplete: false,
          usage: {
            inputTokens: 100,
            outputTokens: 20,
            totalTokens: 120,
          },
        };
      },
    },
  );

  assert.equal(result.status, "complete");
  assert.equal(result.replayed, false);
  assert.equal(generatedSafetySource, "actor-123");
  assert.deepEqual(
    generatedRequest.input.slice(1),
    [
      { role: "user", content: "Earlier question." },
      { role: "assistant", content: "Earlier grounded answer." },
      { role: "user", content: "Explain this." },
    ],
  );
  assert.equal(
    JSON.stringify(generatedRequest).includes("Browser-injected history"),
    false,
  );
  assert.deepEqual(repository.calls.claim[0], {
    ownerEmail: "Reader@Example.com",
    articleId: "article-1",
    requestId: "turn-1",
    message: "Explain this.",
    scope: "selection",
    selection: "The selected sentence is here.",
    model: DISCUSSION_MODEL,
  });
  assert.deepEqual(repository.calls.complete[0], {
    ownerEmail: "Reader@Example.com",
    articleId: "article-1",
    requestId: "turn-1",
    attemptId: "attempt-1",
    reply: "A grounded answer.",
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
      originalCharacters: 30,
      includedCharacters: 30,
    },
  });
});

test("replays a completed client request without a second model call", async () => {
  const completed = {
    ...message("assistant", "complete", "Stored answer."),
    responseId: "resp-stored",
    model: DISCUSSION_MODEL,
    incomplete: false,
    context: {
      scope: "whole",
      truncated: false,
      originalCharacters: 16,
      includedCharacters: 16,
    },
  };
  const repository = fakeRepository({
    claim: {
      kind: "existing",
      user: message("user", "complete", "Question"),
      assistant: completed,
    },
  });
  let generationCalls = 0;

  const result = await executeDiscussionTurn(
    {
      ownerEmail: "reader@example.com",
      safetySource: "actor-123",
      article: articleFixture("Article content."),
      request: parseDiscussionRequest({
        requestId: "turn-replay",
        articleId: "article-1",
        scope: "whole",
        message: "Question",
      }),
    },
    {
      repository,
      async generate() {
        generationCalls += 1;
        throw new Error("must not be called");
      },
    },
  );

  assert.equal(result.status, "complete");
  assert.equal(result.replayed, true);
  assert.equal(result.assistant.content, "Stored answer.");
  assert.equal(generationCalls, 0);
  assert.equal(repository.calls.history, 0);
});

test("rejects reuse of a request ID for different content", async () => {
  const repository = fakeRepository({ claim: { kind: "conflict" } });

  await assert.rejects(
    () =>
      executeDiscussionTurn(
        {
          ownerEmail: "reader@example.com",
          safetySource: "actor-123",
          article: articleFixture("Article content."),
          request: parseDiscussionRequest({
            requestId: "turn-conflict",
            articleId: "article-1",
            scope: "whole",
            message: "Changed question",
          }),
        },
        { repository },
      ),
    (error) =>
      error instanceof DiscussionInputError && error.status === 409,
  );
});

test("records only a safe failure code when generation fails", async () => {
  const repository = fakeRepository({
    claim: {
      kind: "claimed",
      user: message("user", "complete", "Question"),
      assistant: message("assistant", "pending", ""),
      attemptId: "attempt-error",
    },
  });
  const unsafeUpstreamMessage = "upstream included a secret credential";

  await assert.rejects(
    () =>
      executeDiscussionTurn(
        {
          ownerEmail: "reader@example.com",
          safetySource: "actor-123",
          article: articleFixture("Article content."),
          request: parseDiscussionRequest({
            requestId: "turn-error",
            articleId: "article-1",
            scope: "whole",
            message: "Question",
          }),
        },
        {
          repository,
          async generate() {
            throw new OpenAIServiceError({
              message: unsafeUpstreamMessage,
              kind: "upstream",
              status: 502,
            });
          },
        },
      ),
    OpenAIServiceError,
  );

  assert.deepEqual(repository.calls.fail[0], {
    ownerEmail: "reader@example.com",
    articleId: "article-1",
    requestId: "turn-error",
    attemptId: "attempt-error",
    errorCode: "upstream",
  });
  assert.equal(JSON.stringify(repository.calls.fail).includes(unsafeUpstreamMessage), false);
});

function fakeRepository({ claim, history = [] }) {
  const calls = {
    claim: [],
    complete: [],
    fail: [],
    history: 0,
  };

  return {
    calls,
    async claimTurn(input) {
      calls.claim.push(input);
      return claim;
    },
    async listModelHistory() {
      calls.history += 1;
      return history;
    },
    async completeAssistant(input) {
      calls.complete.push(input);
      return {
        ...message("assistant", "complete", input.reply),
        responseId: input.responseId,
        model: input.model,
        incomplete: input.incomplete,
        usage: input.usage,
        context: input.context,
      };
    },
    async failAssistant(input) {
      calls.fail.push(input);
      return message("assistant", "error", "");
    },
    async listArticleMessages() {
      return { messages: [], hasMore: false };
    },
  };
}

function message(role, status, content) {
  return {
    sequence: role === "user" ? "1" : "2",
    id: `${role}-message`,
    requestId: "turn-1",
    role,
    status,
    content,
    createdAt: "2026-08-02T12:00:00.000Z",
    updatedAt: "2026-08-02T12:00:01.000Z",
  };
}

function articleFixture(textContent) {
  return {
    id: "article-1",
    title: "Test article",
    sourceType: "url",
    sourceUrl: "https://example.com/article",
    createdAt: "2026-08-02T12:00:00.000Z",
    updatedAt: "2026-08-02T12:00:00.000Z",
    wordCount: textContent.split(/\s+/).length,
    estimatedMinutes: 1,
    sentenceCount: 1,
    processingCostUsd: 0,
    progress: {
      sentenceIndex: 0,
      percent: 0,
      updatedAt: "2026-08-02T12:00:00.000Z",
    },
    contentHtml: `<p>${textContent}</p>`,
    textContent,
    blocks: [{ type: "paragraph", text: textContent }],
  };
}

function resolveSourceFile(basePath) {
  for (const candidate of [basePath, `${basePath}.ts`, `${basePath}.tsx`]) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
      return candidate;
    }
  }

  return undefined;
}
