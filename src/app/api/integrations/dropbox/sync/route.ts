import { NextResponse } from "next/server";
import {
  requireAppUser,
  requireIntegrationOwnerResponse,
} from "@/server/auth/access";
import {
  DropboxClientError,
  getDropboxConfiguredStatus,
} from "@/server/integrations/dropboxClient";
import { syncDropboxAtVoiceArticles } from "@/server/integrations/providerSync";
import { ProviderSyncAlreadyRunningError } from "@/server/integrations/providerSyncLock";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(request: Request) {
  const auth = await requireAppUser();

  if (auth.response) {
    return auth.response;
  }

  const ownerError = requireIntegrationOwnerResponse(auth.user.ownerEmail);

  if (ownerError) {
    return ownerError;
  }

  const configuration = getDropboxConfiguredStatus();

  if (!configuration.configured) {
    return NextResponse.json(
      { error: "Dropbox @Voice sync is not configured yet." },
      { status: 503 },
    );
  }

  let body: {
    batchSize?: number;
  };

  try {
    body = (await request.json()) as {
      batchSize?: number;
    };
  } catch {
    return NextResponse.json(
      { error: "Request body must be valid JSON." },
      { status: 400 },
    );
  }

  try {
    const result = await syncDropboxAtVoiceArticles({
      ownerEmail: auth.user.ownerEmail,
      batchSize: body.batchSize,
    });

    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof ProviderSyncAlreadyRunningError) {
      return NextResponse.json(
        { error: error.message },
        { status: 409 },
      );
    }

    if (error instanceof DropboxClientError) {
      return NextResponse.json(
        { error: error.message },
        { status: error.status === 429 ? 429 : 502 },
      );
    }

    return NextResponse.json(
      { error: "Could not sync @Voice from Dropbox." },
      { status: 500 },
    );
  }
}
