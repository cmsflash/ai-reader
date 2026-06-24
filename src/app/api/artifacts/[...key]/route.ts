import { NextResponse } from "next/server";
import { getArtifactStorage } from "@/server/runtime/artifactStorage";

export const runtime = "nodejs";

type RouteContext = {
  params: Promise<{
    key: string[];
  }>;
};

export async function GET(_request: Request, context: RouteContext) {
  const { key } = await context.params;
  const artifact = await getArtifactStorage().get(key.join("/"));

  if (!artifact) {
    return NextResponse.json({ error: "Artifact not found." }, { status: 404 });
  }

  return new Response(new Uint8Array(artifact.body), {
    headers: {
      "cache-control": "public, max-age=31536000, immutable",
      "content-length": artifact.byteLength.toString(),
      "content-type": artifact.contentType,
    },
  });
}
