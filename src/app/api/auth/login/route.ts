import { NextResponse } from "next/server";
import {
  createSessionToken,
  getAuthConfig,
  sessionCookieName,
  sessionMaxAgeSeconds,
  verifyCredentials,
} from "@/server/auth/session";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const config = getAuthConfig();

  if (!config.enabled) {
    return NextResponse.json({ enabled: false, authenticated: true });
  }

  if (!config.configured) {
    return NextResponse.json(
      {
        error: "Authentication is not configured.",
      },
      { status: 503 },
    );
  }

  const body = (await request.json().catch(() => ({}))) as {
    username?: string;
    password?: string;
  };
  const username = body.username?.trim() ?? "";
  const password = body.password ?? "";

  if (!(await verifyCredentials(username, password))) {
    return NextResponse.json({ error: "Invalid username or password." }, { status: 401 });
  }

  const response = NextResponse.json({
    enabled: true,
    authenticated: true,
    username,
  });
  response.cookies.set(sessionCookieName, await createSessionToken(username), {
    httpOnly: true,
    maxAge: sessionMaxAgeSeconds,
    path: "/",
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
  });

  return response;
}
