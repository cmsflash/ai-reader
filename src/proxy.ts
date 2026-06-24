import { NextResponse, type NextRequest } from "next/server";

export function proxy(request: NextRequest) {
  const password = process.env.AI_READER_BASIC_AUTH_PASSWORD;

  if (!password) {
    return NextResponse.next();
  }

  const username = process.env.AI_READER_BASIC_AUTH_USERNAME || "reader";
  const authHeader = request.headers.get("authorization");

  if (isAuthorized(authHeader, username, password)) {
    return NextResponse.next();
  }

  return new NextResponse("Authentication required.", {
    status: 401,
    headers: {
      "www-authenticate": 'Basic realm="AI Reader", charset="UTF-8"',
    },
  });
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};

function isAuthorized(authHeader: string | null, username: string, password: string) {
  if (!authHeader?.startsWith("Basic ")) {
    return false;
  }

  try {
    const credentials = atob(authHeader.slice("Basic ".length));
    const separatorIndex = credentials.indexOf(":");

    if (separatorIndex === -1) {
      return false;
    }

    return (
      credentials.slice(0, separatorIndex) === username &&
      credentials.slice(separatorIndex + 1) === password
    );
  } catch {
    return false;
  }
}
