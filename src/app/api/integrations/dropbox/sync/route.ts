import { NextResponse } from "next/server";
import { requireAppUser } from "@/server/auth/access";
import { getDropboxConfiguredStatus } from "@/server/integrations/dropboxClient";
import { syncDropboxAtVoiceArticles } from "@/server/integrations/providerSync";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(request: Request) {
  const auth = await requireAppUser();

  if (auth.response) {
    return auth.response;
  }

  const configuration = getDropboxConfiguredStatus();

  if (!configuration.configured) {
    return NextResponse.json(
      { error: "Dropbox @Voice sync is not configured yet." },
      { status: 503 },
    );
  }

  try {
    const body = (await request.json().catch(() => ({}))) as {
      batchSize?: number;
    };
    const result = await syncDropboxAtVoiceArticles({
      ownerEmail: auth.user.email,
      batchSize: body.batchSize,
    });

    return NextResponse.json(result);
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Could not sync @Voice from Dropbox.",
      },
      { status: 400 },
    );
  }
}
