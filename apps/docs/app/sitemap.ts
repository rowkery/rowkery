import type { MetadataRoute } from "next";
import { PAGES } from "@/lib/pages";

export const dynamic = "force-static";

export default function sitemap(): MetadataRoute.Sitemap {
  return PAGES.map((p) => ({ url: `https://docs.rowkery.com${p.href}` }));
}
