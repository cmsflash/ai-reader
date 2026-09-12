import { NextResponse } from "next/server";
import { getAppAuthStatus, requireAppUser } from "@/server/auth/access";

export const runtime = "nodejs";

export async function GET() {
  const status = await getAppAuthStatus();
  const auth = status.authorized ? await requireAppUser() : null;
  return NextResponse.json({ ...status, email: auth?.user?.ownerEmail ?? status.email }, { status: status.enabled && !status.configured ? 503 : 200 });
}
