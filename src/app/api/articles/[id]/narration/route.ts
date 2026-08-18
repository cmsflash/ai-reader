import { NextResponse } from "next/server";
import { requireAppUser } from "@/server/auth/access";
import {
  generatePilotArticleNarration,
  PilotNarrationError,
  verifyPilotNarrationModelAccess,
} from "@/server/articles/articleNarrationPilot";
import { getArticleRepository } from "@/server/runtime/articleRepository";
import { getArtifactStorage } from "@/server/runtime/artifactStorage";

export const runtime = "nodejs";
export const maxDuration = 300;

type RouteContext = {
  params: Promise<{
    id: string;
  }>;
};

export async function GET(_request: Request, context: RouteContext) {
  const auth = await requireAppUser();

  if (auth.response) {
    return auth.response;
  }

  try {
    const { id } = await context.params;
    const result = await verifyPilotNarrationModelAccess(
      id,
      auth.user.ownerEmail,
    );

    return NextResponse.json(
      { ok: true, model: result.model },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (error) {
    return narrationErrorResponse(error);
  }
}

export async function POST(_request: Request, context: RouteContext) {
  const auth = await requireAppUser();

  if (auth.response) {
    return auth.response;
  }

  try {
    const { id } = await context.params;
    const result = await generatePilotArticleNarration(
      id,
      auth.user.ownerEmail,
      {
        articleRepository: getArticleRepository(),
        artifactStorage: getArtifactStorage(),
      },
    );

    return NextResponse.json(
      {
        narration: result.narration,
        alreadyExisted: result.alreadyExisted,
        qa: result.qa,
        estimatedCostUsd: result.estimatedCostUsd,
      },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (error) {
    return narrationErrorResponse(error);
  }
}

function narrationErrorResponse(error: unknown) {
  const status = error instanceof PilotNarrationError ? error.status : 500;
  return NextResponse.json(
    {
      error:
        error instanceof PilotNarrationError
          ? error.message
          : "Could not generate article narration.",
    },
    { status, headers: { "cache-control": "no-store" } },
  );
}
