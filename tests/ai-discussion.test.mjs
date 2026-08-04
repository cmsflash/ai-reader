import assert from "node:assert/strict";
import test from "node:test";
import {
  DISCUSSION_MODEL,
  DiscussionInputError,
  MAX_ARTICLE_CONTEXT_CHARACTERS,
  REALTIME_DISCUSSION_MODEL,
  buildRealtimeSession,
  buildResponsesRequest,
  createArticleDiscussionContext,
  parseDiscussionRequest,
  parseRealtimeDiscussionCallForm,
} from "../src/server/ai/articleDiscussion.ts";
import {
  OpenAIServiceError,
  createSafetyIdentifier,
  initiateRealtimeDiscussionCall,
  requestDiscussionReply,
} from "../src/server/ai/openAiTransport.ts";

const apiKey = "server-only-test-key";
const ownerIdentity = "User_123";
const validOffer = [
  "v=0",
  "o=- 1 1 IN IP4 127.0.0.1",
  "s=-",
  "t=0 0",
  "m=audio 9 UDP/TLS/RTP/SAVPF 111",
  "",
].join("\r\n");
const validAnswer = [
  "v=0",
  "o=- 2 2 IN IP4 127.0.0.1",
  "s=-",
  "t=0 0",
  "m=audio 9 UDP/TLS/RTP/SAVPF 111",
  "",
].join("\r\n");

test("parses a client-keyed typed request and ignores browser-supplied history", () => {
  assert.deepEqual(
    parseDiscussionRequest({
      requestId: "turn-123",
      articleId: "article-1",
      scope: "selection",
      selection: "Selected sentence.",
      message: "Explain this.",
      history: [
        { role: "user", content: "What does it mean?" },
        { role: "assistant", content: "It describes a constraint." },
      ],
    }),
    {
      requestId: "turn-123",
      articleId: "article-1",
      scope: "selection",
      selection: "Selected sentence.",
      message: "Explain this.",
    },
  );

  assert.throws(
    () =>
      parseDiscussionRequest({
        requestId: "turn-123",
        articleId: "article-1",
        scope: "selection",
        message: "Explain this.",
      }),
    (error) =>
      error instanceof DiscussionInputError &&
      error.message === "selection is required.",
  );

  assert.throws(
    () =>
      parseDiscussionRequest({
        requestId: "turn id with spaces",
        articleId: "article-1",
        scope: "whole",
        message: "Explain this.",
      }),
    (error) =>
      error instanceof DiscussionInputError &&
      error.message.includes("requestId may contain only"),
  );
});

test("selection context must come from the authorized article and excludes other text", () => {
  const article = articleFixture(
    "Material before. The selected   sentence is here. Sensitive material after.",
  );
  const context = createArticleDiscussionContext(
    article,
    "selection",
    "The selected sentence is here.",
  );
  const request = parseDiscussionRequest({
    requestId: "turn-selection",
    articleId: article.id,
    scope: "selection",
    selection: "The selected sentence is here.",
    message: "Explain this selection.",
  });
  const payload = buildResponsesRequest(request, context);
  const serialized = JSON.stringify(payload);

  assert.equal(context.content, "The selected sentence is here.");
  assert.equal(serialized.includes("Sensitive material after"), false);
  assert.equal(serialized.includes("Material before"), false);
  assert.equal(payload.model, DISCUSSION_MODEL);
  assert.deepEqual(payload.reasoning, { effort: "medium" });
  assert.equal(payload.store, false);

  assert.throws(
    () =>
      createArticleDiscussionContext(
        article,
        "selection",
        "Text supplied by the browser but absent from the article.",
      ),
    (error) =>
      error instanceof DiscussionInputError &&
      error.message === "selection must come from the requested article.",
  );
});

test("whole-article context is complete within the bound and reports truncation above it", () => {
  const complete = createArticleDiscussionContext(
    articleFixture("Short complete article."),
    "whole",
  );

  assert.equal(complete.content, "Short complete article.");
  assert.equal(complete.truncated, false);
  assert.equal(complete.note, undefined);

  const longText = `${"a".repeat(MAX_ARTICLE_CONTEXT_CHARACTERS)}omitted`;
  const truncated = createArticleDiscussionContext(
    articleFixture(longText),
    "whole",
  );

  assert.equal(truncated.truncated, true);
  assert.equal(truncated.content.length, MAX_ARTICLE_CONTEXT_CHARACTERS);
  assert.equal(truncated.content.includes("omitted"), false);
  assert.equal(truncated.originalCharacters, longText.length);
  assert.match(truncated.note, /omitted the remainder/);
});

