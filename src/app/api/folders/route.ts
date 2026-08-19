import { NextResponse } from "next/server";
import {
  createArticleFolder,
  listArticleFolders,
} from "@/server/articles/articleService";
import { wakeNarrationPolicyForOwnerBestEffort } from "@/server/articles/narrationPolicyScheduler";
import { requireAppUser } from "@/server/auth/access";

export const runtime = "nodejs";

export async function GET() {
  const auth = await requireAppUser();

  if (auth.response) {
    return auth.response;
  }

  const folders = await listArticleFolders(auth.user.ownerEmail);
  await wakeNarrationPolicyForOwnerBestEffort(auth.user.ownerEmail);
  return NextResponse.json({ folders });
}

export async function POST(request: Request) {
  const auth = await requireAppUser();

  if (auth.response) {
    return auth.response;
  }

  try {
    const body = (await request.json()) as { name?: unknown };

    if (typeof body.name !== "string") {
      throw new Error("Folder name is required.");
    }

    const folder = await createArticleFolder(body.name, auth.user.ownerEmail);
    return NextResponse.json({ folder }, { status: 201 });
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : "Could not create folder.",
      },
      { status: 400 },
    );
  }
}
