import type { Metadata } from "next";
import { ClerkProvider } from "@clerk/nextjs";
import { isClerkConfigured } from "@/server/auth/config";
import "./globals.css";

export const metadata: Metadata = {
  title: "AI Reader",
  description: "A minimal read-it-later app with document import, progress sync, and browser TTS.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const body = isClerkConfigured() ? <ClerkProvider>{children}</ClerkProvider> : children;

  return (
    <html lang="en">
      <body>{body}</body>
    </html>
  );
}
