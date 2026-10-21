#!/usr/bin/env node
// Schema map (Map view on a table tab), stubbed `invoke`, light and dark.
// Proves: Map opens from Data | Structure | Map, ⌥⌘3 (Ctrl+Alt+3 here) and
// ⌘K "Show map"; the table sits in the middle with what it points to on the
// left and what points to it on the right, key columns only, each line marked
// 1 / n; hovering a line shows the key and its on delete rule; a click
// re-centres (a step ‹ undoes), 2 steps dims the far boxes; arrows move the
// ring, ↵ opens the table, Esc goes back to Data; a self-reference loops and a
// composite key lists every column; All is off above 150 tables. No query runs
// for the map. Screenshots go to outDir, by default /tmp/rowkery-proof/schema-map:
// 1-orders, 2-hover, 3-recentred-2-steps, 4-self-composite, 1-orders-dark.
//
//   cd apps/rowkery-tauri && npx vite --port 1420 &
//   node scripts/schema-map-browser-proof.mjs [outDir]
import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";
import { execSync } from "node:child_process";

const LINUX_PLATFORM = new globalThis.URL("./lib/linux-platform.js", import.meta.url).pathname;

const require = createRequire(import.meta.url);
let playwright;
try {
  playwright = require("playwright");
} catch {
  playwright = require(`${execSync("npm root -g").toString().trim()}/playwright`);
}
const OUT = process.argv[2] ?? "/tmp/rowkery-proof/schema-map";
const URL = process.env.ROWKERY_DEV_URL ?? "http://localhost:1420/";
mkdirSync(OUT, { recursive: true });

function stubTauri(extraTables) {
  localStorage.clear();
  const col = (name, type_name = "bigint") => ({ name, type_name, nullable: false });
  const fk = (columns, ref_table, ref_columns = ["id"], on_delete = "NO ACTION") => ({
    name: `${ref_table}_${columns.join("_")}_fkey`,
    columns,
    ref_schema: "public",
    ref_table,
    ref_columns,
    on_delete,
  });
  const t = (name, rows, columns, foreign_keys = [], primary_key = ["id"]) => ({
    name,
    kind: "table",
    columns,
    primary_key,
    foreign_keys,
    indexes: [],
    row_estimate: { Approximate: rows },
    partition_of: null,
  });
  const tables = [
    t("customers", 900, [col("id"), col("name", "text"), col("email", "text")]),
    t("addresses", 1200, [col("id"), col("customer_id"), col("street", "text")], [fk(["customer_id"], "customers", ["id"], "CASCADE")]),
    t("coupons", 38, [col("id", "text"), col("percent", "integer")]),
    t(
      "orders",
      48210,
      [col("id"), col("customer_id"), col("address_id"), col("coupon_id", "text"), col("total", "numeric(12,2)"), col("created_at", "timestamp with time zone")],
      [fk(["customer_id"], "customers", ["id"], "CASCADE"), fk(["address_id"], "addresses"), fk(["coupon_id"], "coupons", ["id"], "SET NULL")],
    ),
    t("order_items", 120000, [col("id"), col("order_id"), col("product_id"), col("qty", "integer")], [fk(["order_id"], "orders", ["id"], "CASCADE"), fk(["product_id"], "products")]),
    t("payments", 51000, [col("id"), col("order_id"), col("amount", "numeric")], [fk(["order_id"], "orders")]),
    t("shipments", 47000, [col("id"), col("order_id")], [fk(["order_id"], "orders")]),
    t("refunds", 2100, [col("id"), col("order_id")], [fk(["order_id"], "orders")]),
    t("products", 3400, [col("id"), col("category_id"), col("title", "text")], [fk(["category_id"], "categories")]),
    t("categories", 64, [col("id"), col("parent_id"), col("name", "text")], [fk(["parent_id"], "categories")]),
    t("terms", 12, [col("year", "integer"), col("term", "integer"), col("label", "text")], [], ["year", "term"]),
    t("reviews", 300, [col("id"), col("order_id"), col("customer_id"), col("stars", "integer")]),
    t("grades", 800, [col("id"), col("year", "integer"), col("term", "integer")], [fk(["year", "term"], "terms", ["year", "term"])]),
    ...Array.from({ length: extraTables }, (_, i) => t(`spare_${String(i).padStart(3, "0")}`, 1, [col("id")])),
  ];
  window.__queries = [];
  let nextId = 0;
  window.__TAURI_INTERNALS__ = {
    metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
    transformCallback: () => 0,
    invoke: async (cmd, args) => {
      const { onFrame, ...rest } = args ?? {};
      if (/query|browse|count/.test(cmd)) window.__queries.push(cmd);
      switch (cmd) {
        case "list_connections":
          return { connections: [{ kind: "postgres", id: "pg", name: "shop", host: "db", port: 5432, database: "shop", username: "rowkery" }], active_connection_id: null };
        case "open_window":
          return { database: "shop", catalog: { databases: [{ name: "shop", schemas: [{ name: "public", tables }] }] }, elapsed_ms: 2, cached: false, open_seq: 1 };
        case "browse_table": {
          const queryId = ++nextId;
          const tb = tables.find((x) => x.name === rest.table);
          setTimeout(() => {
            const send = (f) => onFrame.onmessage({ query_id: queryId, ...f });
            send({ t: "columns", columns: tb.columns.map((c) => ({ name: c.name, type_name: "text" })) });
            send({ t: "done", status: "ok", row_count: 0, affected_rows: null, elapsed_ms: 1, first_row_ms: 1, frames: 1, error: null, sqlstate: null, error_position: null, hold: null });
          }, 5);
          return { query_id: queryId, sql: `SELECT * FROM public.${rest.table};` };
        }
        case "count_rows":
          return 0;
        default:
          return null;
      }
    },
  };
}

