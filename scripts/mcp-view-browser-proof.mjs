#!/usr/bin/env node
// Rowkery's view in the chat (MCP Apps): the page `rowkery --mcp` serves as
// ui://rowkery/view.html, drawn in a sandboxed frame by a stand-in host that
// speaks the MCP Apps postMessage protocol the way Claude Desktop does.
// - A query result: the rows the agent got as a grid, connection pill with
//   its env tag, "N rows · ms", masked columns dim, NULLs, a header click
//   sorts (numbers as numbers, NULLs last), wide results scroll sideways;
//   "Open in Rowkery" calls the page-only open_in_rowkery tool with the call id.
// - No rows; no columns; a refusal; a host that sent no structuredContent
//   (no call id, so no button).
// - A proposal card: verb, table, reason, SQL; "Review in Rowkery" calls
//   open_in_rowkery with the proposal id; it polls proposal_status and turns
//   to Committed · N rows, and the button goes.
// Light and dark screenshots.
//
//   node scripts/mcp-view-browser-proof.mjs [outDir]
import { createRequire } from "node:module";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";

const require = createRequire(import.meta.url);
let playwright;
try {
  playwright = require("playwright");
} catch {
  playwright = require(`${execSync("npm root -g").toString().trim()}/playwright`);
}
const OUT = process.argv[2] ?? "/tmp/rowkery-proof/mcp-view";
mkdirSync(OUT, { recursive: true });
const root = new URL("..", import.meta.url).pathname;
const view = readFileSync(`${root}crates/rowkery-mcp/src/view.html`, "utf8").replace(
  "<!--mark-->",
  readFileSync(`${root}apps/rowkery-tauri/brand/rowkery-mark-no-shadow.svg`, "utf8"),
);

// The host: one frame, answers the page's requests, logs its tool calls.
const hostPage = (theme) => `<!doctype html><html><body style="margin:0;padding:16px;background:${theme === "dark" ? "#262624" : "#f4f4f2"}">
<iframe id="v" sandbox="allow-scripts" style="border:0;width:640px;height:80px;display:block"></iframe>
<script>
window.calls = [];
window.proposalStatus = { state: "waiting" };
const frame = document.getElementById("v");
const reply = (id, result) => frame.contentWindow.postMessage({ jsonrpc: "2.0", id, result }, "*");
window.addEventListener("message", (e) => {
  const m = e.data;
  if (e.source !== frame.contentWindow || !m || m.jsonrpc !== "2.0") return;
  if (m.method === "ui/initialize") {
    reply(m.id, { protocolVersion: "2026-01-26", hostInfo: { name: "host", version: "1" },
      hostCapabilities: window.noTools ? {} : { serverTools: {} },
      hostContext: { theme: ${JSON.stringify(theme)}, displayMode: "inline", availableDisplayModes: ["inline", "fullscreen"] } });
  } else if (m.method === "ui/notifications/initialized") {
    window.ready = true;
  } else if (m.method === "ui/notifications/size-changed") {
    frame.style.height = m.params.height + "px";
  } else if (m.method === "tools/call") {
    window.calls.push(m.params);
    const body = m.params.name === "proposal_status" ? window.proposalStatus : { opened: true };
    reply(m.id, { content: [{ type: "text", text: JSON.stringify(body) }] });
  } else if (m.id !== undefined) {
    reply(m.id, {});
  }
});
window.send = (method, params) => frame.contentWindow.postMessage({ jsonrpc: "2.0", method, params }, "*");
</script></body></html>`;

