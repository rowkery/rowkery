import type { Metadata, Viewport } from "next";
import { Analytics } from "@vercel/analytics/next";
import localFont from "next/font/local";
import "./globals.css";

// IBM Plex Sans for text, IBM Plex Mono for SQL, keys and numbers, Gabarito for headings, and
// Caveat for the penguin's speech bubble, shipped with the build from app/fonts (SIL OFL).
// Every face listed here is preloaded but Caveat, which only the bubble uses.
const sans = localFont({
  src: [
    { path: "./fonts/ibm-plex-sans-latin-400-normal.woff2", weight: "400" },
    { path: "./fonts/ibm-plex-sans-latin-500-normal.woff2", weight: "500" },
  ],
  variable: "--font-sans",
  display: "swap",
});
const mono = localFont({
  src: [
    { path: "./fonts/ibm-plex-mono-latin-400-normal.woff2", weight: "400" },
    { path: "./fonts/ibm-plex-mono-latin-500-normal.woff2", weight: "500" },
  ],
  variable: "--font-mono",
  display: "swap",
});
const display = localFont({
  src: "./fonts/gabarito-latin-wght-normal.woff2",
  weight: "400 800",
  variable: "--font-display",
  display: "swap",
});
const hand = localFont({
  src: "./fonts/caveat-latin-wght-normal.woff2",
  weight: "500 700",
  variable: "--font-hand",
  display: "swap",
  preload: false,
});

const TITLE = "Rowkery · Postgres and SQLite for the Mac";
const DESCRIPTION =
  "Rowkery is a Mac app for Postgres and SQLite. Use it on your own, or let your AI agent read your database through it. Nothing changes until you press Commit.";

// The link preview (X, Slack, iMessage, Discord, Bluesky) comes from these tags and from
// public/og.png (1200 × 630: the mark, the name and one line). Without them a shared
// rowkery.com link shows as bare text.
export const metadata: Metadata = {
  metadataBase: new URL("https://rowkery.com"),
  title: TITLE,
  description: DESCRIPTION,
  icons: { icon: "/favicon.svg" },
  openGraph: {
    type: "website",
    url: "/",
    siteName: "Rowkery",
    title: TITLE,
    description: DESCRIPTION,
    images: [{ url: "/og.png", width: 1200, height: 630, alt: "Rowkery: Postgres and SQLite for the Mac, with an MCP server built in" }],
  },
  twitter: {
    card: "summary_large_image",
    title: TITLE,
    description: DESCRIPTION,
    images: ["/og.png"],
  },
};

// Dark only (2026-10-14).
export const viewport: Viewport = {
  themeColor: "#0a0a0a",
  colorScheme: "dark",
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${sans.variable} ${mono.variable} ${display.variable} ${hand.variable}`}>
      <body>
        {children}
        <Analytics />
      </body>
    </html>
  );
}
