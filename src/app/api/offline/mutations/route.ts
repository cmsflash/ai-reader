import { NextResponse } from "next/server";
import { requireAppUser } from "@/server/auth/access";
import { getDatabaseSql } from "@/server/database";
import { deleteSavedArticle } from "@/server/articles/articleService";

export async function POST(request: Request) {
  const auth = await requireAppUser();
  if (auth.response) return auth.response;
  const owner = auth.user.ownerEmail;
  try {
    const operation = await request.json();
    const { id, method, target, body, at } = operation;
    if (
      typeof id !== "string" ||
      !/^[a-f0-9-]{36}$/.test(id) ||
      typeof target !== "string" ||
      !Number.isFinite(Date.parse(at)) ||
      Date.parse(at) > Date.now() + 60000
    ) {
      return NextResponse.json(
        { error: "Invalid offline change." },
        { status: 400 },
      );
    }
    const sql = getDatabaseSql();
    if (target === "/api/folders" && method === "POST") {
      if (
        typeof body?.name !== "string" ||
        !body.name.trim() ||
        body.name.length > 80
      )
        throw new Error("Invalid folder name.");
      await sql.query(
        `INSERT INTO reading_folders
        (id, owner_email, name, slug, is_archive, sort_order, created_at, updated_at)
        VALUES ($1,$2,$3,$4,false,100,$5,$5) ON CONFLICT (id) DO NOTHING`,
        [`offline-${id}`, owner, body.name.trim(), `offline-${id}`, at],
      );
    } else {
      const match = target.match(/^\/api\/articles\/([^/]+)$/);
      if (!match) throw new Error("Unsupported offline change.");
      const articleId = decodeURIComponent(match[1]);
      if (method === "DELETE") {
        await deleteSavedArticle(articleId, owner);
      } else if (method === "PATCH" && body?.progress) {
        const p = body.progress;
        if (
          !Number.isSafeInteger(p.sentenceIndex) ||
          !Number.isFinite(p.percent)
        )
          throw new Error("Invalid progress.");
        await sql.query(
          `UPDATE articles SET progress_sentence_index=LEAST(GREATEST($3,0),GREATEST(sentence_count-1,0)),
          progress_percent=LEAST(GREATEST($4,0),1), progress_updated_at=$5, updated_at=GREATEST(updated_at,$5::timestamptz)
          WHERE id=$1 AND owner_email=$2 AND progress_updated_at <= $5::timestamptz`,
          [articleId, owner, p.sentenceIndex, p.percent, at],
        );
      } else if (method === "PATCH" && body?.organization) {
        const o = body.organization;
        if (
          (o.archived !== undefined && typeof o.archived !== "boolean") ||
          (o.folderId !== undefined &&
            (typeof o.folderId !== "string" || !o.folderId))
        )
          throw new Error("Invalid organization.");
        await sql.query(
          `UPDATE articles SET
          archived_at=CASE WHEN $3::boolean IS NULL THEN archived_at WHEN $3 THEN COALESCE(archived_at,$5::timestamptz) ELSE NULL END,
          folder_id=CASE WHEN $4::text IS NOT NULL THEN $4::text
            WHEN $3::boolean IS FALSE AND EXISTS (SELECT 1 FROM reading_folders WHERE id=articles.folder_id AND owner_email=$2 AND is_archive=true)
            THEN (SELECT id FROM reading_folders WHERE owner_email=$2 AND is_archive=false ORDER BY CASE WHEN slug='default' THEN 0 ELSE 1 END, sort_order, created_at LIMIT 1)
            ELSE folder_id END,
          organization_updated_at=$5, updated_at=GREATEST(updated_at,$5::timestamptz)
          WHERE id=$1 AND owner_email=$2 AND organization_updated_at <= $5::timestamptz
          AND ($4::text IS NULL OR EXISTS (SELECT 1 FROM reading_folders WHERE id=$4 AND owner_email=$2))`,
          [articleId, owner, o.archived ?? null, o.folderId ?? null, at],
        );
      } else throw new Error("Unsupported offline change.");
    }
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : "Could not sync change.",
      },
      { status: 400 },
    );
  }
}
