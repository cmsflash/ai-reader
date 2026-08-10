import { NextResponse } from "next/server";
import {
  deleteSavedArticle,
  getSavedArticle,
  updateSavedArticleOrganization,
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
  const article = await getSavedArticle(id, auth.user.ownerEmail);

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
      organization?: {
        archived?: unknown;
        folderId?: unknown;
      };
    };

    if (!body.progress && !body.organization) {
      throw new Error("An article update is required.");
    }

    if (body.organization) {
      const organization = await updateSavedArticleOrganization(
        id,
        auth.user.ownerEmail,
        organizationPatch(body.organization),
      );

      if (!organization) {
        return NextResponse.json(
          { error: "Article not found." },
          { status: 404 },
        );
      }

      return NextResponse.json({ organization });
    }

    const result = await updateSavedArticleProgress(
      id,
      auth.user.ownerEmail,
      body.progress ?? {},
    );

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

function organizationPatch(value: {
  archived?: unknown;
  folderId?: unknown;
}) {
  const patch: { archived?: boolean; folderId?: string } = {};

  if (Object.hasOwn(value, "archived")) {
    if (typeof value.archived !== "boolean") {
      throw new Error("Archived must be true or false.");
    }

    patch.archived = value.archived;
  }

  if (Object.hasOwn(value, "folderId")) {
    if (typeof value.folderId !== "string" || !value.folderId.trim()) {
      throw new Error("Folder ID must be a non-empty string.");
    }

    patch.folderId = value.folderId.trim();
  }

  if (!Object.hasOwn(patch, "archived") && !Object.hasOwn(patch, "folderId")) {
    throw new Error("Archive or folder state is required.");
  }

  return patch;
}

export async function DELETE(_request: Request, context: RouteContext) {
  const auth = await requireAppUser();

  if (auth.response) {
    return auth.response;
  }

  const { id } = await context.params;
  const deleted = await deleteSavedArticle(id, auth.user.ownerEmail);

  if (!deleted) {
    return NextResponse.json({ error: "Article not found." }, { status: 404 });
  }

  return NextResponse.json({ ok: true });
}
