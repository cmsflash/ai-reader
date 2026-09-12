import { ClerkProvider, SignUp } from "@clerk/nextjs";
import { AuthSetupPage, AuthShell } from "@/components/AuthPages";
import { isClerkConfigured } from "@/server/auth/config";

export default function Page() {
  if (!isClerkConfigured()) {
    return <AuthSetupPage />;
  }

  return (
    <ClerkProvider><AuthShell>
      <SignUp path="/sign-up" routing="path" />
    </AuthShell></ClerkProvider>
  );
}
