import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { getAuthConfig, sessionCookieName, verifySessionToken } from "@/server/auth/session";

export const runtime = "nodejs";

export async function GET() {
  const config = getAuthConfig();

  if (!config.enabled) {
    return NextResponse.json({ enabled: false, authenticated: true });
  }

  if (!config.configured) {
    return NextResponse.json(
      {
        enabled: true,
        authenticated: false,
        configured: false,
      },
      { status: 503 },
    );
  }

  const cookieStore = await cookies();
  const username = await verifySessionToken(cookieStore.get(sessionCookieName)?.value);

  return NextResponse.json({
    enabled: true,
    authenticated: Boolean(username),
    configured: true,
    username,
  });
}