const conn = { name: "shop-prd-with-a-long-connection-name", environment: "prd" };
const wideCols = ["id", "email", "provider", "total", "pending_for", "status", "created_at", "customer_id", "shipping_address_line_1", "shipping_city", "coupon", "notes"];
const wideRows = Array.from({ length: 40 }, (_, i) => [
  48113 + i * 7,
  `masked:${(0x3f9a0c11e2 + i * 977).toString(16).slice(0, 10)}`,
  ["Paylane", "Stripe", "Adyen"][i % 3],
  i === 5 ? null : Math.round((12 + ((i * 37) % 300)) * 100) / 100,
  `${(i % 4) + 1} d ${i % 24} h`,
  "pending",
  `2026-10-${String(18 + (i % 4)).padStart(2, "0")} 1${i % 10}:0${i % 6}:00`,
  9000 + i,
  `${100 + i} Very Long Street Name That Goes On`,
  ["Singapore", "Kuala Lumpur", "Jakarta"][i % 3],
  i % 5 === 0 ? "WELCOME10" : null,
  i % 7 === 0 ? { tag: "vip", retries: i % 3 } : null,
]);
const rowsResult = {
  content: [{ type: "text", text: "{}" }],
  structuredContent: { kind: "rows", call: "1760000000000-1760000001234-9f2cabcdef012345", connection: conn, database: "shop",
    columns: wideCols, types: ["int8", "text", "text", "numeric", "interval", "text", "timestamptz", "int8", "text", "text", "text", "jsonb"],
    rows: wideRows, row_count: 40, more: true, elapsed_ms: 41, masked: ["email"] },
};
const proposal = {
  kind: "proposal", id: "p_0123456789ab", state: "waiting", connection: conn,
  statements: [{ verb: "UPDATE", target: "orders", sql: "UPDATE orders SET status = 'failed'\nWHERE status = 'pending' AND provider_id = 4\n  AND created_at < '2026-10-20'" }],
  reason: "Mark the Paylane orders stuck since Monday as failed, so customers get the retry email.",
  expect_rows: 29,
};

const browser = await playwright.chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
const fails = [];
const check = (ok, what) => { if (!ok) fails.push(what); console.log(`${ok ? "ok  " : "FAIL"} ${what}`); };

async function scene(theme, result, opts = {}) {
  const page = await browser.newPage({ viewport: { width: 700, height: 640 }, deviceScaleFactor: 2 });
  const file = `${OUT}/host-${theme}.html`;
  writeFileSync(file, hostPage(theme));
  await page.goto(`file://${file}`);
  if (opts.noTools) await page.evaluate(() => (window.noTools = true));
  await page.evaluate((html) => (document.getElementById("v").srcdoc = html), view);
  await page.waitForFunction(() => window.ready === true);
  if (opts.input) await page.evaluate((a) => window.send("ui/notifications/tool-input", { arguments: a }), opts.input);
  await page.evaluate((r) => window.send("ui/notifications/tool-result", r), result);
  const frame = page.frameLocator("#v");
  await frame.locator('[data-testid="mcp-view"]').waitFor();
  return { page, frame };
}

