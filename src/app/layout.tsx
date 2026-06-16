import type { Metadata } from "next";
import { Analytics } from "@vercel/analytics/next";
import { SpeedInsights } from "@vercel/speed-insights/next";
import "./globals.css";

// Fonts come from a deterministic system font stack (see globals.css `@theme`), not a
// build-time Google Fonts fetch — so the build needs no network and is reproducible offline.
export const metadata: Metadata = {
  title: "ID Caddie",
  description: "Contract-aware SaaS governance for complex organizations",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="h-full antialiased">
      <body className="min-h-full flex flex-col">
        {children}
        <Analytics />
        <SpeedInsights />
      </body>
    </html>
  );
}
