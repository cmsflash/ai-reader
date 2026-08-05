import { NextResponse } from "next/server";
import { getSavedArticle } from "@/server/articles/articleService";
import {
  DiscussionInputError,
  parseDiscussionArticleId,
  parseDiscussionRequest,
} from "@/server/ai/articleDiscussion";
import {
  aiRouteErrorResponse,
  requireSameOriginResponse,
} from "@/server/ai/routeSecurity";
import { requireAppUser } from "@/server/auth/access";
import {
  discussionReplyFromStoredMessage,
  executeDiscussionTurn,
} from "@/server/discussions/discussionService";
import { getDiscussionRepository } from "@/server/runtime/discussionRepository";

export const runtime = "nodejs";
export const maxDuration = 60;

const maxDiscussionRequestBytes = 128 * 1024;

export async function GET(request: Request) {
  const auth = await requireAppUser();

  if (auth.response) {
    return auth.response;
  }

  try {
    const articleId = parseDiscussionArticleId(
      new URL(request.url).searchParams.get("articleId"),
    );
    const article = await getSavedArticle(articleId, auth.user.ownerEmail);

    if (!article) {
      return NextResponse.json({ error: "Article not found." }, { status: 404 });
    }

    const result = await getDiscussionRepository().listArticleMessages(
      auth.user.ownerEmail,
      articleId,
    );

    return NextResponse.json(
      {
        articleId,
        ...result,
      },
      {
        headers: {
          "cache-control": "no-store",
        },
      },
    );
  } catch (error) {
    return aiRouteErrorResponse(error);
  }
}

export async function POST(request: Request) {
  const auth = await requireAppUser();

  if (auth.response) {
    return auth.response;
  }

  const originError = requireSameOriginResponse(request);

  if (originError) {
    return originError;
  }

  if (!(request.headers.get("content-type") ?? "").includes("application/json")) {
    return NextResponse.json(
      { error: "Content-Type must be application/json." },
      { status: 415 },
    );
  }

  try {
    const discussion = parseDiscussionRequest(
      await readBoundedJson(request, maxDiscussionRequestBytes),
    );
    const article = await getSavedArticle(
      discussion.articleId,
      auth.user.ownerEmail,
    );

    if (!article) {
      return NextResponse.json({ error: "Article not found." }, { status: 404 });
    }

    const result = await executeDiscussionTurn({
      ownerEmail: auth.user.ownerEmail,
      safetySource: auth.user.userId ?? auth.user.email,
      article,
      request: discussion,
    });

    if (result.status === "pending") {
      return NextResponse.json(
        {
          requestId: result.requestId,
          status: "pending",
        },
        {
          status: 202,
          headers: {
            "cache-control": "no-store",
          },
        },
      );
    }

    if (result.status === "error") {
      return NextResponse.json(
        {
          requestId: result.requestId,
          status: "error",
          error: "This discussion turn did not complete. Please send it again.",
        },
        {
          status: 409,
          headers: {
            "cache-control": "no-store",
          },
        },
      );
    }

    return NextResponse.json(
      {
        requestId: result.requestId,
        status: "complete",
        ...discussionReplyFromStoredMessage(result.assistant),
        replayed: result.replayed,
      },
      {
        headers: {
          "cache-control": "no-store",
        },
      },
    );
  } catch (error) {
    return aiRouteErrorResponse(error);
  }
}

async function readBoundedJson(request: Request, maximumBytes: number) {
  const declaredLength = Number(request.headers.get("content-length"));

  if (Number.isFinite(declaredLength) && declaredLength > maximumBytes) {
    throw new DiscussionInputError("The request body is too large.", 413);
  }

  if (!request.body) {
    throw new DiscussionInputError("A JSON request body is required.");
  }

  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = "";

  while (true) {
    const { done, value } = await reader.read();

    if (done) {
      break;
    }

    bytes += value.byteLength;

    if (bytes > maximumBytes) {
      await reader.cancel().catch(() => undefined);
      throw new DiscussionInputError("The request body is too large.", 413);
    }

    text += decoder.decode(value, { stream: true });
  }

  text += decoder.decode();

  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new DiscussionInputError("A valid JSON request body is required.");
  }
}
