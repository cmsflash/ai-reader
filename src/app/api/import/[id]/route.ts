import { NextResponse } from "next/server";
import { requireImportToken } from "@/server/auth/importToken";
import { findImportRecord } from "@/server/integrations/importRecords";

export const runtime = "nodejs";

type RouteContext = {
  params: Promise<{
    id: string;
  }>;
};

export async function GET(request: Request, context: RouteContext) {
  const user = requireImportToken(request);

  if (!user) {
    return NextResponse.json(
      { error: "A valid personal import token is required." },
      { status: 401 },
    );
  }

  const { id } = await context.params;
  const provider = new URL(request.url).searchParams.get("source") ?? "api";
  const record = await findImportRecord(user.email, provider, id);

  if (!record) {
    return NextResponse.json({ error: "Import job not found." }, { status: 404 });
  }

  return NextResponse.json(record);
}