for (const theme of ["light", "dark"]) {
  // A wide query result.
  {
    const { page, frame } = await scene(theme, rowsResult);
    const view = frame.locator('[data-testid="mcp-view"]');
    check((await view.getAttribute("data-view")) === "rows", `${theme}: rows view`);
    check((await frame.locator('[data-testid="view-connection"]').innerText()).includes("prd"), `${theme}: connection pill with env tag`);
    check((await frame.locator("tbody tr").count()) === 40, `${theme}: all 40 rows`);
    check((await frame.locator('[data-testid="view-note"]').innerText()) === "Same rows as the agent · 1 column masked", `${theme}: note`);
    await page.waitForTimeout(100);
    await page.screenshot({ path: `${OUT}/1-rows-${theme}.png` });
    // Sort total: ascending puts NULL last, then descending.
    await frame.locator('[data-header="total"]').click();
    const totals = await frame.locator("tbody tr td:nth-child(4)").allInnerTexts();
    const nums = totals.filter((t) => t !== "NULL").map(Number);
    check(nums.every((n, i) => i === 0 || nums[i - 1] <= n) && totals.at(-1) === "NULL", `${theme}: total sorts as numbers, NULL last`);
    await frame.locator('[data-header="total"]').click();
    check((await frame.locator('[data-header="total"]').getAttribute("aria-sort")) === "descending", `${theme}: second click sorts descending`);
    // Wide: scrolls sideways inside the grid, not the page.
    const scrolled = await frame.locator(".grid").evaluate((g) => { g.scrollLeft = 10000; return g.scrollLeft > 0 && g.scrollWidth > g.clientWidth; }); // Class on purpose: the grid's scroller.
    check(scrolled, `${theme}: wide result scrolls sideways`);
    await page.screenshot({ path: `${OUT}/2-rows-scrolled-${theme}.png` });
    await frame.locator('[data-testid="view-action"]').click();
    await page.waitForFunction(() => window.calls.length > 0);
    const calls = await page.evaluate(() => window.calls);
    check(calls[0].name === "open_in_rowkery" && calls[0].arguments.call === rowsResult.structuredContent.call, `${theme}: Open in Rowkery sends the call id`);
    await page.close();
  }
  // No rows.
  {
    const { page, frame } = await scene(theme, { content: [{ type: "text", text: "{}" }], structuredContent: { kind: "rows", call: "1-2-ab", connection: { name: "local" , environment: "local" }, columns: ["id"], rows: [], row_count: 0, more: false, elapsed_ms: 3 } });
    check((await frame.locator("tbody tr").count()) === 0, `${theme}: empty result has no rows`);
    await page.screenshot({ path: `${OUT}/3-no-rows-${theme}.png` });
    await page.close();
  }
  // A proposal: waiting, then committed while on screen.
  {
    const { page, frame } = await scene(theme, { content: [{ type: "text", text: "{}" }], structuredContent: proposal });
    const state = frame.locator('[data-testid="view-state"]');
    check((await state.getAttribute("data-state")) === "waiting", `${theme}: proposal waits`);
    check((await frame.locator('[data-testid="view-action"]').getAttribute("data-action")) === "review", `${theme}: Review in Rowkery shown`);
    await page.screenshot({ path: `${OUT}/4-proposal-waiting-${theme}.png` });
    await frame.locator('[data-testid="view-action"]').click();
    await page.waitForFunction(() => window.calls.some((c) => c.name === "open_in_rowkery"));
    const review = (await page.evaluate(() => window.calls)).find((c) => c.name === "open_in_rowkery");
    check(review.arguments.proposal === "p_0123456789ab", `${theme}: Review sends the proposal id`);
    await page.evaluate(() => (window.proposalStatus = { id: "p_0123456789ab", state: "committed", rows: [29], at_ms: Date.UTC(2026, 9, 22, 6, 6) }));
    await frame.locator('[data-testid="view-state"][data-state="committed"]').waitFor({ timeout: 6000 });
    check((await state.innerText()).includes("29 rows"), `${theme}: turns to Committed · 29 rows`);
    check(await frame.locator('[data-testid="view-action"]').isHidden(), `${theme}: no Review button once committed`);
    await page.screenshot({ path: `${OUT}/5-proposal-committed-${theme}.png` });
    await page.close();
  }
}

// A refusal shows its text; a host without structuredContent gets a grid
// from the agent's text and no button (no call id).
{
  const { page, frame } = await scene("light", { isError: true, content: [{ type: "text", text: "Refused: the plan reads public.events (~4,200,000 rows; indexed: (id)) end to end." }] });
  check((await frame.locator('[data-testid="mcp-view"]').innerText()).includes("Refused"), "refusal shown");
  await page.screenshot({ path: `${OUT}/6-refused-light.png` });
  await page.close();
}
{
  const text = JSON.stringify({ columns: ["n"], rows: [[1], [2]], row_count: 2, more: false, elapsed_ms: 1 });
  const { page, frame } = await scene("light", { content: [{ type: "text", text }] }, { input: { connection: "shop" } });
  check((await frame.locator("tbody tr").count()) === 2, "text-only result still draws a grid");
  check(await frame.locator('[data-testid="view-action"]').isHidden(), "no call id: no Open in Rowkery");
  check((await frame.locator('[data-testid="view-connection"]').innerText()) === "shop", "pill falls back to the tool's connection argument");
  await page.close();
}
{
  const { page, frame } = await scene("light", rowsResult, { noTools: true });
  check(await frame.locator('[data-testid="view-action"]').isHidden(), "host that can't call tools: no button");
  await page.close();
}

await browser.close();
if (fails.length) {
  console.error(`\n${fails.length} failed`);
  process.exit(1);
}
console.log(`\nall passed; screenshots in ${OUT}`);