test("Responses transport keeps credentials in the authorization header and returns typed text", async () => {
  const request = buildResponsesRequest(
    parseDiscussionRequest({
      requestId: "turn-transport",
      articleId: "article-1",
      scope: "whole",
      message: "Summarize this.",
    }),
    createArticleDiscussionContext(articleFixture("Article content."), "whole"),
  );
  let capturedUrl;
  let capturedInit;

  const result = await requestDiscussionReply(request, ownerIdentity, {
    apiKey,
    fetch: async (url, init) => {
      capturedUrl = url;
      capturedInit = init;
      return Response.json({
        id: "resp_123",
        status: "completed",
        output: [
          {
            type: "message",
            content: [{ type: "output_text", text: "Grounded reply." }],
          },
        ],
        usage: {
          input_tokens: 101,
          output_tokens: 12,
          total_tokens: 113,
        },
      });
    },
  });

  assert.equal(capturedUrl, "https://api.openai.com/v1/responses");
  const headers = new Headers(capturedInit.headers);
  assert.equal(headers.get("authorization"), `Bearer ${apiKey}`);
  assert.equal(String(capturedInit.body).includes(apiKey), false);
  const sent = JSON.parse(capturedInit.body);
  assert.equal(sent.model, "gpt-5.6-sol");
  assert.deepEqual(sent.reasoning, { effort: "medium" });
  assert.equal(sent.store, false);
  assert.equal(sent.safety_identifier, createSafetyIdentifier(ownerIdentity));
  assert.deepEqual(result, {
    reply: "Grounded reply.",
    responseId: "resp_123",
    incomplete: false,
    usage: {
      inputTokens: 101,
      outputTokens: 12,
      totalTokens: 113,
    },
  });
});

test("Responses transport does not expose API keys through upstream errors", async () => {
  await assert.rejects(
    () =>
      requestDiscussionReply(
        buildResponsesRequest(
          parseDiscussionRequest({
            requestId: "turn-error",
            articleId: "article-1",
            scope: "whole",
            message: "Question",
          }),
          createArticleDiscussionContext(
            articleFixture("Article content."),
            "whole",
          ),
        ),
        ownerIdentity,
        {
          apiKey,
          fetch: async () =>
            Response.json(
              {
                error: {
                  message: `Rejected credential ${apiKey}`,
                },
              },
              { status: 401 },
            ),
        },
      ),
    (error) => {
      assert.ok(error instanceof OpenAIServiceError);
      assert.equal(error.kind, "upstream");
      assert.equal(error.status, 401);
      assert.equal(error.message.includes(apiKey), false);
      return true;
    },
  );
});

test("Responses transport recognizes the purpose-scoped local shell key", async () => {
  const previousPurposeKey = process.env.OPENAI_API_KEY_AI_READER;
  const previousStandardKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY_AI_READER = apiKey;
  delete process.env.OPENAI_API_KEY;

  try {
    const result = await requestDiscussionReply(
      buildResponsesRequest(
        parseDiscussionRequest({
          requestId: "turn-shell-key",
          articleId: "article-1",
          scope: "whole",
          message: "Question",
        }),
        createArticleDiscussionContext(
          articleFixture("Article content."),
          "whole",
        ),
      ),
      ownerIdentity,
      {
        fetch: async (_url, init) => {
          assert.equal(
            new Headers(init.headers).get("authorization"),
            `Bearer ${apiKey}`,
          );
          return Response.json({
            status: "completed",
            output: [
              {
                type: "message",
                content: [{ type: "output_text", text: "Grounded reply." }],
              },
            ],
          });
        },
      },
    );

    assert.equal(result.reply, "Grounded reply.");
  } finally {
    restoreEnvironmentVariable(
      "OPENAI_API_KEY_AI_READER",
      previousPurposeKey,
    );
    restoreEnvironmentVariable("OPENAI_API_KEY", previousStandardKey);
  }
});

