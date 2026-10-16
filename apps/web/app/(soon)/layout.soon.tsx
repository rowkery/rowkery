import type { Metadata, Viewport } from "next";
import { soonSans } from "../soon-font";
import "../soon.css";

// The coming-soon site's root (next.config.ts, ROWKERY_COMING_SOON): its own stylesheet and
// only the face it sets, so nothing of the real page is in this build. The real site, when
// ROWKERY_PREVIEW_KEY is set, has its own root under app/(site)/[key] (the *.site.tsx files).
export const metadata: Metadata = {
  title: "Rowkery · Coming soon",
  description: "Rowkery, a fast database app for the Mac, is on its way.",
  icons: { icon: "/favicon.svg" },
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  themeColor: "#0a0a0a",
  colorScheme: "dark",
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={soonSans.variable}>
      <body>{children}</body>
    </html>
  );
}
