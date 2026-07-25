import { randomUUID } from "node:crypto";
import { after, NextResponse } from "next/server";
import { importUrlArticle } from "@/server/articles/articleService";
import {
  importTokenConfigured,
  requireImportToken,
} from "@/server/auth/importToken";
import { hasProductionDatabase } from "@/server/database";
import {
  findImportRecord,
  markImportCompleted,
  markImportFailed,
  markImportPending,
} from "@/server/integrations/importRecords";
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

  try {
    const body = (await request.json()) as {
      url?: string;
      title?: string;
      source?: string;
    };
    const url = await validatePublicArticleUrl(body.url ?? "");
    const provider = allowedSources.has(body.source ?? "")
      ? body.source ?? "api"
      : "api";
    const externalId =
      request.headers.get("idempotency-key")?.trim().slice(0, 200) || randomUUID();
    const existing = await findImportRecord(user.email, provider, externalId);

    if (existing && existing.status !== "failed") {
      return NextResponse.json(existing, {
        status: existing.status === "completed" ? 200 : 202,
        headers: corsHeaders,
      });
    }

    const record = await markImportPending({
      ownerEmail: user.email,
      provider,
      externalId,
      sourceTitle: cleanTitle(body.title),
      sourceUrl: url.href,
      metadata: {
        requestedBy: provider,
      },
    });

    if (!hasProductionDatabase()) {
      const result = await runImportJob(
        user.email,
        provider,
        externalId,
        url.href,
        cleanTitle(body.title),
      );
      return NextResponse.json(result, { status: 201, headers: corsHeaders });
    }

    after(() =>
      runImportJob(
        user.email,
        provider,
        externalId,
        url.href,
        cleanTitle(body.title),
      ),
    );

    return NextResponse.json(record, { status: 202, headers: corsHeaders });
  } catch (error) {
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "Could not queue article.",
      },
      { status: 400, headers: corsHeaders },
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

async function runImportJob(
  ownerEmail: string,
  provider: string,
  externalId: string,
  url: string,
  title?: string,
) {
  try {
    const result = await importUrlArticle(url, ownerEmail, { title });
    return await markImportCompleted(
      ownerEmail,
      provider,
      externalId,
      result.article.id,
    );
  } catch (error) {
    await markImportFailed(ownerEmail, provider, externalId, error);
    throw error;
  }
}

function cleanTitle(title?: string) {
  const normalized = title?.trim();
  return normalized ? normalized.slice(0, 240) : undefined;
}

function extensionCorsHeaders(request: Request): Record<string, string> {
  const origin = request.headers.get("origin") ?? "";
  return origin.startsWith("chrome-extension://")
    ? {
        "access-control-allow-origin": origin,
        vary: "origin",
      }
    : {};
}
