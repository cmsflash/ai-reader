import type { Metadata, Viewport } from "next";
import { ClerkProvider } from "@clerk/nextjs";
import { isClerkConfigured } from "@/server/auth/config";
import { PwaRegistration } from "@/components/PwaRegistration";
import "./globals.css";

export const metadata: Metadata = {
  title: "AI Reader",
  description:
    "A minimal read-it-later app with document import, progress sync, and browser TTS.",
};

export const viewport: Viewport = {
  colorScheme: "light dark",
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f4ecd9" },
    { media: "(prefers-color-scheme: dark)", color: "#000000" },
  ],
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const body = isClerkConfigured() ? (
    <ClerkProvider>{children}</ClerkProvider>
  ) : (
    children
  );

  return (
    <html lang="en">
      <body>
        {body}
        <PwaRegistration />
      </body>
    </html>
  );
}
