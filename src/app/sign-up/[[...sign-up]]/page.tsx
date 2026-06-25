import { SignUp } from "@clerk/nextjs";
import { AuthSetupPage, AuthShell } from "@/components/AuthPages";
import { isClerkConfigured } from "@/server/auth/config";

export default function Page() {
  if (!isClerkConfigured()) {
    return <AuthSetupPage />;
  }

  return (
    <AuthShell>
      <SignUp path="/sign-up" routing="path" />
    </AuthShell>
  );
}
