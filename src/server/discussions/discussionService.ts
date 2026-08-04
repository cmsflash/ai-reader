import type { Article } from "@/lib/types";
import {
  DISCUSSION_MODEL,
  DiscussionInputError,
  buildResponsesRequest,
  createArticleDiscussionContext,
  type DiscussionRequest,
} from "@/server/ai/articleDiscussion";
import {
  OpenAIServiceError,
  requestDiscussionReply,
  type DiscussionReply,
} from "@/server/ai/openAiTransport";
import {
  DiscussionPersistenceError,
  type DiscussionContextMetadata,
  type DiscussionFailureCode,
  type DiscussionRepository,
  type StoredDiscussionMessage,
} from "@/server/ports/discussionRepository";
import { getDiscussionRepository } from "@/server/runtime/discussionRepository";

export type DiscussionExecutionResult =
  | {
      status: "complete";
      requestId: string;
      assistant: StoredDiscussionMessage;
      replayed: boolean;
    }
  | {
      status: "pending";
      requestId: string;
      assistant: StoredDiscussionMessage;
    }
  | {
      status: "error";
      requestId: string;
      assistant: StoredDiscussionMessage;
    };

type ExecuteDiscussionOptions = {
  repository?: DiscussionRepository;
  generate?: typeof requestDiscussionReply;
};

export async function executeDiscussionTurn(
  input: {
    ownerEmail: string;
    safetySource: string;
    article: Article;
    request: DiscussionRequest;
  },
  options: ExecuteDiscussionOptions = {},
): Promise<DiscussionExecutionResult> {
  const repository = options.repository ?? getDiscussionRepository();
  const generate = options.generate ?? requestDiscussionReply;
  const context = createArticleDiscussionContext(
    input.article,
    input.request.scope,
    input.request.selection,
  );
  const contextMetadata = discussionContextMetadata(context);
  const claim = await repository.claimTurn({
    ownerEmail: input.ownerEmail,
    articleId: input.article.id,
    requestId: input.request.requestId,
    message: input.request.message,
    scope: input.request.scope,
    selection: input.request.scope === "selection" ? context.content : undefined,
    model: DISCUSSION_MODEL,
  });

  if (claim.kind === "missing-article") {
    throw new DiscussionInputError("Article not found.", 404);
  }

  if (claim.kind === "conflict") {
    throw new DiscussionInputError(
      "requestId has already been used for a different discussion turn.",
      409,
    );
  }

  if (claim.kind === "existing") {
    if (claim.assistant.status === "complete") {
      return {
        status: "complete",
        requestId: input.request.requestId,
        assistant: withContextFallback(claim.assistant, contextMetadata),
        replayed: true,
      };
    }

    return {
      status: claim.assistant.status,
      requestId: input.request.requestId,
      assistant: claim.assistant,
    };
  }

  if (!claim.attemptId) {
    throw new DiscussionPersistenceError();
  }

  try {
    const history = await repository.listModelHistory(
      input.ownerEmail,
      input.article.id,
    );
    const reply = await generate(
      buildResponsesRequest(input.request, context, history),
      input.safetySource,
    );
    const assistant = await repository.completeAssistant({
      ownerEmail: input.ownerEmail,
      articleId: input.article.id,
      requestId: input.request.requestId,
      attemptId: claim.attemptId,
      reply: reply.reply,
      responseId: reply.responseId,
      model: reply.model ?? DISCUSSION_MODEL,
      incomplete: reply.incomplete,
      usage: reply.usage,
      context: contextMetadata,
    });

    if (!assistant) {
      throw new DiscussionPersistenceError();
    }

    return {
      status: "complete",
      requestId: input.request.requestId,
      assistant,
      replayed: false,
    };
  } catch (error) {
    await repository
      .failAssistant({
        ownerEmail: input.ownerEmail,
        articleId: input.article.id,
        requestId: input.request.requestId,
        attemptId: claim.attemptId,
        errorCode: discussionFailureCode(error),
      })
      .catch(() => undefined);
    throw error;
  }
}

function discussionContextMetadata(
  context: ReturnType<typeof createArticleDiscussionContext>,
): DiscussionContextMetadata {
  return {
    scope: context.scope,
    truncated: context.truncated,
    originalCharacters: context.originalCharacters,
    includedCharacters: context.includedCharacters,
    ...(context.note ? { note: context.note } : {}),
  };
}

function withContextFallback(
  assistant: StoredDiscussionMessage,
  context: DiscussionContextMetadata,
) {
  return assistant.context ? assistant : { ...assistant, context };
}

function discussionFailureCode(error: unknown): DiscussionFailureCode {
  return error instanceof OpenAIServiceError ? error.kind : "internal";
}

export function discussionReplyFromStoredMessage(
  message: StoredDiscussionMessage,
): DiscussionReply & {
  model?: string;
  context?: DiscussionContextMetadata;
} {
  return {
    reply: message.content,
    ...(message.responseId ? { responseId: message.responseId } : {}),
    ...(message.model ? { model: message.model } : {}),
    incomplete: message.incomplete ?? false,
    ...(message.usage ? { usage: message.usage } : {}),
    ...(message.context ? { context: message.context } : {}),
  };
}
