import { BookOpen, ShieldAlert } from "lucide-react";
import type { ReactNode } from "react";

export function AuthShell({ children }: { children: ReactNode }) {
  return (
    <main className="auth-page">
      <section className="auth-panel" aria-label="Authentication">
        <div className="auth-brand">
          <span className="brand-mark" aria-hidden="true">
            <BookOpen size={20} />
          </span>
          <div>
            <h1>AI Reader</h1>
            <p>Private library access</p>
          </div>
        </div>
        {children}
      </section>
    </main>
  );
}

export function AuthSetupPage() {
  return (
    <AuthShell>
      <div className="auth-message">
        <ShieldAlert size={22} />
        <h2>Authentication is not configured.</h2>
        <p>
          Set `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` and `CLERK_SECRET_KEY` for this environment,
          then redeploy.
        </p>
      </div>
    </AuthShell>
  );
}

export function AccessDeniedPage({ email }: { email?: string }) {
  return (
    <AuthShell>
      <div className="auth-message">
        <ShieldAlert size={22} />
        <h2>Access denied.</h2>
        <p>
          {email ? `${email} is not` : "This account is not"} allowed to use this AI Reader
          instance.
        </p>
      </div>
    </AuthShell>
  );
}
