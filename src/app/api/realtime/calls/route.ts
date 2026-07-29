import { NextResponse } from "next/server";
import { getSavedArticle } from "@/server/articles/articleService";
import {
  buildRealtimeSession,
  createArticleDiscussionContext,
  parseRealtimeDiscussionCallForm,
} from "@/server/ai/articleDiscussion";
import { initiateRealtimeDiscussionCall } from "@/server/ai/openAiTransport";
import {
  aiRouteErrorResponse,
  requireSameOriginResponse,
} from "@/server/ai/routeSecurity";
import { requireAppUser } from "@/server/auth/access";

export const runtime = "nodejs";
export const maxDuration = 30;

const maxIncomingBodyBytes = 320_000;

export async function POST(request: Request) {
  const auth = await requireAppUser();

  if (auth.response) {
    return auth.response;
  }

  const originError = requireSameOriginResponse(request);

  if (originError) {
    return originError;
  }

  if (!(request.headers.get("content-type") ?? "").includes("multipart/form-data")) {
    return NextResponse.json(
      { error: "Content-Type must be multipart/form-data." },
      { status: 415 },
    );
  }

  const contentLength = Number(request.headers.get("content-length"));

  if (Number.isFinite(contentLength) && contentLength > maxIncomingBodyBytes) {
    return NextResponse.json(
      { error: "Realtime call request is too large." },
      { status: 413 },
    );
  }

  try {
    const call = parseRealtimeDiscussionCallForm(await request.formData());
    const article = await getSavedArticle(call.articleId, auth.user.email);

    if (!article) {
      return NextResponse.json({ error: "Article not found." }, { status: 404 });
    }

    const context = createArticleDiscussionContext(
      article,
      call.scope,
      call.selection,
    );
    const answer = await initiateRealtimeDiscussionCall(
      call.sdp,
      buildRealtimeSession(context),
      auth.user.userId ?? auth.user.email,
    );

    return new Response(answer, {
      status: 201,
      headers: {
        "content-type": "application/sdp",
        "cache-control": "no-store",
        "x-ai-reader-context-truncated": String(context.truncated),
        "x-ai-reader-context-original-characters": String(
          context.originalCharacters,
        ),
        "x-ai-reader-context-included-characters": String(
          context.includedCharacters,
        ),
      },
    });
  } catch (error) {
    return aiRouteErrorResponse(error);
  }
}
