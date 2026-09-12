import { NextResponse } from "next/server";
import { requireAppUser } from "@/server/auth/access";
import { getArticleRepository } from "@/server/runtime/articleRepository";
import { listShareUrlImports } from "@/server/articles/urlImportQueue";
export async function GET() {
  const auth = await requireAppUser();
  if (auth.response) return auth.response;
  const repository = getArticleRepository();
  const [articles, folders, imports] = await Promise.all([
    repository.list(auth.user.ownerEmail),
    repository.listFolders(auth.user.ownerEmail),
    listShareUrlImports(auth.user.ownerEmail),
  ]);
  return NextResponse.json(
    { owner: auth.user.ownerEmail, articles, folders, imports },
    {
      headers: { "cache-control": "no-store" },
    },
  );
}
