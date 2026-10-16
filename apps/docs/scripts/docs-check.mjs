// Checks the built docs (run `npm run build` first; needs Playwright):
//   node scripts/docs-check.mjs [outDir]
// For every page in lib/pages.ts, at a desktop (1440×900) and a phone (390×844) window: it
// loads with no page error, nothing scrolls sideways, every image loads, the sidebar marks
// the page as open, and every link to another docs page (and its #heading) exists. Then ⌘K:
// typing "ssh" finds the SSH tunnel section and ↵ lands on it; Esc closes the search; the
// phone's Menu shows the page list and a pick closes it; Copy copies the code block. A
// screenshot of each page at each size goes to outDir.
import { mkdir, readFile } from "node:fs/promises";
import { playwright, serveOut } from "./serve-out.mjs";

const OUT = process.argv[2] ?? "/tmp/rowkery-docs-check";
await mkdir(OUT, { recursive: true });
const src = await readFile(new URL("../lib/pages.ts", import.meta.url), "utf8");
const PAGES = [...src.matchAll(/href: "([^"]+)", title: "([^"]+)"/g)].map((m) => ({ href: m[1], title: m[2] }));

const server = await serveOut();
const BASE = server.url.replace(/\/$/, "");
const { chromium } = playwright();
const browser = await chromium.launch();
let failed = 0;
const ok = (cond, what) => {
  console.log(`${cond ? "ok  " : "FAIL"} ${what}`);
  if (!cond) failed++;
};

for (const [name, viewport] of [["desktop", { width: 1440, height: 900 }], ["phone", { width: 390, height: 844 }]]) {
  const page = await browser.newPage({ viewport, deviceScaleFactor: 2 });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  for (const p of PAGES) {
    const res = await page.goto(BASE + p.href, { waitUntil: "networkidle" });
    const tag = `${name} ${p.href}`;
    ok(res.status() === 200, `${tag}: loads`);
    ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${tag}: nothing scrolls sideways`);
    const broken = await page.evaluate(async () => {
      const imgs = [...document.querySelectorAll("main img")];
      for (const i of imgs) {
        i.loading = "eager";
        if (!i.complete) await new Promise((r) => i.addEventListener("load", r, { once: true }) || i.addEventListener("error", r, { once: true }));
      }
      return imgs.filter((i) => !i.naturalWidth).map((i) => i.getAttribute("src"));
    });
    ok(broken.length === 0, `${tag}: every image loads ${broken.join(" ")}`);
    ok((await page.locator('[data-testid="side-link"][aria-current="page"]').getAttribute("href", { timeout: 2000 }).catch(() => null)) === p.href, `${tag}: sidebar marks it open`);
    ok((await page.title()).includes(p.href === "/" ? "Rowkery Docs" : p.title), `${tag}: title names the page`);
    await page.screenshot({ path: `${OUT}/${name}${p.href === "/" ? "-introduction" : "-" + p.href.replaceAll("/", "")}.png`, fullPage: true });
  }
  ok(errors.length === 0, `${name}: no page errors ${errors.join(" | ")}`);
  await page.close();
}

// Every internal link, and its anchor, resolves.
{
  const page = await browser.newPage();
  const links = new Set();
  for (const p of PAGES) {
    await page.goto(BASE + p.href);
    for (const h of await page.$$eval('main a[href^="/"], main a[href^="#"]', (as) => as.map((a) => a.href))) links.add(h);
  }
  for (const l of links) {
    const u = new URL(l);
    const res = await page.goto(u.origin + u.pathname);
    const anchorOk = !u.hash || (await page.locator(`[id="${decodeURIComponent(u.hash.slice(1))}"]`).count()) === 1;
    ok(res.status() === 200 && anchorOk, `link ${u.pathname}${u.hash} resolves`);
  }
  await page.close();
}

// ⌘K, Copy and the phone's Menu.
{
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await ctx.grantPermissions(["clipboard-read", "clipboard-write"]);
  const page = await ctx.newPage();
  await page.goto(BASE + "/");
  await page.keyboard.press("ControlOrMeta+k");
  ok(await page.locator('[data-testid="search"]').isVisible(), "⌘K opens the search");
  await page.keyboard.type("ssh");
  ok((await page.locator('[data-testid="search-hit"]').first().textContent())?.startsWith("SSH tunnel"), "typing ssh finds SSH tunnel first");
  await page.keyboard.press("Enter");
  await page.waitForURL(/setting-up-a-connection\/#ssh-tunnel$/);
  ok(await page.locator("#ssh-tunnel").isVisible(), "↵ lands on the SSH tunnel section");
  await page.keyboard.press("ControlOrMeta+k");
  await page.keyboard.press("Escape");
  ok(!(await page.locator('[data-testid="search"]').count()), "Esc closes the search");
  await page.locator('[data-testid="search-open"]').click();
  await page.keyboard.type("zzzz");
  ok(await page.locator(".finder .none").isVisible(), "a search with no match says so");
  await page.keyboard.press("Escape");

  await page.goto(BASE + "/quick-setup/");
  await page.locator('[data-testid="copy"]').first().click();
  ok((await page.evaluate(() => navigator.clipboard.readText())) === "xattr -dr com.apple.quarantine /Applications/Rowkery.app", "Copy copies exactly the command");
  await ctx.close();

  const phone = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await phone.goto(BASE + "/");
  ok(!(await phone.locator("#side").isVisible()), "phone: the page list starts hidden");
  await phone.locator(".menu-btn").click();
  ok(await phone.locator("#side").isVisible(), "phone: Menu shows the page list");
  await phone.screenshot({ path: `${OUT}/phone-menu.png` });
  await phone.locator('[data-testid="side-link"][href="/connecting-to-agents/"]').click();
  await phone.waitForURL(/connecting-to-agents/);
  const closed = await phone.waitForFunction(() => !document.body.classList.contains("menu-open"), null, { timeout: 2000 }).then(() => true, () => false);
  ok(closed && !(await phone.locator("#side").isVisible()), "phone: picking a page closes the list");
  await phone.close();
}

await browser.close();
server.close();
console.log(failed ? `\n${failed} failed` : "\nall passed");
process.exit(failed ? 1 : 0);
