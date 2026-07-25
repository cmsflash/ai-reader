import { NextResponse } from "next/server";
import { requireAppUser } from "@/server/auth/access";
import {
  getInstapaperConfigurationStatus,
  type InstapaperBookmarkListInput,
} from "@/server/integrations/instapaperClient";
import { syncInstapaperArticles } from "@/server/integrations/providerSync";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(request: Request) {
  const auth = await requireAppUser();

  if (auth.response) {
    return auth.response;
  }

  const configuration = getInstapaperConfigurationStatus();

  if (!configuration.configured) {
    return NextResponse.json(
      { error: "Instapaper is not configured yet." },
      { status: 503 },
    );
  }

  try {
    const body = (await request.json().catch(() => ({}))) as {
      folder?: string;
      batchSize?: number;
    };
    const folder = normalizeFolder(body.folder);
    const result = await syncInstapaperArticles({
      ownerEmail: auth.user.email,
      folder,
      batchSize: body.batchSize,
    });

    return NextResponse.json(result);
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Could not sync Instapaper.",
      },
      { status: 400 },
    );
  }
}

function normalizeFolder(
  value?: string,
): InstapaperBookmarkListInput["folderId"] {
  const folder = value?.trim() || "unread";

  if (
    !["unread", "starred", "archive"].includes(folder) &&
    !/^[1-9]\d*$/.test(folder)
  ) {
    throw new Error("Choose a valid Instapaper folder.");
  }

  return folder;
}
