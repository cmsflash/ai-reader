import { createHash, randomUUID } from "node:crypto";
import { after, NextResponse } from "next/server";
import {
  getSavedArticle,
  importUrlArticle,
} from "@/server/articles/articleService";
import {
  importTokenConfigured,
  requireImportToken,
} from "@/server/auth/importToken";
import { hasProductionDatabase } from "@/server/database";
import {
  articleIdForImport,
  claimImport,
  findImportRecord,
  markImportCompletedReconciled,
  markImportFailed,
} from "@/server/integrations/importRecords";
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
  const title = cleanTitle(body.title);
  const sourceHash = personalImportSourceHash(url.href, title);

  try {
    const record = await claimImport(
      {
        ownerEmail: user.email,
        provider,
        externalId,
        sourceHash,
        sourceTitle: title,
        sourceUrl: url.href,
        metadata: {
          requestedBy: provider,
        },
      },
      {
        sourceHashMustMatch: true,
      },
    );

    if (!record?.attemptId) {
      const existing = await findImportRecord(user.email, provider, externalId);

      if (!existing) {
        return NextResponse.json(
          { error: "The import could not be claimed." },
          { status: 409, headers: corsHeaders },
        );
      }

      if (existing.sourceHash !== sourceHash) {
        return NextResponse.json(
          { error: "This idempotency key belongs to a different import request." },
          { status: 409, headers: corsHeaders },
        );
      }

      return NextResponse.json(existing, {
        status: existing.status === "completed" ? 200 : 202,
        headers: corsHeaders,
      });
    }

    const attemptId = record.attemptId;
    const articleId = articleIdForImport(
      user.email,
      provider,
      externalId,
      sourceHash,
    );

    if (!hasProductionDatabase()) {
      const result = await runImportJob(
        user.email,
        provider,
        externalId,
        url.href,
        title,
        attemptId,
        articleId,
      );
      return NextResponse.json(result, { status: 201, headers: corsHeaders });
    }

    after(() =>
      runImportJob(
        user.email,
        provider,
        externalId,
        url.href,
        title,
        attemptId,
        articleId,
      ),
    );

    return NextResponse.json(record, { status: 202, headers: corsHeaders });
  } catch {
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

async function runImportJob(
  ownerEmail: string,
  provider: string,
  externalId: string,
  url: string,
  title: string | undefined,
  attemptId: string,
  articleId: string,
) {
  try {
    const existing = await getSavedArticle(articleId, ownerEmail);
    const result = existing
      ? { article: existing }
      : await importUrlArticle(url, ownerEmail, {
          id: articleId,
          title,
        });
    const completed = await markImportCompletedReconciled(
      ownerEmail,
      provider,
      externalId,
      result.article.id,
      attemptId,
    );

    if (!completed) {
      throw new Error("The import lease expired before completion.");
    }

    return completed;
  } catch (error) {
    await markImportFailed(
      ownerEmail,
      provider,
      externalId,
      error,
      attemptId,
    ).catch(() => null);

    throw error;
  }
}

function cleanTitle(title?: string) {
  const normalized = title?.trim();
  return normalized ? normalized.slice(0, 240) : undefined;
}

function personalImportSourceHash(url: string, title?: string) {
  return createHash("sha256")
    .update(url)
    .update("\0")
    .update(title ?? "")
    .digest("hex");
}
