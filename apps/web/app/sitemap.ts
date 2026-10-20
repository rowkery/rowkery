import type { MetadataRoute } from "next";

export const dynamic = "force-static";

// The site is one page; docs.rowkery.com lists its own pages.
export default function sitemap(): MetadataRoute.Sitemap {
  return [{ url: "https://rowkery.com/" }];
}
