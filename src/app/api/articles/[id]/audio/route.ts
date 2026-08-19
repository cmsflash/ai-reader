import { NextResponse } from "next/server";
import { requireAppUser } from "@/server/auth/access";
import { getSavedArticleNarrationArtifact } from "@/server/articles/articleService";
import { articleNarrationResponse } from "@/server/articles/articleNarrationResponse";

export const runtime = "nodejs";

type RouteContext = {
  params: Promise<{
    id: string;
  }>;
};

export async function GET(request: Request, context: RouteContext) {
  const auth = await requireAppUser();

  if (auth.response) {
    return auth.response;
  }

  const { id } = await context.params;
  const segmentValue = new URL(request.url).searchParams.get("segment");
  const segmentIndex =
    segmentValue === null || segmentValue === ""
      ? undefined
      : Number(segmentValue);

  if (
    typeof segmentIndex === "number" &&
    (!Number.isSafeInteger(segmentIndex) || segmentIndex < 0)
  ) {
    return NextResponse.json(
      { error: "Invalid narration segment." },
      { status: 400 },
    );
  }

  const result = await getSavedArticleNarrationArtifact(
    id,
    auth.user.ownerEmail,
    {},
    segmentIndex,
  );

  if (!result) {
    return NextResponse.json(
      { error: "Article narration not found." },
      { status: 404 },
    );
  }

  return articleNarrationResponse(
    result.artifact,
    request.headers.get("range"),
  );
}
