import type { Metadata } from "next";
import { ComingSoon } from "@/components/ComingSoon";
import "../soon.css";

export const metadata: Metadata = { title: "Rowkery · Coming soon", robots: { index: false, follow: false } };

/**
 * The coming-soon page inside the full site, at /soon/, so a preview build shows it. With
 * ROWKERY_COMING_SOON on it is the whole site instead (next.config.ts).
 */
export default function Soon() {
  return <ComingSoon />;
}
