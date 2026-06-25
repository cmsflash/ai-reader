import { NextResponse } from "next/server";
import { getAppAuthStatus } from "@/server/auth/access";

export const runtime = "nodejs";

export async function GET() {
  const status = await getAppAuthStatus();
  return NextResponse.json(status, { status: status.enabled && !status.configured ? 503 : 200 });
}