const check = (cond, msg) => {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    process.exitCode = 1;
  } else console.log(`ok: ${msg}`);
};
const browser = await playwright.chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? "/opt/pw-browsers/chromium" });
const ws = '[data-testid="workspace"]:not([hidden])';
const map = `${ws} [data-testid="schema-map"]`;
const box = (name) => `${map} [data-testid="sm-box"][data-table="shop.public.${name}"]`;

async function open(extraTables = 0) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 820 }, deviceScaleFactor: 2, colorScheme: "light" });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.addInitScript({ path: LINUX_PLATFORM });
  await page.addInitScript(stubTauri, extraTables);
  await page.goto(URL);
  await page.waitForSelector(ws);
  await page.keyboard.press("Control+Shift+O");
  await page.waitForSelector('[data-testid="conn-popover"]');
  await page.keyboard.press("Enter");
  await page.waitForSelector(`${ws}[data-conn-state="connected"]`);
  return { page, errors };
}

const { page, errors } = await open();
const shot = async (name, clip = true) => {
  await page.mouse.move(1, 1).catch(() => {});
  await page.waitForTimeout(250);
  const root = clip ? await page.locator(`${ws} [data-testid="results-card"]`).boundingBox() : null;
  await page.screenshot({ path: `${OUT}/${name}.png`, clip: root ?? undefined });
  console.log(`${OUT}/${name}.png`);
};
const names = (sel) => page.$$eval(sel, (els) => els.map((e) => e.dataset.table.split(".").pop()));
const centre = () => page.getAttribute(map, "data-centre");

// 1. The switch's third segment opens the map: orders in the middle.
await page.click(`${ws} [data-table="shop.public.orders"] [data-testid="sb-row-main"]`);
await page.waitForSelector(`${ws} [data-testid="view-switch"] [data-view="map"]`);
const queriesBefore = await page.evaluate(() => window.__queries.length);
await page.click(`${ws} [data-testid="view-switch"] [data-view="map"]`);
await page.waitForSelector(box("orders"));
check((await centre()) === "shop.public.orders", "Map is centred on the tab's table");
check(
  (await page.getAttribute(`${ws} [data-testid="view-switch"] [data-view="map"]`, "aria-selected")) === "true",
  "the switch shows Map",
);
const summary = await page.textContent(`${map} [data-testid="sm-summary"]`);
// Text on purpose: the summary line is what's under test.
check(summary === "orders · 3 tables it points to · 4 point to it", `summary: ${summary}`);
const xOf = async (name) => (await page.locator(box(name)).boundingBox()).x;
const ox = await xOf("orders");
const left = ["customers", "addresses", "coupons"];
const right = ["order_items", "payments", "shipments", "refunds"];
check((await Promise.all(left.map(xOf))).every((x) => x < ox), "what orders points to sits on the left");
check((await Promise.all(right.map(xOf))).every((x) => x > ox), "what points to orders sits on the right");
check((await names(`${map} [data-testid="sm-box"]`)).length === 8, "1 step: eight boxes, no products or categories");
const cols = await page.$$eval(`${box("orders")} [data-column]`, (els) => els.map((e) => `${e.dataset.kind}:${e.dataset.column}`));
check(cols.join(" ") === "pk:id fk:customer_id fk:address_id fk:coupon_id", `orders lists key columns only: ${cols.join(" ")}`);
const marks = await page.$$eval(`${map} [data-edge="shop.public.orders:customers_customer_id_fkey"] [data-end]`, (els) => els.map((e) => e.textContent));
check(marks.join(",") === "n,1", `orders → customers is marked n … 1 (${marks})`);
check((await page.evaluate(() => window.__queries.length)) === queriesBefore, "the map ran no query");
await shot("1-orders");

