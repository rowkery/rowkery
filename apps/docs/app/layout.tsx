import type { Metadata, Viewport } from "next";
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
  icons: { icon: "/favicon.svg" },
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
      </body>
    </html>
  );
}
