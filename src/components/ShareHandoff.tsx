"use client";

import { BookOpen, CheckCircle2 } from "lucide-react";
import Link from "next/link";
import { useEffect } from "react";
import { beginShareHandoff } from "@/lib/shareHandoff";

export function ShareHandoff() {
  useEffect(() => beginShareHandoff(window), []);

  return (
    <main className="share-page">
      <section className="share-card" aria-live="polite">
        <div className="share-brand">
          <BookOpen size={24} />
          <span>AI Reader</span>
        </div>
        <CheckCircle2 className="share-success" size={42} />
        <h1>Import started</h1>
        <p>Returning to the app you shared from…</p>
        <small>
          If Android keeps AI Reader open, the article will appear as an
          importing item in your library.
        </small>
        <Link className="primary-button share-open-button" href="/">
          Open library
        </Link>
      </section>
    </main>
  );
}
