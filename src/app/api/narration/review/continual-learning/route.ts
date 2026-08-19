import { NextResponse } from "next/server";
import { start } from "workflow/api";
import { requireAppUser } from "@/server/auth/access";
import {
  continualLearningAudioReviewCurrentArticleId,
  continualLearningAudioReviewOwnerEmail,
  continualLearningAudioReviewSentenceArticleId,
} from "@/server/articles/continualLearningAudioReview";
import { createContinualLearningAudioReview } from "@/workflows/narrationReview/workflow";

export const runtime = "nodejs";

export async function POST() {
  const auth = await requireAppUser();

  if (auth.response) {
    return auth.response;
  }
  if (auth.user.ownerEmail !== continualLearningAudioReviewOwnerEmail) {
    return NextResponse.json({ error: "Not found." }, { status: 404 });
  }

  try {
    const run = await start(createContinualLearningAudioReview, [
      { ownerEmail: auth.user.ownerEmail },
    ]);

    return NextResponse.json(
      {
        ok: true,
        runId: run.runId,
        articleIds: {
          currentAudio: continualLearningAudioReviewCurrentArticleId,
          sentenceAudio: continualLearningAudioReviewSentenceArticleId,
        },
      },
      { status: 202, headers: { "cache-control": "no-store" } },
    );
  } catch (error) {
    console.error("Could not start the narration review workflow.", error);
    return NextResponse.json(
      { error: "Could not start the narration review." },
      { status: 503, headers: { "cache-control": "no-store" } },
    );
  }
}
