import { NextResponse } from "next/server";
import { DiscussionInputError } from "@/server/ai/articleDiscussion";
import { OpenAIServiceError } from "@/server/ai/openAiTransport";

export function requireSameOriginResponse(request: Request) {
  const origin = request.headers.get("origin");

  if (!origin) {
    return null;
  }

  let requestOrigin: string;

  try {
    requestOrigin = new URL(request.url).origin;
  } catch {
    return NextResponse.json({ error: "Invalid request URL." }, { status: 400 });
  }

  if (origin !== requestOrigin) {
    return NextResponse.json(
      { error: "Cross-origin requests are not allowed." },
      { status: 403 },
    );
  }

  return null;
}

export function aiRouteErrorResponse(error: unknown) {
  if (error instanceof DiscussionInputError) {
    return NextResponse.json({ error: error.message }, { status: error.status });
  }

  if (error instanceof OpenAIServiceError) {
    if (error.kind === "configuration") {
      return NextResponse.json(
        { error: "AI discussion is not configured." },
        { status: 503 },
      );
    }

    if (error.kind === "timeout") {
      return NextResponse.json(
        { error: "AI discussion timed out." },
        { status: 504 },
      );
    }

    if (error.status === 429) {
      return NextResponse.json(
        { error: "AI discussion is temporarily busy." },
        { status: 429 },
      );
    }

    return NextResponse.json(
      { error: "AI discussion is temporarily unavailable." },
      { status: 502 },
    );
  }

  return NextResponse.json(
    { error: "The AI discussion request was invalid." },
    { status: 400 },
  );
}
