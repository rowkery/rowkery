#!/usr/bin/env node
// Google Cloud SQL in the New Connection sheet (stubbed `invoke`): Connect
// to switches the identity rows to the Google account and the instance
// picker; the picker lists Postgres instances by project (MySQL counted in
// its foot, a project it couldn't list named, a cap on projects searched),
// filters, takes a typed connection name, and keeps Esc to itself. The probe
// and Save send `cloud_sql` (instance, IP type from Advanced, gcloud or key)
// with no SSH, a refused probe lands under Instance, an address the instance
// lacks under IP (with its cause), and with no gcloud login the picker still
// takes a typed name and the row offers the command and a key file, which
// stays in Rust: the probe and Save send only its id. The connected window's
// sub-line names the instance.
//
//   cd apps/rowkery-tauri && npx vite --port 1420 &
//   node scripts/cloudsql-browser-proof.mjs [outDir]
import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";
import { execSync } from "node:child_process";

const require = createRequire(import.meta.url);
let playwright;
try {
  playwright = require("playwright");
} catch {
  playwright = require(`${execSync("npm root -g").toString().trim()}/playwright`);
}
const OUT = process.argv[2] ?? "/tmp/rowkery-proof/cloudsql";
const URL = process.env.ROWKERY_DEV_URL ?? "http://localhost:1420/";
const FRAMES_SHIM = new globalThis.URL("./lib/frames-shim.js", import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });

