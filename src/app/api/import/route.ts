import { randomUUID } from "node:crypto";
import { after, NextResponse } from "next/server";
import {
  claimUrlImport,
  cleanImportTitle,
  UrlImportIdempotencyConflictError,
} from "@/server/articles/urlImportQueue";
import {
  importTokenConfigured,
  requireImportToken,
} from "@/server/auth/importToken";
import { hasProductionDatabase } from "@/server/database";
import { extensionCorsHeaders } from "@/server/security/extensionCors";
import { validatePublicArticleUrl } from "@/server/security/publicArticleUrl";

export const runtime = "nodejs";
export const maxDuration = 60;

const allowedSources = new Set([
  "api",
  "android-share",
  "chrome-extension",
  "ios-shortcut",
]);

export async function POST(request: Request) {
  const corsHeaders = extensionCorsHeaders(request);

  if (!importTokenConfigured()) {
    return NextResponse.json(
      { error: "Personal imports are not configured." },
      { status: 503, headers: corsHeaders },
    );
  }

  const user = requireImportToken(request);

  if (!user) {
    return NextResponse.json(
      { error: "A valid personal import token is required." },
      { status: 401, headers: corsHeaders },
    );
  }

  let body: {
    url?: string;
    title?: string;
    source?: string;
  };

  try {
    body = (await request.json()) as {
      url?: string;
      title?: string;
      source?: string;
    };
  } catch {
    return NextResponse.json(
      { error: "Request body must be valid JSON." },
      { status: 400, headers: corsHeaders },
    );
  }

  let url: URL;

  try {
    url = await validatePublicArticleUrl(body.url ?? "");
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Enter a valid article URL.",
      },
      { status: 400, headers: corsHeaders },
    );
  }

  const provider = allowedSources.has(body.source ?? "")
    ? body.source ?? "api"
    : "api";
  const suppliedIdempotencyKey =
    request.headers.get("idempotency-key")?.trim() ?? "";

  if (suppliedIdempotencyKey.length > 200) {
    return NextResponse.json(
      { error: "Idempotency-Key must be at most 200 characters." },
      { status: 400, headers: corsHeaders },
    );
  }

  const externalId = suppliedIdempotencyKey || randomUUID();
  const title = cleanImportTitle(body.title);

  try {
    const claimed = await claimUrlImport({
      ownerEmail: user.email,
      provider,
      externalId,
      url: url.href,
      title,
      sourceHashMustMatch: true,
    });

    if (!claimed.run) {
      return NextResponse.json(claimed.record, {
        status: claimed.record.status === "completed" ? 200 : 202,
        headers: corsHeaders,
      });
    }

    if (!hasProductionDatabase()) {
      const result = await claimed.run();
      return NextResponse.json(result, { status: 201, headers: corsHeaders });
    }

    after(claimed.run);

    return NextResponse.json(claimed.record, {
      status: 202,
      headers: corsHeaders,
    });
  } catch (error) {
    if (error instanceof UrlImportIdempotencyConflictError) {
      return NextResponse.json(
        { error: error.message },
        { status: 409, headers: corsHeaders },
      );
    }

    return NextResponse.json(
      { error: "Could not queue article." },
      { status: 500, headers: corsHeaders },
    );
  }
}

export function OPTIONS(request: Request) {
  return new NextResponse(null, {
    status: 204,
    headers: {
      ...extensionCorsHeaders(request),
      "access-control-allow-headers":
        "authorization, content-type, idempotency-key",
      "access-control-allow-methods": "POST, OPTIONS",
      "access-control-max-age": "86400",
    },
  });
}
