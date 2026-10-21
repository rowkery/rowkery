import type { Metadata, Viewport } from "next";
import { Analytics } from "@vercel/analytics/next";
import localFont from "next/font/local";
import { DOWNLOAD_URL, MAKER_URL, RELEASE } from "@/lib/site";
import "./globals.css";

// IBM Plex Sans for text, IBM Plex Mono for SQL, keys and numbers, and Gabarito for headings,
// shipped with the build from app/fonts (SIL OFL) and preloaded.
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

// Search results show the title and description; Google cuts the description near 155 characters.
const TITLE = "Rowkery · Free Postgres and SQLite client for the Mac";
const DESCRIPTION =
  "Rowkery is a free, open-source Postgres and SQLite client for the Mac. Use it from the keyboard, or let Claude, Cursor or another AI agent read your database.";

// The link preview (X, Slack, iMessage, Discord, Bluesky) comes from these tags and from
// public/og.png (1200 × 630: the mark, the name and one line). Without them a shared
// rowkery.com link shows as bare text.
export const metadata: Metadata = {
  metadataBase: new URL("https://rowkery.com"),
  title: TITLE,
  description: DESCRIPTION,
  alternates: { canonical: "/" },
  // Google shows a favicon only when it can fetch a square raster one, 48 px or a multiple of it.
  icons: {
    icon: [
      { url: "/favicon.ico", sizes: "16x16 32x32 48x48" },
      { url: "/icon-192.png", sizes: "192x192", type: "image/png" },
      { url: "/favicon.svg", type: "image/svg+xml" },
    ],
    apple: "/apple-touch-icon.png",
  },
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

// What Google reads about the site and the app: the site name in results (instead of the bare
// domain), the logo, and the app as free macOS software.
const STRUCTURED_DATA = {
  "@context": "https://schema.org",
  "@graph": [
    { "@type": "WebSite", "@id": "https://rowkery.com/#website", name: "Rowkery", url: "https://rowkery.com/", publisher: { "@id": "https://rowkery.com/#org" } },
    {
      "@type": "Organization",
      "@id": "https://rowkery.com/#org",
      name: "Rowkery",
      url: "https://rowkery.com/",
      logo: "https://rowkery.com/icon-512.png",
      sameAs: ["https://github.com/rowkery"],
    },
    {
      "@type": "SoftwareApplication",
      name: "Rowkery",
      description: DESCRIPTION,
      url: "https://rowkery.com/",
      image: "https://rowkery.com/og.png",
      applicationCategory: "DeveloperApplication",
      operatingSystem: "macOS",
      softwareVersion: RELEASE.version,
      downloadUrl: DOWNLOAD_URL,
      license: "https://www.apache.org/licenses/LICENSE-2.0",
      offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
      author: { "@type": "Person", name: "Lucas Sim", url: MAKER_URL },
      publisher: { "@id": "https://rowkery.com/#org" },
    },
  ],
};

// The story plays out as you scroll only with scripts and without Reduce Motion. This runs
// before the first paint and marks the page, so the pinned layout (components/story/story.css)
// is there from the start; without the mark every scene is a plain stack, fully shown.
const MOTION = `if(!matchMedia("(prefers-reduced-motion: reduce)").matches)document.documentElement.setAttribute("data-motion","")`;

// Dark only (2026-10-14).
export const viewport: Viewport = {
  themeColor: "#0a0a0a",
  colorScheme: "dark",
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${sans.variable} ${mono.variable} ${display.variable}`} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: MOTION }} />
      </head>
      <body>
        <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(STRUCTURED_DATA) }} />
        {children}
        <Analytics />
      </body>
    </html>
  );
}
