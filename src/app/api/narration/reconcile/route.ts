import { NextResponse } from "next/server";
import { requireAppUser } from "@/server/auth/access";
import { scheduleNarrationPolicyForOwner } from "@/server/articles/narrationPolicyScheduler";

export const runtime = "nodejs";

export async function POST() {
  const auth = await requireAppUser();

  if (auth.response) {
    return auth.response;
  }

  try {
    const run = await scheduleNarrationPolicyForOwner(auth.user.ownerEmail);

    return NextResponse.json(
      { ok: true, runId: run.runId },
      { status: 202, headers: { "cache-control": "no-store" } },
    );
  } catch {
    return NextResponse.json(
      { error: "Could not schedule narration reconciliation." },
      { status: 503, headers: { "cache-control": "no-store" } },
    );
  }
}
