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
    if (article.narration?.sourceTextSha256 === prepared.sourceTextSha256) {
      return json({ status: "ready", article });
    }
    const job = await getNarrationPolicyRepository().findNarrationJob(ownerEmail, id, prepared.generationFingerprint);
    if (job?.status === "cancelled" || job?.status === "failed") {
      return json({ status: "failed", error: job.errorMessage ?? "Online narration failed. You can use Local voice." });
    }
    if (job?.status === "completed") {
      return json({ status: "failed", error: "Saved narration is unavailable. You can use Local voice." });
    }
    if (!generate || job?.status === "running" || job?.status === "pending") {
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
