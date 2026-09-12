import { NextResponse } from "next/server";
import { requireAppUser } from "@/server/auth/access";
import { getArticleRepository } from "@/server/runtime/articleRepository";

export async function GET(request: Request) {
  const auth = await requireAppUser();
  if (auth.response) return auth.response;
  const ids = new URL(request.url).searchParams.getAll("id");
  if (
    !ids.length ||
    ids.length > 12 ||
    ids.some((id) => !id || id.length > 256)
  ) {
    return NextResponse.json(
      { error: "Request 1–12 articles." },
      { status: 400 },
    );
  }
  const repository = getArticleRepository();
  const articles = await Promise.all(
    ids.map((id) => repository.findById(id, auth.user.ownerEmail)),
  );
  return NextResponse.json(
    { articles: articles.filter(Boolean) },
    { headers: { "cache-control": "no-store" } },
  );
}
