import { clerkMiddleware, createRouteMatcher } from "@clerk/nextjs/server";
import { NextResponse, type NextFetchEvent, type NextRequest } from "next/server";
import { isClerkConfigured, shouldBypassAuthLocally } from "@/server/auth/config";

const isPublicRoute = createRouteMatcher([
  "/sign-in(.*)",
  "/sign-up(.*)",
  "/auth/setup(.*)",
  "/api/auth/me",
]);

const isApiRoute = createRouteMatcher(["/api(.*)"]);

const clerkProxy = clerkMiddleware(async (auth, request) => {
  if (!isPublicRoute(request) && !isApiRoute(request)) {
    const signInUrl = new URL("/sign-in", request.url);
    signInUrl.searchParams.set(
      "redirect_url",
      `${request.nextUrl.pathname}${request.nextUrl.search}`,
    );
    await auth.protect({ unauthenticatedUrl: signInUrl.href });
  }
});

export default function proxy(request: NextRequest, event: NextFetchEvent) {
  if (!isClerkConfigured()) {
    return unauthenticatedSetupResponse(request);
  }

  return clerkProxy(request, event);
}

export const config = {
  matcher: [
    "/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)",
    "/(api|trpc)(.*)",
    "/__clerk/(.*)",
  ],
};

function unauthenticatedSetupResponse(request: NextRequest) {
  if (shouldBypassAuthLocally() || isPublicRoute(request)) {
    return NextResponse.next();
  }

  if (isApiRequest(request)) {
    return NextResponse.json({ error: "Authentication is not configured." }, { status: 503 });
  }

  const url = request.nextUrl.clone();
  url.pathname = "/auth/setup";
  url.search = "";
  return NextResponse.redirect(url);
}

function isApiRequest(request: NextRequest) {
  return request.nextUrl.pathname.startsWith("/api/");
}
