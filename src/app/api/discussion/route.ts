import { NextResponse } from "next/server";
import { getSavedArticle } from "@/server/articles/articleService";
import {
  buildResponsesRequest,
  createArticleDiscussionContext,
  parseDiscussionRequest,
} from "@/server/ai/articleDiscussion";
import { requestDiscussionReply } from "@/server/ai/openAiTransport";
import {
  aiRouteErrorResponse,
  requireSameOriginResponse,
} from "@/server/ai/routeSecurity";
import { requireAppUser } from "@/server/auth/access";

export const runtime = "nodejs";
export const maxDuration = 60;

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
    const discussion = parseDiscussionRequest(await request.json());
    const article = await getSavedArticle(discussion.articleId, auth.user.email);

    if (!article) {
      return NextResponse.json({ error: "Article not found." }, { status: 404 });
    }

    const context = createArticleDiscussionContext(
      article,
      discussion.scope,
      discussion.selection,
    );
    const result = await requestDiscussionReply(
      buildResponsesRequest(discussion, context),
      auth.user.userId ?? auth.user.email,
    );

    return NextResponse.json(
      {
        ...result,
        context: {
          scope: context.scope,
          truncated: context.truncated,
          originalCharacters: context.originalCharacters,
          includedCharacters: context.includedCharacters,
          note: context.note,
        },
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
