import { NextResponse } from "next/server";
import {
  importFileArticle,
  importUrlArticle,
  listArticleSummaries,
} from "@/server/articles/articleService";
import { requireAppUser } from "@/server/auth/access";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function GET() {
  const auth = await requireAppUser();

  if (auth.response) {
    return auth.response;
  }

  const articles = await listArticleSummaries(auth.user.ownerEmail);
  return NextResponse.json({ articles });
}

export async function POST(request: Request) {
  const auth = await requireAppUser();

  if (auth.response) {
    return auth.response;
  }

  try {
    const contentType = request.headers.get("content-type") ?? "";
    const result = contentType.includes("multipart/form-data")
      ? await importFromForm(request, auth.user.ownerEmail)
      : await importFromJson(request, auth.user.ownerEmail);

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

async function importFromJson(request: Request, ownerEmail: string) {
  const body = (await request.json()) as { url?: string };

  if (!body.url) {
    throw new Error("URL is required.");
  }

  return importUrlArticle(body.url, ownerEmail);
}

async function importFromForm(request: Request, ownerEmail: string) {
  const form = await request.formData();
  const file = form.get("file");

  if (!(file instanceof File)) {
    throw new Error("File is required.");
  }

  return importFileArticle(file, ownerEmail);
}
