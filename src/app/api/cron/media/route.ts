import { NextResponse } from "next/server";
import { runMediaCleanup } from "@/server/artifacts/runMediaCleanup";
export const runtime = "nodejs";
export const maxDuration = 300;
export async function GET(request: Request) {
  if (!process.env.CRON_SECRET || request.headers.get("authorization") !== `Bearer ${process.env.CRON_SECRET}`)
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  return NextResponse.json(await runMediaCleanup());
}
