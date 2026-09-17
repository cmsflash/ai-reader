import { NextResponse } from "next/server";
import { start } from "workflow/api";
import { requireAppUser } from "@/server/auth/access";
import { requireImportToken } from "@/server/auth/importToken";
import {
  publicationSources,
  type PublicationSource,
} from "@/server/publications/sources";
import { subscribePublication } from "@/server/publications/sync";
import { syncPublication } from "@/workflows/publications/workflow";
export async function POST(request: Request) {
  const token = requireImportToken(request);
  const auth = token ? null : await requireAppUser();
  if (auth?.response) return auth.response;
  const owner = token?.email ?? auth!.user!.ownerEmail;
  const body = await request.json().catch(() => ({}));
  if (
    typeof body.source !== "string" ||
    !Object.hasOwn(publicationSources, body.source)
  )
    return NextResponse.json(
      { error: "Unknown publication." },
      { status: 400 },
    );
  const source = body.source as PublicationSource;
  const folderId = await subscribePublication(owner, source);
  const run = await start(syncPublication, [owner, source]);
  return NextResponse.json({ folderId, runId: run.runId }, { status: 202 });
}
