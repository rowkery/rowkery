#!/usr/bin/env node
// End-to-end run on the real app:
// builds Rowkery with `--features e2e` into target/e2e, starts the Docker
// Postgres from docker-compose.test.yml with a fresh `rowkery_e2e` database
// (scripts/test-seed.sql + scripts/e2e/fixtures.sql) and a SQLite file,
// then runs every suite in scripts/e2e/suites/ against a fresh app and config
// dir each. A test fails on a wrong result, a page error, a hang (the page
// stops answering; `sample` is saved) or a crash (the app exits, or macOS
// writes an .ips report). Writes report.json and report.md to the out dir.
//
//   node scripts/e2e/run.mjs                    # build, then every suite
//   node scripts/e2e/run.mjs --no-build         # reuse target/e2e
//   node scripts/e2e/run.mjs --only CON-3,QRY   # tests whose id starts with these
//   node scripts/e2e/run.mjs --out /tmp/x       # default /tmp/rowkery-proof/e2e
//
// macOS is the target (WebKit, the packaged layout); it also runs on Linux
// under Xvfb with WEBKIT_DISABLE_DMABUF_RENDERER=1.
import { execSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { App } from "./app.mjs";
import { PG } from "./helpers.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "../..");
const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const opt = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : fallback;
};
const out = opt("--out", "/tmp/rowkery-proof/e2e");
const only = opt("--only", "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const targetDir = join(root, "target/e2e");
const bin = join(targetDir, "release", process.platform === "win32" ? "rowkery-tauri.exe" : "rowkery-tauri");
const sh = (cmd, o = {}) => execSync(cmd, { cwd: root, stdio: "pipe", ...o }).toString();
const say = (s) => console.log(`\x1b[1;36m==>\x1b[0m ${s}`);

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

if (!flag("--no-build")) {
  say("building Rowkery with the e2e hook into target/e2e");
  const r = spawnSync("npm", ["run", "tauri", "build", "--", "--features", "e2e", "--no-bundle"], {
    cwd: join(root, "apps/rowkery-tauri"),
    // A proof build: persist.ts leaves the shared WebKit localStorage alone.
    env: { ...process.env, CARGO_TARGET_DIR: targetDir, VITE_ROWKERY_AUTO_PROOF: "e2e" },
    stdio: ["ignore", "inherit", "inherit"],
  });
  if (r.status !== 0) process.exit(r.status ?? 1);
}
if (!existsSync(bin)) {
  console.error(`no ${bin}; run without --no-build`);
  process.exit(1);
}

say(`Postgres on ${PG.host}:${PG.port}, fresh ${PG.database}`);
const psql = (db, cmd) => sh(`psql -v ON_ERROR_STOP=1 -q -h ${PG.host} -p ${PG.port} -U ${PG.user} -d ${db} ${cmd}`, { env: { ...process.env, PGPASSWORD: PG.password } });
try {
  sh(`pg_isready -h ${PG.host} -p ${PG.port} -U ${PG.user}`);
} catch {
  sh("docker compose -f docker-compose.test.yml up -d postgres");
  for (let i = 0; i < 60; i++) {
    try {
      sh(`pg_isready -h ${PG.host} -p ${PG.port} -U ${PG.user}`);
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
}
for (const db of [PG.database, "rowkery_e2e_orders"]) {
  psql("postgres", `-c "DROP DATABASE IF EXISTS ${db} WITH (FORCE)" -c "CREATE DATABASE ${db}"`);
}
psql(PG.database, `-f scripts/test-seed.sql -f scripts/e2e/fixtures.sql`);
psql("rowkery_e2e_orders", `-c "CREATE TABLE orders (id bigint PRIMARY KEY, status text); INSERT INTO orders SELECT g, 'new' FROM generate_series(1, 10) g"`);

const sqlitePath = join(out, "fixture.sqlite");
sh(
  `sqlite3 ${JSON.stringify(sqlitePath)} "CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT NOT NULL, done INTEGER DEFAULT 0); WITH RECURSIVE g(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM g WHERE n < 500) INSERT INTO notes (body, done) SELECT 'note ' || n, n % 2 FROM g; CREATE TABLE tags (name TEXT);"`,
);

const suites = [];
for (const f of readdirSync(join(here, "suites")).filter((f) => f.endsWith(".mjs")).sort()) {
  const mod = await import(join(here, "suites", f));
  suites.push({ file: f, ...mod.default });
}

const results = [];
let port = 47_310;
for (const suite of suites) {
  const tests = suite.tests.filter((t) => !only.length || only.some((o) => t.id.startsWith(o)));
  if (!tests.length) continue;
  say(`${suite.name} (${tests.length})`);
  let app = null;
  let configDir = null;
  const launch = async ({ fresh = true, env = {} } = {}) => {
    if (fresh || !configDir) configDir = mkdtempSync(join(tmpdir(), "rowkery-e2e-"));
    app = await App.launch({ bin, out, name: suite.file.replace(/\.mjs$/, ""), configDir, port: port++, env: { ...suite.env, ...env } });
    if (fresh && suite.setup) await suite.setup(ctx());
    return app;
  };
  const ctx = () => ({
    app,
    out,
    sqlitePath,
    /** A new app on a fresh config dir. */
    relaunch: async () => {
      await app.kill();
      return launch();
    },
    /** Quits through the window (config.json flushed), then launches on the same config dir. */
    restart: async ({ env } = {}) => {
      await app.quit();
      return launch({ fresh: false, env });
    },
    /** Kills the process (no flush), then launches on the same config dir. */
    crashRestart: async () => {
      await app.kill();
      return launch({ fresh: false });
    },
  });
  for (const t of tests) {
    const started = Date.now();
    let status = "pass";
    let error = null;
    let notes = null;
    try {
      if (!app || app.exited || app.dead) await launch();
      notes = (await t.run(ctx())) ?? null;
      const errs = await app.takeErrors();
      if (errs.length) throw new Error(`page errors: ${errs.map((e) => `${e.kind}: ${e.text.split("\n")[0]}`).join(" | ")}`);
    } catch (e) {
      status = e.kind === "crash" || (app?.exited && !app.quitting) ? "crash" : e.kind === "hang" ? "hang" : "fail";
      error = String(e.message ?? e).replace(/\s+/g, " ").slice(0, 600);
      if (app && !app.exited) {
        // A failed step can leave a sheet open; the next test starts clean.
        await app.kill();
      }
    }
    const crashes = app?.crashReports() ?? [];
    if (crashes.length && status === "pass") {
      status = "crash";
      error = `crash report ${crashes[0]}`;
    }
    const ms = Date.now() - started;
    results.push({ id: t.id, title: t.title, suite: suite.name, status, ms, error, notes, hangs: app?.hangs?.splice(0) ?? [] });
    const mark = status === "pass" ? "\x1b[32m✓\x1b[0m" : "\x1b[31m✗\x1b[0m";
    console.log(`  ${mark} ${t.id} ${t.title} (${ms} ms)${error ? ` — ${status}: ${error.slice(0, 300)}` : ""}${notes ? ` · ${typeof notes === "string" ? notes : JSON.stringify(notes)}` : ""}`);
  }
  if (app && !app.exited) {
    try {
      const exit = await app.quit();
      // Dying of a signal while it closes is a crash too (macOS writes its report seconds later).
      if (exit.signal || (exit.code ?? 0) !== 0) {
        const error = `exited with ${exit.signal ?? `code ${exit.code}`} while quitting`;
        results.push({ id: `${suite.name}/quit`, title: "quits when its window closes", suite: suite.name, status: "crash", ms: 0, error });
        console.log(`  \x1b[31m✗\x1b[0m quit — crash: ${error}`);
      }
    } catch (e) {
      results.push({ id: `${suite.name}/quit`, title: "quits when its window closes", suite: suite.name, status: e.kind ?? "fail", ms: 0, error: e.message });
    }
  }
}

const failed = results.filter((r) => r.status !== "pass");
writeFileSync(join(out, "report.json"), JSON.stringify({ at: new Date().toISOString(), commit: sh("git rev-parse --short HEAD").trim(), results }, null, 2));
const md = [
  `# End-to-end run · ${new Date().toISOString()} · ${sh("git rev-parse --short HEAD").trim()}`,
  "",
  `${results.length - failed.length} passed, ${failed.length} failed`,
  "",
  "| id | test | result | ms | detail |",
  "|---|---|---|---|---|",
  ...results.map((r) => `| ${r.id} | ${r.title} | ${r.status} | ${r.ms} | ${(r.error ?? (r.notes ? JSON.stringify(r.notes) : "")).replace(/\|/g, "\\|")} |`),
];
writeFileSync(join(out, "report.md"), md.join("\n") + "\n");
say(`${results.length - failed.length} passed, ${failed.length} failed · ${out}/report.md`);
process.exit(failed.length ? 1 : 0);