// 2. Hovering a line names the key and its rule, and lights both ends.
const hit = page.locator(`${map} [data-edge="shop.public.orders:customers_customer_id_fkey"] [data-hit]`);
const hb = await hit.boundingBox();
await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2);
await page.waitForTimeout(80);
let tip = await page.textContent(`${map} [data-testid="sm-tip"]`).catch(() => null);
if (!tip) {
  // The curve's box middle can miss the stroke: walk along it.
  for (let f = 0.1; f < 1 && !tip; f += 0.1) {
    const p = await hit.evaluate((el, f) => el.getPointAtLength(el.getTotalLength() * f), f);
    const svg = await page.locator(`${map} [data-testid="sm-lines"]`).boundingBox();
    await page.mouse.move(svg.x + p.x, svg.y + p.y);
    await page.waitForTimeout(40);
    tip = await page.locator(`${map} [data-testid="sm-tip"]`).textContent({ timeout: 100 }).catch(() => null);
  }
}
check(tip === "orders.customer_id → customers.id · on delete cascade", `hover: ${tip}`);
check((await page.getAttribute(`${box("customers")} [data-column="id"]`, "data-lit")) === "", "the parent's column lights up");
await page.screenshot({ path: `${OUT}/2-hover.png`, clip: await page.locator(`${ws} [data-testid="results-card"]`).boundingBox() });
console.log(`${OUT}/2-hover.png`);
await page.mouse.move(1, 1);

// 3. A click re-centres; 2 steps reaches further and dims the second step; ‹ goes back.
const centredOn = (key) =>
  page
    .waitForFunction(([sel, key]) => document.querySelector(sel)?.dataset.centre === key, [map, key], { timeout: 3000 })
    .then(() => true, () => false);
await page.click(box("order_items"));
check(await centredOn("shop.public.order_items"), "a click re-centres on order_items");
await page.click(`${map} [data-testid="sm-depths"] [data-depth="2"]`);
await page.waitForSelector(box("categories"));
check((await page.getAttribute(box("categories"), "data-far")) === "", "2 steps: categories (two away) is dimmed");
check((await page.getAttribute(box("products"), "data-far")) === null, "products (one away) is not");
check((await page.getAttribute(box("customers"), "data-far")) === "", "customers, two away through orders, is dimmed");
check(!(await page.$(box("payments"))), "payments (it points at orders, not up from order_items) is left out");
await shot("3-recentred-2-steps");
// A depth change that drops the ringed box hands the ring back to the centre.
await page.click(`${map} [data-testid="sm-depths"] [data-depth="2"]`);
await page.focus(map);
await page.keyboard.press("ArrowLeft");
await page.keyboard.press("ArrowLeft");
await page.click(`${map} [data-testid="sm-depths"] [data-depth="1"]`);
check((await page.$eval(`${map} [data-sel]`, (e) => e.dataset.table)) === "shop.public.order_items", "1 step: the ring goes back to the centre");
await page.keyboard.press("Alt+ArrowLeft");
check(await centredOn("shop.public.orders"), "‹ goes back to the map centred on orders");

// 4. Arrows move the ring, ↵ opens that table; Esc on a map goes back to Data.
await page.focus(map);
await page.keyboard.press("ArrowLeft");
const sel1 = await page.$eval(`${map} [data-sel]`, (e) => e.dataset.table);
check(sel1 !== "shop.public.orders" && left.includes(sel1.split(".").pop()), `← moves to the left column (${sel1})`);
await page.keyboard.press("ArrowRight");
await page.keyboard.press("ArrowRight");
const sel2 = await page.$eval(`${map} [data-sel]`, (e) => e.dataset.table);
check(right.includes(sel2.split(".").pop()), `→ → moves to the right column (${sel2})`);
await page.keyboard.press("Enter");
await page.waitForFunction(
  (t) => document.querySelector('[data-testid="workspace"]:not([hidden]) [data-testid="query-tab"][data-on]')?.textContent.includes(t),
  sel2.split(".").pop(),
);
check(!(await page.$(map)), `↵ opened ${sel2.split(".").pop()} in Data`);
await page.keyboard.press("Control+Alt+3");
await page.waitForSelector(map);
check((await centre()) === sel2, "Ctrl+Alt+3 shows its map");
check(await page.$eval(map, (el) => el === document.activeElement), "the map has the keys when asked for");
await page.keyboard.press("Escape");
await page.waitForSelector(map, { state: "detached" });
await page.waitForTimeout(100);
check(await page.evaluate(() => !!document.activeElement?.closest('[data-testid="results-grid-wrap"]')), "Esc hands the keys to the grid");
check(
  (await page.getAttribute(`${ws} [data-testid="view-switch"] [data-view="data"]`, "aria-selected")) === "true",
  "Esc goes back to Data",
);

