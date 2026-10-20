import type { Metadata, Viewport } from "next";
import { Analytics } from "@vercel/analytics/next";
import localFont from "next/font/local";
import { Nav } from "@/components/Nav";
import { Pager } from "@/components/Pager";
import { Sidebar } from "@/components/Sidebar";
import { Toc } from "@/components/Toc";
import { searchIndex } from "@/lib/search-index";
import "./globals.css";

// IBM Plex Sans and Mono at 400 and 500, the website's faces (SIL OFL), shipped from app/fonts.
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
  title: { default: "Rowkery Docs", template: "%s · Rowkery Docs" },
  description: "How to install Rowkery, connect to Postgres and SQLite, and let your AI agent read your database through it.",
  metadataBase: new URL("https://docs.rowkery.com"),
  // Each page names its own address as the one to index.
  alternates: { canonical: "./" },
  // Google shows a favicon only when it can fetch a square raster one, 48 px or a multiple of it.
  icons: {
    icon: [
      { url: "/favicon.ico", sizes: "16x16 32x32 48x48" },
      { url: "/icon-192.png", sizes: "192x192", type: "image/png" },
      { url: "/favicon.svg", type: "image/svg+xml" },
    ],
    apple: "/apple-touch-icon.png",
  },
  // A shared docs link previews with the site's card.
  openGraph: {
    type: "website",
    url: "./",
    siteName: "Rowkery Docs",
    images: [{ url: "https://rowkery.com/og.png", width: 1200, height: 630, alt: "Rowkery: Postgres and SQLite for the Mac" }],
  },
  twitter: { card: "summary_large_image", images: ["https://rowkery.com/og.png"] },
};

// Dark only, like rowkery.com.
export const viewport: Viewport = {
  themeColor: "#0a0a0a",
  colorScheme: "dark",
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${sans.variable} ${mono.variable}`}>
      <body>
        <Nav index={searchIndex()} />
        <div className="shell">
          <Sidebar />
          <main>
            <article className="page">
              {children}
              <Pager />
            </article>
          </main>
          <Toc />
        </div>
        <Analytics />
      </body>
    </html>
  );
}
