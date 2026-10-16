import type { Metadata, Viewport } from "next";
import localFont from "next/font/local";
import "./globals.css";

// IBM Plex Sans for text and IBM Plex Mono for SQL, keys and timings, shipped with the
// build from app/fonts (SIL OFL). Every face listed here is preloaded, so only the weights
// the page sets: nothing is 600 (its file stays in app/fonts for when something is).
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

export const metadata: Metadata = {
  title: "Rowkery · Postgres and SQLite for the Mac",
  description: "Rowkery is a Mac app for Postgres and SQLite. Use it on your own, or let your AI agent read your database through it. Nothing changes until you press Commit.",
  icons: { icon: "/favicon.svg" },
};

// Dark only (2026-10-14).
export const viewport: Viewport = {
  themeColor: "#0a0a0a",
  colorScheme: "dark",
  width: "device-width",
  initialScale: 1,
};

// Before first paint, where the reveal can run: mark the page .js, which lets the CSS hold
// back the blocks that rise in as they come into view (Reveal.tsx). Without scripts they
// simply show, and if the bundle hasn't come alive within 2.5 s the mark comes off again.
const BOOT =
  "(function(d){if(!('IntersectionObserver' in window))return;d.classList.add('js');setTimeout(function(){if(!('live' in d.dataset))d.classList.remove('js')},2500)})(document.documentElement)";

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${sans.variable} ${mono.variable}`} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: BOOT }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
