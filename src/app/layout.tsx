import type { Metadata } from "next";
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
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
