import { ClerkProvider, SignIn } from "@clerk/nextjs";
import { AuthSetupPage, AuthShell } from "@/components/AuthPages";
import { isClerkConfigured } from "@/server/auth/config";

export default function Page() {
  if (!isClerkConfigured()) {
    return <AuthSetupPage />;
  }

  return (
    <ClerkProvider><AuthShell>
      <SignIn path="/sign-in" routing="path" />
    </AuthShell></ClerkProvider>
  );
}
