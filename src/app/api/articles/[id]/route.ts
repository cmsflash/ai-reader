import { NextResponse } from "next/server";
import {
  deleteSavedArticle,
  getSavedArticle,
  updateSavedArticleProgress,
} from "@/server/articles/articleService";
import { requireAppUser } from "@/server/auth/access";

export const runtime = "nodejs";

type RouteContext = {
  params: Promise<{
    id: string;
  }>;
};

export async function GET(_request: Request, context: RouteContext) {
  const auth = await requireAppUser();

  if (auth.response) {
    return auth.response;
  }

  const { id } = await context.params;
  const article = await getSavedArticle(id, auth.user.email);

  if (!article) {
    return NextResponse.json({ error: "Article not found." }, { status: 404 });
  }

  return NextResponse.json({ article });
}

export async function PATCH(request: Request, context: RouteContext) {
  const auth = await requireAppUser();

  if (auth.response) {
    return auth.response;
  }

  try {
    const { id } = await context.params;
    const body = (await request.json()) as {
      progress?: {
        sentenceIndex?: number;
        percent?: number;
      };
    };

    const result = await updateSavedArticleProgress(id, auth.user.email, body.progress ?? {});

    if (!result) {
      return NextResponse.json({ error: "Article not found." }, { status: 404 });
    }

    return NextResponse.json(result);
  } catch (error) {
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "Could not update article.",
      },
      { status: 400 },
    );
  }
}

export async function DELETE(_request: Request, context: RouteContext) {
  const auth = await requireAppUser();

  if (auth.response) {
    return auth.response;
  }

  const { id } = await context.params;
  const deleted = await deleteSavedArticle(id, auth.user.email);

  if (!deleted) {
    return NextResponse.json({ error: "Article not found." }, { status: 404 });
  }

  return NextResponse.json({ ok: true });
}
