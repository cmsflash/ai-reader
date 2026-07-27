import { NextResponse } from "next/server";
import {
  requireAppUser,
  requireIntegrationOwnerResponse,
} from "@/server/auth/access";
import {
  getInstapaperConfigurationStatus,
  InstapaperApiError,
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

  const ownerError = requireIntegrationOwnerResponse(auth.user.email);

  if (ownerError) {
    return ownerError;
  }

  const configuration = getInstapaperConfigurationStatus();

  if (!configuration.configured) {
    return NextResponse.json(
      { error: "Instapaper is not configured yet." },
      { status: 503 },
    );
  }

  let body: {
    folder?: string;
    batchSize?: number;
  };

  try {
    body = (await request.json()) as {
      folder?: string;
      batchSize?: number;
    };
  } catch {
    return NextResponse.json(
      { error: "Request body must be valid JSON." },
      { status: 400 },
    );
  }

  let folder: InstapaperBookmarkListInput["folderId"];

  try {
    folder = normalizeFolder(body.folder);
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Choose a valid Instapaper folder.",
      },
      { status: 400 },
    );
  }

  try {
    const result = await syncInstapaperArticles({
      ownerEmail: auth.user.email,
      folder,
      batchSize: body.batchSize,
    });

    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof InstapaperApiError) {
      const status =
        error.status === 429 || error.apiCode === 1040
          ? 429
          : error.kind === "configuration"
            ? 503
            : 502;

      return NextResponse.json(
        { error: error.message },
        { status },
      );
    }

    return NextResponse.json(
      { error: "Could not sync Instapaper." },
      { status: 500 },
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
