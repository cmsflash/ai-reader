import { NextResponse } from "next/server";
import {
  importTokenConfigured,
  requireImportToken,
} from "@/server/auth/importToken";
import { findImportRecord } from "@/server/integrations/importRecords";
import { extensionCorsHeaders } from "@/server/security/extensionCors";

export const runtime = "nodejs";

const allowedSources = new Set([
  "api",
  "android-share",
  "chrome-extension",
  "ios-shortcut",
]);

type RouteContext = {
  params: Promise<{
    id: string;
  }>;
};

export async function GET(request: Request, context: RouteContext) {
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

  const { id } = await context.params;
  const provider = new URL(request.url).searchParams.get("source") ?? "api";

  if (!allowedSources.has(provider)) {
    return NextResponse.json(
      { error: "Choose a valid personal import source." },
      { status: 400, headers: corsHeaders },
    );
  }

  const record = await findImportRecord(user.email, provider, id);

  if (!record) {
    return NextResponse.json(
      { error: "Import job not found." },
      { status: 404, headers: corsHeaders },
    );
  }

  return NextResponse.json(record, { headers: corsHeaders });
}

export function OPTIONS(request: Request) {
  return new NextResponse(null, {
    status: 204,
    headers: {
      ...extensionCorsHeaders(request),
      "access-control-allow-headers": "authorization",
      "access-control-allow-methods": "GET, OPTIONS",
      "access-control-max-age": "86400",
    },
  });
}
