import { NextResponse } from "next/server";
import { requireAppUser } from "@/server/auth/access";
import { getArticleRepository } from "@/server/runtime/articleRepository";
import { getTtsProvider } from "@/server/runtime/ttsProvider";

export const runtime = "nodejs";
export const maxDuration = 30;

const maxTextLength = 1200;

export async function POST(request: Request) {
  const auth = await requireAppUser();

  if (auth.response) {
    return auth.response;
  }

  try {
    const body = (await request.json()) as { text?: string; articleId?: string };
    const text = body.text?.replace(/\s+/g, " ").trim();

    if (!text) {
      return NextResponse.json({ error: "Text is required." }, { status: 400 });
    }

    if (text.length > maxTextLength) {
      return NextResponse.json(
        { error: `Text is too long. Keep requests under ${maxTextLength} characters.` },
        { status: 400 },
      );
    }

    const speech = await getTtsProvider().synthesizeSpeech({ text });
    const costUsd = speech.costUsd ?? 0;

    if (body.articleId && costUsd > 0) {
      await getArticleRepository().addProcessingCost(body.articleId, auth.user.email, costUsd);
    }

    return new Response(speech.audio, {
      headers: {
        "content-type": speech.contentType,
        "cache-control": "no-store",
        "x-processing-cost-usd": costUsd.toString(),
      },
    });
  } catch (error) {
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "Could not synthesize speech.",
      },
      { status: 502 },
    );
  }
}
