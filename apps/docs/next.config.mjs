import createMDX from "@next/mdx";

// Static export: `npm run build` writes plain HTML/CSS/JS to out/ for docs.rowkery.com.
// Pages are MDX (`app/**/page.mdx`); GitHub-style tables come from remark-gfm, named as a
// string so the plugin also works under Turbopack.
const withMDX = createMDX({
  options: { remarkPlugins: ["remark-gfm"] },
});

/** @type {import("next").NextConfig} */
const config = {
  output: "export",
  images: { unoptimized: true },
  trailingSlash: true,
  pageExtensions: ["tsx", "ts", "mdx"],
};

export default withMDX(config);
