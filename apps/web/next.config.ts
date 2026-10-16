import type { NextConfig } from "next";

// Static export: `npm run build` writes plain HTML/CSS/JS to out/, which any
// static host (Vercel, Cloudflare Pages: output directory apps/web/out) can serve.
//
// ROWKERY_COMING_SOON=1 builds the coming-soon site instead: the only route files are the
// `*.soon.tsx` ones (app/(soon)/, app/not-found.soon.tsx), so the real page, its sections,
// copy and screens are not in the build, and every address shows the one page (out/404.html
// is it too). With ROWKERY_PREVIEW_KEY also set, the `*.site.tsx` files join in and the real
// site is built at /<key>/ as well (app/(site)/[key]/); `?key=<key>` on the coming-soon
// page goes there. Set them on the
// host for the production deployment only; preview builds keep the whole site, with the
// coming-soon page itself at /soon/.
export const COMING_SOON = /^(1|true|yes|on)$/i.test(process.env.ROWKERY_COMING_SOON ?? "");
const KEYED = COMING_SOON && !!process.env.ROWKERY_PREVIEW_KEY;

const config: NextConfig = {
  output: "export",
  images: { unoptimized: true },
  trailingSlash: true,
  pageExtensions: COMING_SOON ? (KEYED ? ["soon.tsx", "site.tsx"] : ["soon.tsx"]) : ["tsx", "ts"],
};

export default config;
