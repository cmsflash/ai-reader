import { BlobNotFoundError, head } from "@vercel/blob";
import { getDatabaseSql } from "@/server/database";
import { missingNarrationKeys } from "@/server/articles/narrationRecovery";
import { getArtifactStorage } from "@/server/runtime/artifactStorage";
import { NextResponse } from "next/server";
import { start } from "workflow/api";
import { requireAppUser } from "@/server/auth/access";
import { prepareArticleNarration } from "@/server/articles/articleNarrationPlan";
import { getArticleRepository } from "@/server/runtime/articleRepository";
import { getNarrationPolicyRepository } from "@/server/runtime/narrationPolicyRepository";
import { reconcileClaimedNarrationPolicyArticle } from "@/workflows/narrationPolicy/article";

export const runtime = "nodejs";
export const maxDuration = 60;
type Context = { params: Promise<{ id: string }> };

async function handle(context: Context, generate: boolean) {
  const auth = await requireAppUser();
  if (auth.response) return auth.response;
  const { id } = await context.params;
  const ownerEmail = auth.user.ownerEmail;
  const article = await getArticleRepository().findById(id, ownerEmail);
  if (!article) return NextResponse.json({ error: "Article not found." }, { status: 404 });
  try {
    const prepared = prepareArticleNarration(article, { onDemand: true });
    const json = (value: unknown, status = 200) => NextResponse.json(value, {
      status, headers: { "cache-control": "no-store" },
    });
    let missing: string[] = [];
    let restarted = false;
    if (article.narration?.sourceTextSha256 === prepared.sourceTextSha256) {
      missing = await missingNarrationKeys(article, async key => {
        if (process.env.ARTIFACT_STORAGE_DRIVER !== "vercel-blob")
          return Boolean(await getArtifactStorage().getUrl(key));
        try { await head(key); return true; }
        catch (error) { if (error instanceof BlobNotFoundError) return false; throw error; }
      });
      if (!missing.length) return json({ status: "ready", article });
      if (!generate) return json({ status: "missing", error: "Saved audio was removed. Press Play to regenerate it." });
    }
    if (generate && process.env.ARTICLE_REPOSITORY_DRIVER === "postgres") {
      const sql = getDatabaseSql();
      // Only an explicit Play may reset missing audio. Keep costs and successful segments.
      const reset = await sql.query(`WITH reset_job AS (
        UPDATE article_narration_jobs SET status='pending',attempt_id=NULL,workflow_run_id=NULL,
        lease_expires_at=NULL,cycle_attempt_count=0,cycle_exhausted_at=NULL,next_attempt_at=now(),
        error_message=NULL,updated_at=now() WHERE owner_email=$1 AND article_id=$2 AND generation_fingerprint=$3
        AND (status='completed' AND $4::boolean OR status='cancelled' AND error_message LIKE 'Saved audio was removed%')
        RETURNING id
      ), reset_segments AS (
        UPDATE article_narration_job_segments s SET status='pending',artifact_key=NULL,
          byte_length=NULL,alignment=NULL,local_sentence_cues=NULL,qa=NULL,attempt_id=NULL,job_attempt_id=NULL,
          lease_expires_at=NULL,cycle_attempt_count=0,next_attempt_at=now(),updated_at=now()
        FROM reset_job j WHERE s.job_id=j.id AND (s.artifact_key=ANY($5::text[]) OR s.artifact_key IS NULL)
        RETURNING s.job_id
      ) SELECT id FROM reset_job`, [ownerEmail,id,prepared.generationFingerprint,missing.length > 0,missing]);
      restarted = reset.length > 0;
      if (missing.length) await getArticleRepository().updateNarration(id,ownerEmail,null);
    }
    const job = await getNarrationPolicyRepository().findNarrationJob(ownerEmail, id, prepared.generationFingerprint);
    if (job?.status === "cancelled" || job?.status === "failed") {
      return json({ status: "failed", error: job.errorMessage ?? "Online narration failed. You can use Local voice." });
    }
    if (job?.status === "completed") {
      return json({ status: "failed", error: "Saved narration is unavailable. You can use Local voice." });
    }
    if (!generate || job?.status === "running" || (job?.status === "pending" && !restarted)) {
      return json({ status: "generating" }, 202);
    }
    if (!article.folderId) return json({ error: "Move this article into a folder before generating audio." }, 400);
    const run = await start(reconcileClaimedNarrationPolicyArticle, [{
      ownerEmail, folderId: article.folderId,
      folderInvalidationVersion: String(Date.now()), onDemand: true,
      candidate: { articleId: id, sourceTextSha256: prepared.sourceTextSha256,
        sentenceMapFingerprint: prepared.sentenceMapFingerprint },
    }]);
    return json({ status: "generating", runId: run.runId }, 202);
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Could not prepare narration." }, { status: 503 });
  }
}
export async function POST(_request: Request, context: Context) { return handle(context, true); }
export async function GET(_request: Request, context: Context) { return handle(context, false); }
