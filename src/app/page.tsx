import { redirect } from "next/navigation";
import { AccessDeniedPage, AuthSetupPage } from "@/components/AuthPages";
import { ReaderApp } from "@/components/ReaderApp";
import { getAppAuthStatus } from "@/server/auth/access";

export default async function Home() {
  const authStatus = await getAppAuthStatus();

  if (authStatus.enabled && !authStatus.configured) {
    return <AuthSetupPage />;
  }

  if (authStatus.configured && !authStatus.authenticated) {
    redirect("/sign-in");
  }

  if (authStatus.authenticated && !authStatus.authorized) {
    return <AccessDeniedPage email={authStatus.email} />;
  }

  return <ReaderApp />;
}
