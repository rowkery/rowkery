// Shared by the checks: Playwright (local or the global install in cloud containers) and a
// static server for the built site in out/.
import { createRequire } from "node:module";
import { execSync } from "node:child_process";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join } from "node:path";

const require = createRequire(import.meta.url);

export function playwright() {
  try {
    return require("playwright");
  } catch {
    return require(`${execSync("npm root -g").toString().trim()}/playwright`);
  }
}

const ROOT = new URL("../out/", import.meta.url).pathname;
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".woff2": "font/woff2", ".webp": "image/webp", ".txt": "text/plain" };

/** Serves out/ on a free port; resolves to its URL and a close(). */
export function serveOut() {
  const server = createServer(async (req, res) => {
    let p = decodeURIComponent(new URL(req.url, "http://x").pathname);
    if (p.endsWith("/")) p += "index.html";
    try {
      let body;
      try {
        body = await readFile(join(ROOT, p));
      } catch (e) {
        // A static host answers an unknown address with 404.html.
        if (p.endsWith("index.html") && e.code === "ENOENT") {
          res.writeHead(404, { "content-type": "text/html" }).end(await readFile(join(ROOT, "404.html")));
          return;
        }
        throw e;
      }
      res.writeHead(200, { "content-type": TYPES[extname(p)] ?? "application/octet-stream" }).end(body);
    } catch {
      res.writeHead(404).end();
    }
  });
  return new Promise((resolve) => server.listen(0, () => resolve({ url: `http://localhost:${server.address().port}/`, close: () => server.close() })));
}
