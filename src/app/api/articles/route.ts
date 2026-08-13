import { NextResponse } from "next/server";
import {
  ARTICLE_LIST_DEFAULT_PAGE_SIZE,
  ARTICLE_LIST_MAX_PAGE_SIZE,
  isArticleListLocation,
  isArticleListSortMode,
} from "@/lib/articleList";
import {
  importFileArticle,
  importUrlArticle,
  listArticleSummariesPage,
} from "@/server/articles/articleService";
import { listShareUrlImports } from "@/server/articles/urlImportQueue";
import { ArticleListCursorError } from "@/server/articles/articleListCursor";
import { requireAppUser } from "@/server/auth/access";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function GET(request: Request) {
  const auth = await requireAppUser();

  if (auth.response) {
    return auth.response;
  }

  let query: ReturnType<typeof parseArticleListQuery>;

  try {
    query = parseArticleListQuery(new URL(request.url).searchParams);
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Invalid article list query.",
      },
      { status: 400 },
    );
  }

  try {
    // Read imports first so a completing job cannot disappear before its
    // finished article is visible in the same response.
    const imports = await listShareUrlImports(auth.user.ownerEmail);
    const page = await listArticleSummariesPage(auth.user.ownerEmail, query);
    return NextResponse.json({ ...page, imports });
  } catch (error) {
    if (error instanceof ArticleListCursorError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }

    return NextResponse.json(
      { error: "Could not load the article list." },
      { status: 500 },
    );
  }
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

function parseArticleListQuery(searchParams: URLSearchParams) {
  const location = searchParams.get("location") ?? "default";
  const sort = searchParams.get("sort") ?? "saved-desc";
  const rawLimit = searchParams.get("limit");
  const cursor = searchParams.get("cursor") ?? undefined;

  if (!isArticleListLocation(location)) {
    throw new Error("Invalid article list location.");
  }

  if (!isArticleListSortMode(sort)) {
    throw new Error("Invalid article list sort mode.");
  }

  if (cursor === "") {
    throw new Error("Invalid article list cursor.");
  }

  let limit = ARTICLE_LIST_DEFAULT_PAGE_SIZE;

  if (rawLimit !== null) {
    if (!/^\d+$/u.test(rawLimit)) {
      throw new Error("Article list limit must be a positive integer.");
    }

    const parsedLimit = Number(rawLimit);

    if (!Number.isSafeInteger(parsedLimit) || parsedLimit < 1) {
      throw new Error("Article list limit must be a positive integer.");
    }

    limit = Math.min(parsedLimit, ARTICLE_LIST_MAX_PAGE_SIZE);
  }

  return {
    location,
    sort,
    limit,
    ...(cursor ? { cursor } : {}),
  };
}
