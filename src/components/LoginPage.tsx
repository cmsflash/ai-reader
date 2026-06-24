"use client";

import { BookOpen, LogIn } from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import type { FormEvent } from "react";

type AuthMeResponse = {
  enabled: boolean;
  authenticated: boolean;
  configured?: boolean;
};

export function LoginPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [username, setUsername] = useState("reader");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [setupRequired, setSetupRequired] = useState(searchParams.get("setup") === "1");
  const nextPath = useMemo(() => safeNextPath(searchParams.get("next")), [searchParams]);

  useEffect(() => {
    let cancelled = false;

    async function loadAuthState() {
      const response = await fetch("/api/auth/me");
      const body = (await response.json().catch(() => ({}))) as AuthMeResponse;

      if (cancelled) {
        return;
      }

      if (response.status === 503 || body.configured === false) {
        setSetupRequired(true);
        return;
      }

      if (!body.enabled || body.authenticated) {
        router.replace(nextPath);
      }
    }

    void loadAuthState().catch(() => undefined);

    return () => {
      cancelled = true;
    };
  }, [nextPath, router]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setIsSubmitting(true);
    setError(null);

    try {
      const response = await fetch("/api/auth/login", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({ username, password }),
      });
      const body = (await response.json().catch(() => ({}))) as { error?: string };

      if (response.status === 503) {
        setSetupRequired(true);
        throw new Error(body.error ?? "Authentication is not configured.");
      }

      if (!response.ok) {
        throw new Error(body.error ?? "Could not sign in.");
      }

      router.replace(nextPath);
      router.refresh();
    } catch (loginError) {
      setError(loginError instanceof Error ? loginError.message : "Could not sign in.");
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <main className="login-page">
      <section className="login-panel" aria-label="Sign in">
        <div className="login-brand">
          <div className="brand-mark" aria-hidden="true">
            <BookOpen size={22} />
          </div>
          <div>
            <h1>AI Reader</h1>
            <p>Sign in to continue.</p>
          </div>
        </div>

        {setupRequired ? (
          <div className="notice error">
            Authentication is not configured. Set `AI_READER_AUTH_PASSWORD` and
            `AI_READER_SESSION_SECRET` in Vercel, then redeploy.
          </div>
        ) : null}

        <form className="login-form" onSubmit={handleSubmit}>
          <label>
            Username
            <input
              autoComplete="username"
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              disabled={isSubmitting || setupRequired}
            />
          </label>
          <label>
            Password
            <input
              autoComplete="current-password"
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              disabled={isSubmitting || setupRequired}
            />
          </label>
          {error ? (
            <div className="notice error" role="alert">
              {error}
            </div>
          ) : null}
          <button
            className="primary-button"
            type="submit"
            disabled={isSubmitting || setupRequired || !username.trim() || !password}
          >
            <LogIn size={18} />
            Sign in
          </button>
        </form>
      </section>
    </main>
  );
}

function safeNextPath(value: string | null) {
  if (!value?.startsWith("/") || value.startsWith("//")) {
    return "/";
  }

  return value;
}