test("Responses transport returns a model refusal as a safe discussion reply", async () => {
  const result = await requestDiscussionReply(
    buildResponsesRequest(
      parseDiscussionRequest({
        requestId: "turn-refusal",
        articleId: "article-1",
        scope: "whole",
        message: "Question",
      }),
      createArticleDiscussionContext(
        articleFixture("Article content."),
        "whole",
      ),
    ),
    ownerIdentity,
    {
      apiKey,
      fetch: async () =>
        Response.json({
          id: "resp_refusal",
          status: "completed",
          output: [
            {
              type: "message",
              content: [
                {
                  type: "refusal",
                  refusal: "I can’t help with that request.",
                },
              ],
            },
          ],
        }),
    },
  );

  assert.equal(result.reply, "I can’t help with that request.");
});

test("Realtime call parser and transport use the unified calls endpoint with server-owned config", async () => {
  const incoming = new FormData();
  incoming.set("articleId", "article-1");
  incoming.set("scope", "selection");
  incoming.set("selection", "Article content.");
  incoming.set("sdp", validOffer);
  const call = parseRealtimeDiscussionCallForm(incoming);
  const context = createArticleDiscussionContext(
    articleFixture("Article content. Other private text."),
    call.scope,
    call.selection,
  );
  const session = buildRealtimeSession(context);
  let capturedUrl;
  let capturedInit;

  const answer = await initiateRealtimeDiscussionCall(
    call.sdp,
    session,
    ownerIdentity,
    {
      apiKey,
      fetch: async (url, init) => {
        capturedUrl = url;
        capturedInit = init;
        return new Response(validAnswer, {
          status: 201,
          headers: {
            "content-type": "application/sdp",
          },
        });
      },
    },
  );

  assert.equal(answer, validAnswer);
  assert.equal(capturedUrl, "https://api.openai.com/v1/realtime/calls");
  const headers = new Headers(capturedInit.headers);
  assert.equal(headers.get("authorization"), `Bearer ${apiKey}`);
  assert.equal(headers.has("content-type"), false);
  assert.ok(capturedInit.body instanceof FormData);
  const sentSdp = capturedInit.body.get("sdp");
  const sentSession = capturedInit.body.get("session");
  assert.equal(sentSdp, validOffer);
  assert.equal(typeof sentSession, "string");
  const sessionPayload = JSON.parse(sentSession);
  assert.equal(sessionPayload.model, REALTIME_DISCUSSION_MODEL);
  assert.deepEqual(sessionPayload.reasoning, { effort: "medium" });
  assert.deepEqual(sessionPayload.output_modalities, ["audio"]);
  assert.equal(sessionPayload.tool_choice, "none");
  assert.deepEqual(sessionPayload.tools, []);
  assert.equal(sessionPayload.instructions.includes("Article content."), true);
  assert.equal(sessionPayload.instructions.includes("Other private text."), false);
  assert.equal(sessionPayload.instructions.includes(apiKey), false);
});

test("Realtime call parser rejects non-audio SDP offers", () => {
  const form = new FormData();
  form.set("articleId", "article-1");
  form.set("scope", "whole");
  form.set("sdp", "v=0\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\n");

  assert.throws(
    () => parseRealtimeDiscussionCallForm(form),
    (error) =>
      error instanceof DiscussionInputError &&
      error.message === "sdp must be a valid WebRTC offer with audio.",
  );
});

function articleFixture(textContent) {
  return {
    id: "article-1",
    title: "Example article",
    sourceType: "text",
    createdAt: "2026-07-29T00:00:00.000Z",
    updatedAt: "2026-07-29T00:00:00.000Z",
    wordCount: textContent.split(/\s+/).length,
    estimatedMinutes: 1,
    sentenceCount: 1,
    processingCostUsd: 0,
    progress: {
      sentenceIndex: 0,
      percent: 0,
      updatedAt: "2026-07-29T00:00:00.000Z",
    },
    contentHtml: `<p>${textContent}</p>`,
    textContent,
    blocks: [],
  };
}

function restoreEnvironmentVariable(name, value) {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}
