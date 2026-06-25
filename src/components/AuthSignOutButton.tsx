"use client";

import { useClerk } from "@clerk/nextjs";
import { LogOut } from "lucide-react";

export function AuthSignOutButton({ onBeforeSignOut }: { onBeforeSignOut: () => void }) {
  const { signOut } = useClerk();

  return (
    <button
      className="icon-button"
      type="button"
      title="Sign out"
      aria-label="Sign out"
      onClick={() => {
        onBeforeSignOut();
        void signOut({ redirectUrl: "/sign-in" });
      }}
    >
      <LogOut size={18} />
    </button>
  );
}
