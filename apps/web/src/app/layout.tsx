import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import { GeistPixelSquare } from "geist/font/pixel";
import { Providers } from "@/components/providers";
import { SiteHeader } from "@/components/site-header";
import { networkFromEnv } from "@/server/repo";
import { THEME_BOOTSTRAP } from "@/components/theme-toggle";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "Cascade", template: "%s | Cascade" },
  description: "Escrow trees for the agent supply chain on Cardano. The buyer pays once, every agent is paid only for verified work, and failed work refunds up the tree.",
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f7f7f6" },
    { media: "(prefers-color-scheme: dark)", color: "#09090a" },
  ],
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={GeistPixelSquare.variable} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOTSTRAP }} />
      </head>
      <body className="min-h-dvh">
        <a href="#main" className="sr-only focus:not-sr-only focus:fixed focus:left-3 focus:top-3 focus:z-50 focus:rounded-full focus:bg-surface focus:px-3 focus:py-2 focus:shadow-pop">
          Skip to content
        </a>
        <Providers>
          <SiteHeader network={networkFromEnv()} />
          <main id="main">{children}</main>
        </Providers>
      </body>
    </html>
  );
}