// 5. ⌘K "Show map".
await page.keyboard.press("Control+k");
await page.waitForSelector('[data-testid="cp-panel"]');
await page.keyboard.type(">show map");
await page.waitForSelector('[data-item="cmd:show-map"]');
await page.click('[data-item="cmd:show-map"]');
check(!!(await page.waitForSelector(map)), "⌘K Show map opens the map");

// A double-click opens the box: its first click re-centres, the second opens what it centred.
await page.dblclick(box("orders"));
await page.waitForSelector(map, { state: "detached" });
check(
  (await page.textContent(`${ws} [data-testid="query-tab"][data-on]`)).includes("orders"),
  "a double-click on orders opens it",
);

// 6. A self-reference loops back into its box; a composite key lists every column.
await page.click(`${ws} [data-table="shop.public.categories"] [data-testid="sb-row-main"]`);
await page.click(`${ws} [data-testid="view-switch"] [data-view="map"]`);
await page.waitForFunction((sel) => document.querySelector(sel)?.dataset.centre === "shop.public.categories", map);
const loop = await page.getAttribute(`${map} [data-edge="shop.public.categories:categories_parent_id_fkey"] [data-line]`, "d");
const [mx] = loop.slice(1).split(",").map(Number);
const cb = await page.locator(box("categories")).boundingBox();
const svg = await page.locator(`${map} [data-testid="sm-lines"]`).boundingBox();
check(Math.abs(svg.x + mx - (cb.x + cb.width)) < 2, "categories.parent_id loops out of and back into its own box");
await page.click(`${ws} [data-table="shop.public.grades"] [data-testid="sb-row-main"]`);
await page.click(`${ws} [data-testid="view-switch"] [data-view="map"]`);
await page.waitForSelector(box("terms"));
const tcols = await page.$$eval(`${box("terms")} [data-column]`, (els) => els.map((e) => e.dataset.column));
check(tcols.join(",") === "year,term", `terms lists both columns of its key (${tcols})`);
await shot("4-self-composite");

// 7. Guess links: off, reviews (no foreign keys) stays away; on, its order_id is a dashed line.
await page.click(`${ws} [data-table="shop.public.orders"] [data-testid="sb-row-main"]`);
await page.click(`${ws} [data-testid="view-switch"] [data-view="map"]`);
await page.waitForSelector(box("orders"));
const guessSwitch = `${map} [data-testid="sm-guess"]`;
check((await page.getAttribute(guessSwitch, "aria-checked")) === "false", "Guess links is off by default");
check(!(await page.$(box("reviews"))), "off: reviews, with no foreign key, is not on the map");
await page.click(guessSwitch);
await page.waitForSelector(box("reviews"));
const guessEdge = `${map} [data-edge="shop.public.reviews:guess:order_id"]`;
check((await page.getAttribute(guessEdge, "data-guessed")) === "", "on: reviews.order_id → orders is a guessed line");
check((await page.$$(`${map} [data-guessed]`)).length === 1, "only the guess is dashed; real keys stay solid");
await page.hover(`${guessEdge} [data-hit]`);
const gtip = (await page.textContent(`${map} [data-testid="sm-tip"]`)).trim();
check(gtip === "reviews.order_id → orders.id · guessed from the name, no foreign key", `hover: ${gtip}`);
await shot("5-guessed");
await page.click(guessSwitch);
await page.waitForSelector(box("reviews"), { state: "detached" });
check((await page.getAttribute(guessSwitch, "aria-checked")) === "false", "off again: the guess goes");

// 8. Dark.
await page.emulateMedia({ colorScheme: "dark" });
await page.waitForFunction(() => document.documentElement.dataset.theme === "dark");
await shot("1-orders-dark");
check(errors.length === 0, `no page errors (${errors.join("; ")})`);

// 9. Above 150 tables, All is off and the steps stay.
const big = await open(150);
await big.page.click(`${ws} [data-table="shop.public.orders"] [data-testid="sb-row-main"]`);
await big.page.click(`${ws} [data-testid="view-switch"] [data-view="map"]`);
await big.page.waitForSelector(box("orders"));
check(await big.page.isDisabled(`${map} [data-testid="sm-depths"] [data-depth="all"]`), "All is off with 163 tables");
check(!(await big.page.isDisabled(`${map} [data-testid="sm-depths"] [data-depth="2"]`)), "2 steps stays on");
check(big.errors.length === 0, `no page errors on the big schema (${big.errors.join("; ")})`);
await browser.close();
