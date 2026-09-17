import { NextResponse } from "next/server";
import { start } from "workflow/api";
import { getDatabaseSql } from "@/server/database";
import {
  publicationSources,
  type PublicationSource,
} from "@/server/publications/sources";
import { syncPublication } from "@/workflows/publications/workflow";
export async function GET(request: Request) {
  if (
    !process.env.CRON_SECRET ||
    request.headers.get("authorization") !== `Bearer ${process.env.CRON_SECRET}`
  )
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const subscriptions = await getDatabaseSql().query(
    "SELECT owner_email,source FROM publication_subscriptions",
  );
  const runs = [];
  for (const subscription of subscriptions) {
    if (!Object.hasOwn(publicationSources, String(subscription.source)))
      continue;
    const run = await start(syncPublication, [
      String(subscription.owner_email),
      subscription.source as PublicationSource,
    ]);
    runs.push(run.runId);
  }
  return NextResponse.json({ runs });
}
