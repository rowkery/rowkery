#!/usr/bin/env node
// Docs screens for /google-cloud-sql/, from the running app (Vite) with the docs' stubbed
// storefront backend plus a Google account and five Cloud SQL instances in two projects:
//  - google-cloud-sql-form: New connection with Connect to set to Cloud SQL, filled in and probed;
//  - google-cloud-sql-picker: the instance picker, grouped by project, with its foot;
//  - google-cloud-sql-no-login: the Google account row when this Mac has no gcloud login;
//  - google-cloud-sql-failed: Couldn't connect, for an account without the Cloud SQL Client role.
// Not a proof (scripts/cloudsql-browser-proof.mjs is): it checks nothing beyond waiting for each screen.
//
//   cd apps/rowkery-tauri && npx vite --port 1420 &
//   node scripts/docs-shots/cloud-sql.mjs [outDir] [--write] [--only=picker,failed]
import { openApp, shot, close, sizes, settle, wanted, WS } from "./lib.mjs";

/** Runs in the page after the base stub: the Google side of the form, and a failing saved instance. */
function more(cfg) {
  const D = window.__DOCS__;
  const inst = (project, name, region, engine, state = "running") => ({
    project,
    name,
    region,
    engine,
    state,
    postgres: engine.startsWith("Postgres"),
    connection_name: `${project}:${region}:${name}`,
  });
  D.connections.push({
    kind: "postgres",
    id: "billing",
    name: "billing-prd",
    host: "acme-prod:europe-west1:billing-prd",
    port: 5432,
    database: "billing",
    username: "app",
    environment: "prd",
    safe_mode: "confirm",
    cloud_sql: { instance: "acme-prod:europe-west1:billing-prd", ip_type: "public", credentials: "gcloud" },
  });
  window.__STUB_MORE__ = async (cmd, a) => {
    switch (cmd) {
      case "load_ui_state":
        return cfg.seed ? { version: 1, keys: structuredClone(cfg.seed) } : undefined;
      case "open_window":
        if (a.connectionId === "billing") {
          await new Promise((r) => setTimeout(r, 80));
          throw "Cloud SQL Admin API: 403 The client is not authorized to make this request.";
        }
        return undefined;
      case "explain_connect_error":
        return {
          class: "cloudsql_role",
          cause: "This Google account can't connect to billing-prd. It needs the Cloud SQL Client role on acme-prod.",
          field: "instance",
        };
      case "cloudsql_account":
        await new Promise((r) => setTimeout(r, 30));
        return cfg.gcloud ? { kind: "gcloud", email: "maya@acme.dev" } : null;
      case "cloudsql_instances":
        return {
          instances: [
            inst("acme-prod", "analytics-prd", "europe-west1", "Postgres 15"),
            inst("acme-prod", "billing-prd", "europe-west1", "Postgres 16"),
            inst("acme-prod", "legacy-crm", "us-central1", "MySQL 8.0"),
            inst("acme-prod", "orders-prd", "europe-west1", "Postgres 16"),
            inst("acme-staging", "load-test", "europe-west1", "Postgres 16", "stopped"),
            inst("acme-staging", "orders-stg", "europe-west1", "Postgres 16"),
          ],
          skipped: ["acme-sandbox"],
        };
      case "probe_connection":
        await new Promise((r) => setTimeout(r, 40));
        return { ok: true, message: "PostgreSQL 16.4", elapsed_ms: 412 };
      default:
        return undefined;
    }
  };
}

const SHEET = '[data-testid="nc-sheet"]';
async function sheet(cfg = { gcloud: true }) {
  const src = `(${more.toString()})(${JSON.stringify(cfg)});`;
  const { page, context } = await openApp({ h: 900, more: { content: src } });
  await page.keyboard.press("Meta+n");
  await page.waitForSelector(SHEET);
  await page.click('[data-via-choice="cloudsql"]');
  await page.waitForSelector('[data-testid="csql-account"]:not([data-state="loading"])');
  return { page, context };
}
const fill = async (page, instance) => {
  await page.click('[data-testid="csql-instance"]');
  await page.click(`[data-csql-option="${instance}"]`);
  await page.fill('[data-field="database"] input', "orders");
  await page.fill('[data-field="username"] input', "app");
  await page.fill('[data-field="password"] input', "secret");
  await page.waitForSelector('.nc-probe[data-probe="ok"]');
};

// The form and the picker, signed in with gcloud.
if (wanted("google-cloud-sql-form") || wanted("google-cloud-sql-picker")) {
  const { page, context } = await sheet();
  if (wanted("google-cloud-sql-picker")) {
    await page.click('[data-testid="csql-instance"]');
    await page.waitForSelector('[data-csql-option="orders-prd"]');
    await page.hover('[data-csql-option="orders-prd"]');
    await shot(page, "google-cloud-sql-picker", { el: '[data-testid="csql-popover"]', pad: 4, mouse: false });
    await page.keyboard.press("Escape");
  }
  await fill(page, "orders-prd");
  await shot(page, "google-cloud-sql-form", { el: SHEET });
  await context.close();
}

// The Google account row with no gcloud login.
if (wanted("google-cloud-sql-no-login")) {
  const { page, context } = await sheet({ gcloud: false });
  await shot(page, "google-cloud-sql-no-login", { el: '[data-field="account"]', pad: 14 });
  await context.close();
}

// Couldn't connect: a restored window whose account lacks the Cloud SQL Client role.
if (wanted("google-cloud-sql-failed")) {
  const seed = { "rowkery.windows": { windows: [{ connectionId: "billing", database: "billing" }], active: 0 } };
  const src = `(${more.toString()})(${JSON.stringify({ gcloud: true, seed })});`;
  const { page, context } = await openApp({ connect: false, more: { content: src } });
  await page.waitForSelector(`${WS} [data-connect-error] [data-cause]`);
  await settle(page);
  await shot(page, "google-cloud-sql-failed", { clip: { x: 264, y: 48, width: 1016, height: 480 } });
  await context.close();
}

await close();
sizes();
