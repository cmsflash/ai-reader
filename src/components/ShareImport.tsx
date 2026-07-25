"use client";

import { BookOpen, CheckCircle2, LoaderCircle, TriangleAlert } from "lucide-react";
import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";

type ShareImportProps = {
  error?: string;
  source?: string;
  text?: string;
  title?: string;
  url?: string;
};

type ImportState =
  | { kind: "error"; message: string }
  | { kind: "importing"; message: string }
  | { kind: "success"; message: string };

export function ShareImport(props: ShareImportProps) {
  const articleUrl = useMemo(
    () => firstArticleUrl(props.url, props.text, props.title),
    [props.text, props.title, props.url],
  );
  const startedRef = useRef(false);
  const [state, setState] = useState<ImportState>(() =>
    props.error
      ? { kind: "error", message: props.error }
      : articleUrl
        ? { kind: "importing", message: "Saving shared article…" }
        : {
            kind: "error",
            message: "The shared item did not contain an HTTP or HTTPS article URL.",
          },
  );

  useEffect(() => {
    if (!articleUrl || props.error || startedRef.current) {
      return;
    }

    startedRef.current = true;
    const shareKey = `ai-reader-share:${articleUrl}`;

    if (window.sessionStorage.getItem(shareKey) === "completed") {
      setState({ kind: "success", message: "This article is already saved." });
      return;
    }

    async function saveSharedArticle() {
      try {
        const response = await fetch("/api/articles", {
          method: "POST",
          headers: {
            "content-type": "application/json",
          },
          body: JSON.stringify({ url: articleUrl }),
        });
        const body = (await response.json().catch(() => ({}))) as {
          error?: string;
        };

        if (!response.ok) {
          throw new Error(body.error ?? `Import failed with HTTP ${response.status}.`);
        }

        window.sessionStorage.setItem(shareKey, "completed");
        setState({ kind: "success", message: "Article saved to AI Reader." });
      } catch (error) {
        setState({
          kind: "error",
          message: error instanceof Error ? error.message : "Could not save article.",
        });
      }
    }

    void saveSharedArticle();
  }, [articleUrl, props.error, props.source, props.title]);

  return (
    <main className="share-page">
      <section className="share-card" aria-live="polite">
        <div className="share-brand">
          <BookOpen size={24} />
          <span>AI Reader</span>
        </div>
        {state.kind === "importing" ? (
          <LoaderCircle className="spin" size={42} />
        ) : state.kind === "success" ? (
          <CheckCircle2 className="share-success" size={42} />
        ) : (
          <TriangleAlert className="share-error" size={42} />
        )}
        <h1>{state.kind === "success" ? "Saved" : state.kind === "error" ? "Could not save" : "Importing"}</h1>
        <p>{state.message}</p>
        {props.title ? <strong>{props.title}</strong> : null}
        {articleUrl ? <small>{articleUrl}</small> : null}
        <Link className="primary-button share-open-button" href="/">
          Open library
        </Link>
      </section>
    </main>
  );
}

function firstArticleUrl(...values: Array<string | undefined>) {
  for (const value of values) {
    const candidate = value?.match(/https?:\/\/[^\s<>"']+/i)?.[0];

    if (!candidate) {
      continue;
    }

    try {
      const url = new URL(candidate.replace(/[),.;!?]+$/, ""));

      if (url.protocol === "http:" || url.protocol === "https:") {
        return url.href;
      }
    } catch {
      // Continue to the next candidate.
    }
  }

  return null;
}