function stubTauri(scn) {
  localStorage.clear();
  window.__PROBES__ = [];
  window.__SAVED__ = [];
  window.__EXPLAINED__ = [];
  const col = (name, type_name) => ({ name, type_name, nullable: false });
  const tables = [{ name: "orders", columns: [col("id", "int8")], primary_key: ["id"], indexes: [], foreign_keys: [], row_estimate: { Approximate: 3 }, partition_of: null }];
  const inst = (project, name, region, engine, state = "running") => ({
    project,
    name,
    region,
    engine,
    state,
    postgres: engine.startsWith("Postgres"),
    connection_name: `${project}:${region}:${name}`,
  });
  window.__TAURI_INTERNALS__ = {
    metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
    transformCallback: () => 0,
    invoke: async (cmd, args) => {
      switch (cmd) {
        case "list_connections":
          return { connections: window.__SAVED__, active_connection_id: null };
        case "open_window":
          return { database: "orders", catalog: { databases: [{ name: "orders", schemas: [{ name: "public", tables }] }] }, elapsed_ms: 2, cached: false, open_seq: 1 };
        case "cloudsql_account":
          await new Promise((r) => setTimeout(r, 30));
          if (args.credentials === "key") return args.key ? { kind: "key", email: "reader@acme-prod.iam.gserviceaccount.com" } : null;
          return scn.gcloud ? { kind: "gcloud", email: "dev@acme.dev" } : null;
        case "cloudsql_instances":
          if (args.credentials === "gcloud" && !scn.gcloud) throw "Google login: No gcloud login on this computer";
          if (scn.listError) throw "Cloud SQL Admin API: 403 Cloud Resource Manager API has not been used in project acme-billing before or it is disabled.";
          if (scn.projectsError)
            return {
              instances: args.project ? [inst(args.project, "kioskuno-db-backoffice-prd", "asia-east1", "Postgres 16")] : [],
              skipped: [],
              projects_error: "Cloud Resource Manager API has not been used in project acme-billing before or it is disabled.",
            };
          return {
            instances: [
              inst("acme-prod", "analytics-prd", "asia-southeast1", "Postgres 15"),
              inst("acme-prod", "legacy-crm", "us-central1", "MySQL 8.0"),
              inst("acme-prod", "orders-prd", "asia-southeast1", "Postgres 16"),
              inst("acme-staging", "load-test", "asia-southeast1", "Postgres 16", "stopped"),
              inst("acme-staging", "orders-stg", "asia-southeast1", "Postgres 16"),
            ],
            skipped: ["acme-sandbox"],
            more_projects: true,
          };
        case "cloudsql_key_file":
          return { key: "picked-key-1", account: { kind: "key", email: "reader@acme-prod.iam.gserviceaccount.com" } };
        case "probe_connection": {
          const { connection: c, secrets } = args;
          window.__PROBES__.push({ connection: c, secrets });
          await new Promise((r) => setTimeout(r, 40));
          if (c.cloud_sql?.instance.endsWith(":denied")) return { ok: false, message: "Cloud SQL Admin API: 403 The client is not authorized to make this request.", elapsed_ms: 0 };
          if (c.cloud_sql?.instance.endsWith(":internal-only") && c.cloud_sql.ip_type === "public")
            return { ok: false, message: "Cloud SQL: internal-only has no public IP. Pick Private or PSC under Advanced", elapsed_ms: 0 };
          return { ok: true, message: "PostgreSQL 16.4", elapsed_ms: 412 };
        }
        case "explain_connect_error":
          window.__EXPLAINED__.push(args);
          if (args.error.includes("has no public IP"))
            return { class: "cloudsql_ip", cause: "Internal-only has no public IP. Pick Private or PSC under Advanced.", field: "ipType" };
          return { class: "cloudsql_role", cause: "This Google account can't connect to denied. It needs the Cloud SQL Client role on acme-prod.", field: "instance" };
        case "save_connection":
          window.__SAVED__.push(args.connection);
          window.__SECRETS__ = args.secrets;
          return null;
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

async function sheet(scn, scheme = "light") {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 2, colorScheme: scheme });
  page.on("pageerror", (e) => console.error("pageerror:", e.message));
  page.on("console", (m) => m.type() === "error" && console.error("console:", m.text().slice(0, 400)));
  await page.addInitScript({ path: FRAMES_SHIM });
  await page.addInitScript(stubTauri, scn);
  await page.goto(URL);
  await page.waitForSelector('[data-testid="workspace"]:not([hidden])');
  await page.mouse.click(700, 500);
  await page.keyboard.press("Control+N");
  await page.waitForSelector('[data-testid="nc-sheet"]');
  await page.click('[data-via-choice="cloudsql"]');
  await page.waitForSelector('[data-testid="csql-account"]:not([data-state="loading"])');
  return page;
}
const shot = async (page, name) => {
  const box = await page.locator('[data-testid="nc-sheet"]').boundingBox();
  await page.screenshot({ path: `${OUT}/${name}.png`, clip: { x: box.x, y: 0, width: box.width, height: 900 } });
};
const lastProbe = (page) => page.evaluate(() => window.__PROBES__.at(-1));

// 1. gcloud login found: the account row, no URL field, the picker.
let page = await sheet({ gcloud: true });
check((await page.getAttribute('[data-testid="csql-account"]', "data-state")) === "gcloud", "the gcloud login shows as the account");
check((await page.locator('[data-field="url"]').count()) === 0, "no connection URL field for Cloud SQL");
check((await page.locator('[data-field="host"]').count()) === 0, "no Host / Port for Cloud SQL");
await shot(page, "1-cloudsql-picked");

await page.click('[data-testid="csql-instance"]');
await page.waitForSelector('[data-csql-option="orders-prd"]');
check((await page.locator('[data-csql-option="legacy-crm"]').count()) === 0, "MySQL instances aren't offered");
check((await page.locator("[data-csql-foot]").count()) === 1, "the foot counts MySQL and names a project it couldn't list");
check((await page.textContent("[data-csql-foot]")).includes("Only the first 500 projects searched"), "and says when only some projects were searched");
check((await page.getAttribute('[data-csql-option="load-test"]', "data-state")) === "stopped", "a stopped instance is marked");
await shot(page, "2-instance-picker");

// Esc closes the picker, not the sheet.
await page.keyboard.press("Escape");
check((await page.locator('[data-testid="csql-popover"]').count()) === 0, "Esc closes the picker");
check((await page.locator('[data-testid="nc-sheet"]').count()) === 1, "and leaves the sheet open");

// Filter and Enter.
await page.click('[data-testid="csql-instance"]');
await page.fill("[data-csql-filter]", "orders-p");
await page.keyboard.press("Enter");
check((await page.textContent('[data-testid="csql-instance"]')).includes("acme-prod:asia-southeast1:orders-prd"), "Enter picks the filtered instance");

// The probe sends cloud_sql once Database and User are set.
await page.fill('[data-field="database"] input', "orders");
await page.fill('[data-field="username"] input', "app_rw");
await page.fill('[data-field="password"] input', "secret");
await page.waitForSelector('.nc-probe[data-probe="ok"]', { timeout: 5000 });
let probe = await lastProbe(page);
check(
  probe.connection.cloud_sql?.instance === "acme-prod:asia-southeast1:orders-prd" && probe.connection.cloud_sql.ip_type === "public" && probe.connection.cloud_sql.credentials === "gcloud",
  "the probe sends the instance, public IP and the gcloud login",
);
check(probe.connection.ssh === null && probe.connection.host === "acme-prod:asia-southeast1:orders-prd", "with no SSH, and the instance as its host");
check((await page.getAttribute('[data-field="name"] input', "placeholder")) === "orders-prd", "the name defaults to the instance's");
await shot(page, "3-filled-connected");

// Advanced: IP type.
await page.click('[data-testid="nc-disclosure"]');
await page.click('[data-ip-choice="psc"]');
await page.waitForFunction(() => window.__PROBES__.at(-1)?.connection.cloud_sql?.ip_type === "psc", null, { timeout: 5000 });
check(true, "PSC under Advanced goes into the next probe");
await page.evaluate(() => document.querySelector('[data-field="ipType"]')?.scrollIntoView({ block: "center" }));
await shot(page, "4-advanced");

// A typed connection name the list doesn't have.
await page.evaluate(() => document.querySelector('[data-testid="csql-instance"]')?.scrollIntoView({ block: "center" }));
await page.click('[data-testid="csql-instance"]');
await page.fill("[data-csql-filter]", "acme-prod:asia-southeast1:denied");
await page.waitForSelector('[data-csql-option="typed"]');
await page.keyboard.press("Enter");
await page.waitForSelector('[data-testid="csql-error"]', { timeout: 5000 });
const explained = await page.evaluate(() => window.__EXPLAINED__.at(-1));
check(explained?.cloudSql === "acme-prod:asia-southeast1:denied", "a refused probe is explained with the instance");
check((await page.locator('[data-field="instance"][data-invalid]').count()) === 1, "and marked under Instance");
await shot(page, "5-no-access");

// An address the instance doesn't have: the cause shows under IP.
await page.click('[data-ip-choice="public"]');
await page.click('[data-testid="csql-instance"]');
await page.fill("[data-csql-filter]", "acme-prod:asia-southeast1:internal-only");
await page.waitForSelector('[data-csql-option="typed"]');
await page.keyboard.press("Enter");
await page.waitForSelector('[data-testid="csql-ip-error"]', { timeout: 5000 });
check((await page.textContent('[data-testid="csql-ip-error"]')).includes("has no public IP"), "a missing address's cause shows under IP");
check((await page.locator('[data-field="ipType"][data-invalid]').count()) === 1, "and marks the IP row");
await page.evaluate(() => document.querySelector('[data-field="ipType"]')?.scrollIntoView({ block: "center" }));
await shot(page, "5b-no-public-ip");

await page.close();

// Save.
page = await sheet({ gcloud: true });
await page.click('[data-testid="csql-instance"]');
await page.click('[data-csql-option="orders-stg"]');
await page.fill('[data-field="database"] input', "orders");
await page.fill('[data-field="username"] input', "app_rw");
await page.fill('[data-field="password"] input', "secret");
await page.waitForSelector('.nc-probe[data-probe="ok"]', { timeout: 5000 });
await page.keyboard.press("Control+Enter");
await page.waitForSelector('[data-testid="nc-sheet"]', { state: "detached", timeout: 5000 });
const saved = await page.evaluate(() => window.__SAVED__.at(-1));
check(saved?.cloud_sql?.instance === "acme-staging:asia-southeast1:orders-stg" && saved.name === "orders-stg", "Save keeps the instance and names it after it");
check(saved?.environment === "stg", "the environment is suggested from the instance name");
await page.waitForSelector("[data-sb-sub]", { timeout: 5000 });
check((await page.textContent("[data-sb-sub]")).trim() === "orders-stg", "the connected window's sub-line names the instance");
await page.screenshot({ path: `${OUT}/6-connected-window.png` });
await page.close();

// 2. No gcloud login: the command, then a key file.
page = await sheet({ gcloud: false });
check((await page.getAttribute('[data-testid="csql-account"]', "data-state")) === "none", "no gcloud login reads as none");
check((await page.locator("[data-csql-copy]").count()) === 1, "with the gcloud command to copy");
await shot(page, "7-no-gcloud-login");
// The picker still takes a typed name with no login to list instances.
await page.click('[data-testid="csql-instance"]');
await page.fill("[data-csql-filter]", "acme-prod:asia-southeast1:orders-new");
await page.waitForSelector('[data-csql-option="typed"]');
check((await page.locator("[data-csql-list-error]").count()) === 1, "with no login, the picker can't list instances");
check(true, "but still takes a typed connection name");
await page.fill("[data-csql-filter]", "");
await page.keyboard.press("Escape");
await page.click("[data-csql-key]");
await page.waitForSelector('[data-testid="csql-account"][data-state="key"]', { timeout: 5000 });
check(true, "a key file signs in as its service account");
await shot(page, "8-service-account-key");
await page.click('[data-testid="csql-instance"]');
await page.click('[data-csql-option="orders-prd"]');
await page.fill('[data-field="database"] input', "orders");
await page.fill('[data-field="username"] input', "app_rw");
await page.fill('[data-field="password"] input', "secret");
await page.waitForSelector('.nc-probe[data-probe="ok"]', { timeout: 5000 });
probe = await lastProbe(page);
check(probe.connection.cloud_sql?.credentials === "key" && probe.secrets.gcp_key === "picked-key-1", "the probe sends the picked key's id, never the key, with the key login");
await page.keyboard.press("Control+Enter");
await page.waitForSelector('[data-testid="nc-sheet"]', { state: "detached", timeout: 5000 });
const secrets = await page.evaluate(() => window.__SECRETS__);
check(secrets?.gcp_key === "picked-key-1", "Save hands the picked key's id over with the password");
await page.close();

// 3. A long connection name stays on one line; Google's reason shows when listing fails.
page = await sheet({ gcloud: true, listError: true });
await page.click('[data-testid="csql-instance"]');
await page.fill("[data-csql-filter]", "kioskunoprod:asia-east1:kioskuno-db-backoffice-prd");
await page.waitForSelector('[data-csql-option="typed"]');
const name = page.locator('[data-csql-option="typed"] .csql-option-name');
check((await name.textContent()) === "kioskuno-db-backoffice-prd", "a typed name shows the instance's own name");
const fits = await name.evaluate((el) => el.getBoundingClientRect().height < 20 && el.closest("button").scrollHeight <= el.closest("button").clientHeight);
check(fits, "a long name stays on one line inside its row");
check((await page.locator(".csql-list-why").textContent()).includes("Cloud Resource Manager API"), "the picker says why it couldn't list instances");
await shot(page, "10-long-name-list-error");
await page.click('[data-csql-option="typed"]');
await page.close();

// 4. Google won't list projects: the named project is searched, and the foot says so.
page = await sheet({ gcloud: true, projectsError: true });
await page.click('[data-testid="csql-instance"]');
await page.fill("[data-csql-filter]", "kioskunoprod:asia-east1:kioskuno-db-backoffice-prd");
await page.keyboard.press("Enter");
await page.click('[data-testid="csql-instance"]');
await page.waitForSelector('[data-csql-option="kioskuno-db-backoffice-prd"]');
check((await page.locator("[data-csql-foot]").textContent()).includes("Couldn't list your projects"), "the foot says only some projects were searched");
await shot(page, "11-projects-error");
await page.close();

// 5. Dark.
page = await sheet({ gcloud: true }, "dark");
await page.click('[data-testid="csql-instance"]');
await page.waitForSelector('[data-csql-option="orders-prd"]');
await shot(page, "9-instance-picker-dark");
await page.close();

await browser.close();
