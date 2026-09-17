import { NextResponse } from "next/server";
import { start } from "workflow/api";
import { getDatabaseSql } from "@/server/database";
import { syncSubscribedPublications } from "@/workflows/publications/workflow";
export async function GET(request: Request) {
  if (
    !process.env.CRON_SECRET ||
    request.headers.get("authorization") !== `Bearer ${process.env.CRON_SECRET}`
  )
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const subscriptions = await getDatabaseSql().query(
    "SELECT DISTINCT owner_email FROM publication_subscriptions ORDER BY owner_email",
  );
  const runs = [];
  for (const subscription of subscriptions) {
    const run = await start(syncSubscribedPublications, [
      String(subscription.owner_email),
    ]);
    runs.push(run.runId);
  }
  return NextResponse.json({ runs });
}
