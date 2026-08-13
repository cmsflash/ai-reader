import { after } from "next/server";
import { redirect } from "next/navigation";
import { ShareImport } from "@/components/ShareImport";
import { requireAppUser } from "@/server/auth/access";
import {
  claimUrlImport,
  isShareImportSource,
  shareImportExternalId,
  type ShareImportSource,
  urlImportSourceHash,
} from "@/server/articles/urlImportQueue";

export const maxDuration = 60;

type SharePageProps = {
  searchParams: Promise<{
    error?: string;
    source?: string;
    text?: string;
    title?: string;
    url?: string;
  }>;
};

export default async function SharePage({ searchParams }: SharePageProps) {
  const params = await searchParams;
  const articleUrl = firstArticleUrl(params.url, params.text, params.title);

  if (params.error || !articleUrl) {
    return (
      <ShareImport
        error={
          params.error ??
          "The shared item did not contain an HTTP or HTTPS article URL."
        }
        source={params.source}
        text={params.text}
        title={params.title}
        url={params.url}
      />
    );
  }

  const auth = await requireAppUser();

  if (auth.response) {
    redirect("/");
  }

  const source = shareImportSource(params.source);
  let run: (() => Promise<unknown>) | null = null;

  try {
    const claimed = await claimUrlImport({
      ownerEmail: auth.user.ownerEmail,
      provider: source,
      externalId: shareImportExternalId(articleUrl),
      url: articleUrl,
      title: params.title,
      // A changed page title should not create a second copy of the same URL.
      sourceHash: urlImportSourceHash(articleUrl),
      sourceHashMustMatch: true,
      metadata: {
        requestedBy: source,
      },
    });
    run = claimed.run;
  } catch {
    return (
      <ShareImport
        error="Could not queue the shared article. Please try again."
        source={source}
        title={params.title}
        url={articleUrl}
      />
    );
  }

  if (run) {
    after(run);
  }

  redirect("/");
}

function shareImportSource(source?: string): ShareImportSource {
  return source && isShareImportSource(source) ? source : "web-share";
}

function firstArticleUrl(...values: Array<string | undefined>) {
  for (const value of values) {
    const candidates = value?.match(/https?:\/\/[^\s<>"']+/gi) ?? [];

    for (const candidate of candidates) {
      try {
        const url = new URL(candidate.replace(/[),.;!?]+$/, ""));

        if (url.protocol === "http:" || url.protocol === "https:") {
          return url.href;
        }
      } catch {
        // Continue to the next candidate.
      }
    }
  }

  return null;
}
