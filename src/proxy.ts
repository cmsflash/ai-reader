import { NextResponse, type NextRequest } from "next/server";
import { getAuthConfig, sessionCookieName, verifySessionToken } from "@/server/auth/session";

export async function proxy(request: NextRequest) {
  const config = getAuthConfig();
  const pathname = request.nextUrl.pathname;

  if (!config.enabled || isPublicPath(pathname)) {
    return NextResponse.next();
  }

  if (!config.configured) {
    return setupRequiredResponse(request);
  }

  const username = await verifySessionToken(request.cookies.get(sessionCookieName)?.value);

  if (username) {
    return NextResponse.next();
  }

  return unauthorizedResponse(request);
}

export const config = {
  matcher: ["/((?!_next/|favicon.ico).*)"],
};

function isPublicPath(pathname: string) {
  return (
    pathname === "/login" ||
    pathname === "/api/auth/login" ||
    pathname === "/api/auth/logout" ||
    pathname === "/api/auth/me"
  );
}

function setupRequiredResponse(request: NextRequest) {
  if (isApiRequest(request)) {
    return NextResponse.json({ error: "Authentication is not configured." }, { status: 503 });
  }

  if (request.nextUrl.pathname === "/login") {
    return NextResponse.next();
  }

  const url = request.nextUrl.clone();
  url.pathname = "/login";
  url.search = "?setup=1";
  return NextResponse.redirect(url);
}

function unauthorizedResponse(request: NextRequest) {
  if (isApiRequest(request)) {
    return NextResponse.json({ error: "Authentication required." }, { status: 401 });
  }

  const url = request.nextUrl.clone();
  const next = `${request.nextUrl.pathname}${request.nextUrl.search}`;
  url.pathname = "/login";
  url.search = `?next=${encodeURIComponent(next)}`;
  return NextResponse.redirect(url);
}

function isApiRequest(request: NextRequest) {
  return request.nextUrl.pathname.startsWith("/api/");
}
