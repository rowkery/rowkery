#!/usr/bin/env node
// `npm run tauri …`: the Tauri CLI, with this build's Content-Security-Policy.
// The report relay's URL is set at build time (VITE_ROWKERY_REPORT_URL, from
// the environment or .env files, as Vite reads it), so its origin can only
// join the policy's connect-src here: `tauri build` and `tauri dev` get the
// policy from csp.mjs through `--config`, after any --config of the caller's.
// Every other command runs as the plain CLI.
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadEnv } from "vite";
import { appCsp, devCsp } from "./csp.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const cli = require.resolve("@tauri-apps/cli/tauri.js");

const args = process.argv.slice(2);
const command = args[0];
if (command === "build" || command === "dev") {
  const env = loadEnv(command === "build" ? "production" : "development", here, "VITE_");
  const report = env.VITE_ROWKERY_REPORT_URL ?? "";
  const security = { csp: appCsp(report), devCsp: devCsp(report, process.env.TAURI_DEV_HOST || null) };
  // Before `--` (cargo's arguments), or at the end.
  const at = args.includes("--") ? args.indexOf("--") : args.length;
  args.splice(at, 0, "--config", JSON.stringify({ app: { security } }));
}

const run = spawnSync(process.execPath, [cli, ...args], { stdio: "inherit" });
process.exit(run.status ?? 1);
