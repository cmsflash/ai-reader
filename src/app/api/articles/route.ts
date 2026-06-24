import { NextResponse } from "next/server";
import {
  importFileArticle,
  importUrlArticle,
  listArticleSummaries,
} from "@/server/articles/articleService";

export const runtime = "nodejs";

export async function GET() {
  const articles = await listArticleSummaries();
  return NextResponse.json({ articles });
}

export async function POST(request: Request) {
  try {
    const contentType = request.headers.get("content-type") ?? "";
    const result = contentType.includes("multipart/form-data")
      ? await importFromForm(request)
      : await importFromJson(request);

    return NextResponse.json(result, { status: 201 });
  } catch (error) {
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "Could not import article.",
      },
      { status: 400 },
    );
  }
}

async function importFromJson(request: Request) {
  const body = (await request.json()) as { url?: string };

  if (!body.url) {
    throw new Error("URL is required.");
  }

  return importUrlArticle(body.url);
}

async function importFromForm(request: Request) {
  const form = await request.formData();
  const file = form.get("file");

  if (!(file instanceof File)) {
    throw new Error("File is required.");
  }

  return importFileArticle(file);
}
