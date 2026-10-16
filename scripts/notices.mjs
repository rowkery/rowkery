#!/usr/bin/env node
// Regenerates THIRD_PARTY_NOTICES.md at the repo root: the fonts, Rust
// crates and npm packages that ship inside the Rowkery app, each with its
// licence and copyright lines, then the full text of each licence once.
// The app shows the file under Help > Third-party Notices.
//
//   cargo install cargo-about --locked --features cli   # once
//   (cd apps/rowkery-tauri && npm install)
//   node scripts/notices.mjs
//
// Rust: `cargo about` over the workspace (scripts/notices/about.toml: the
// shipped targets, no dev or build dependencies, offline). npm: the
// production dependencies of apps/rowkery-tauri, read from node_modules.
// The output has no dates, so a rerun with the same lockfiles is a no-op.
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const APP = join(ROOT, "apps/rowkery-tauri");
const OUT = join(ROOT, "THIRD_PARTY_NOTICES.md");

// ---------- Copyright lines ----------

const PLACEHOLDER = /\[yyyy\]|\[year\]|<year>|\{yyyy\}|\{year\}|<copyright|<owner|\[name of|\[fullname\]|<name of/i;
/** "Copyright 2019 The Foo Authors", "(c) 2020 Bar", "© Baz", not the licence's own wording. */
function copyrightLines(text) {
  const out = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim().replace(/\s+/g, " ");
    if (line.length > 240 || PLACEHOLDER.test(line)) continue;
    if (!/^(copyright\b|\(c\)\s|©)/i.test(line)) continue;
    if (/^copyright\s+(notice|license|licen[cs]e|owner|holder|and|statement|law|protection|or|to|is)\b/i.test(line)) continue;
    if (!out.includes(line)) out.push(line);
  }
  return out;
}
/** A licence text without its copyright lines: the shared text, printed once. */
const withoutCopyright = (text) => {
  const drop = new Set(copyrightLines(text));
  return text
    .split(/\r?\n/)
    .filter((l) => !drop.has(l.trim().replace(/\s+/g, " ")))
    .join("\n")
    .replace(/^\s*\n/, "")
    .trimEnd();
};

/** The full texts, one per licence id, in the order they are first used. */
const texts = new Map();
const keepText = (id, text) => {
  if (!texts.has(id) && text && text.trim()) texts.set(id, withoutCopyright(text));
};

// ---------- Fonts ----------

// The copyright lines are the fonts' own OFL.txt (the @fontsource LICENSE
// files shorten them); the OFL text comes from @fontsource's file.
const FONTS = [
  {
    name: "IBM Plex Sans and IBM Plex Mono",
    pkgs: ["@fontsource/ibm-plex-sans", "@fontsource/ibm-plex-mono"],
    copyright: 'Copyright © 2017 IBM Corp. with Reserved Font Name "Plex"',
    url: "https://github.com/IBM/plex",
  },
];
const pkgDir = (name, from = APP) => {
  // Node's lookup: the nearest node_modules up from `from`.
  for (let dir = from; ; dir = dirname(dir)) {
    const p = join(dir, "node_modules", name);
    if (existsSync(join(p, "package.json"))) return p;
    if (dir === ROOT || dirname(dir) === dir) return null;
  }
};
const fontLines = [];
for (const f of FONTS) {
  const versions = f.pkgs.map((p) => {
    const dir = pkgDir(p);
    if (!dir) throw new Error(`${p} is not installed: run npm install in apps/rowkery-tauri`);
    const lic = readFileSync(join(dir, "LICENSE"), "utf8");
    const at = lic.indexOf("SIL OPEN FONT LICENSE");
    // From the licence's own heading line (the shortened copyright stays out).
    keepText("OFL-1.1", at >= 0 ? lic.slice(lic.lastIndexOf("\n", at) + 1) : lic);
    return `${p} ${JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).version}`;
  });
  fontLines.push(`- **${f.name}** (${versions.join(", ")}), OFL-1.1, ${f.url}\n  ${f.copyright}`);
}

// ---------- Rust ----------

let about;
try {
  about = JSON.parse(
    execFileSync(
      "cargo",
      ["about", "generate", "--format", "json", "--workspace", "--locked", "--offline", "-c", "scripts/notices/about.toml"],
      { cwd: ROOT, encoding: "utf8", maxBuffer: 256 << 20, stdio: ["ignore", "pipe", "inherit"] },
    ),
  );
} catch (e) {
  console.error("cargo about failed; install it with `cargo install cargo-about --locked --features cli`");
  throw e;
}
const crates = new Map(); // package id -> { name, version, expr, chosen:Set, copyright:[], dir }
for (const c of about.crates) {
  const p = c.package;
  if (p.manifest_path.startsWith(ROOT + sep)) continue; // our own crates
  crates.set(p.id, { name: p.name, version: p.version, expr: c.license, chosen: new Set(), copyright: [], authors: p.authors, dir: dirname(p.manifest_path) });
}
for (const l of about.licenses) {
  for (const u of l.used_by) {
    const c = crates.get(u.crate.id);
    if (!c) continue;
    c.chosen.add(l.id);
    for (const line of copyrightLines(l.text)) if (!c.copyright.includes(line)) c.copyright.push(line);
  }
}
// Licence ids in use, most used first; one text each.
const rustIds = [...crates.values()].flatMap((c) => [...c.chosen]);
const byUse = (ids) => [...new Set(ids)].sort((a, b) => ids.filter((x) => x === b).length - ids.filter((x) => x === a).length || a.localeCompare(b));
// The text printed for an id is the most common one among the crates' own
// LICENSE files once copyright lines are gone (some crates point their
// licence at a source file); ties go to the shortest.
for (const id of byUse(rustIds)) {
  const seen = new Map();
  for (const l of about.licenses) {
    if (l.id !== id || !l.used_by.some((u) => crates.has(u.crate.id))) continue;
    // No source path: cargo about wrote the SPDX text itself.
    const base = l.source_path?.split(/[\\/]/).pop() ?? "LICENSE";
    const t = withoutCopyright(l.text);
    const n = (seen.get(t) ?? 0) + (/^(licen[cs]e|copying)/i.test(base) ? l.used_by.length : 0);
    seen.set(t, n);
  }
  const best = [...seen].sort((a, b) => b[1] - a[1] || a[0].length - b[0].length)[0];
  keepText(id, best?.[0]);
}
// Apache-2.0 §4(d): a crate's NOTICE file travels with it.
const notices = [];
for (const c of crates.values()) {
  for (const f of readdirSync(c.dir).filter((n) => /^NOTICE(\.(md|txt))?$/i.test(n)).sort()) {
    notices.push({ who: `${c.name} ${c.version}`, text: readFileSync(join(c.dir, f), "utf8").trim() });
  }
}
const rustLines = [...crates.values()]
  .sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version, undefined, { numeric: true }))
  .map((c) => {
    const used = [...c.chosen].sort().join(" AND ");
    const lic = used && used !== c.expr ? `${c.expr} (used: ${used})` : c.expr;
    const who = c.copyright.length ? c.copyright.join("; ") : c.authors?.length ? `Authors: ${c.authors.join(", ")}` : "";
    return `- **${c.name}** ${c.version}, ${lic}${who ? `\n  ${who}` : ""}`;
  });

// ---------- npm ----------

const fontPkgs = new Set(FONTS.flatMap((f) => f.pkgs));
const npm = new Map(); // dir -> { name, version, license, copyright }
const walk = (name, from) => {
  const dir = pkgDir(name, from);
  if (!dir) throw new Error(`${name} is not installed: run npm install in apps/rowkery-tauri`);
  if (npm.has(dir)) return;
  const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
  const license = typeof pkg.license === "string" ? pkg.license : pkg.license?.type ?? "UNKNOWN";
  const files = readdirSync(dir).filter((n) => /^(licen[cs]e|copying)(\.(md|txt))?$/i.test(n)).sort();
  const text = files.map((f) => readFileSync(join(dir, f), "utf8")).join("\n");
  npm.set(dir, { name: pkg.name, version: pkg.version, license, copyright: copyrightLines(text), text });
  for (const dep of Object.keys(pkg.dependencies ?? {})) walk(dep, dir);
};
const appPkg = JSON.parse(readFileSync(join(APP, "package.json"), "utf8"));
for (const dep of Object.keys(appPkg.dependencies)) if (!fontPkgs.has(dep)) walk(dep, APP);
const npmList = [...npm.values()].sort((a, b) => a.name.localeCompare(b.name));
for (const id of byUse(npmList.map((p) => p.license))) keepText(id, npmList.find((p) => p.license === id && p.text)?.text);
const npmLines = npmList.map((p) => `- **${p.name}** ${p.version}, ${p.license}${p.copyright.length ? `\n  ${p.copyright.join("; ")}` : ""}`);

// ---------- Write ----------

const fence = (t) => "```text\n" + t.replace(/```/g, "ʼʼʼ") + "\n```";
const doc = [
  "# Third-party notices",
  "",
  "Rowkery is licensed under Apache-2.0 (see LICENSE). It ships the fonts, Rust crates and npm packages below, each under its own licence. Each entry gives its licence and its copyright lines; the full text of each licence follows once, at the end.",
  "",
  "Generated by `node scripts/notices.mjs`; don't edit by hand.",
  "",
  "## Fonts",
  "",
  ...fontLines,
  "",
  "## Engine logos",
  "",
  "- **Simple Icons** (https://simpleicons.org), CC0-1.0: the database engines' logo marks.",
  "",
  `## Rust crates (${rustLines.length})`,
  "",
  ...rustLines,
  "",
  `## npm packages (${npmLines.length})`,
  "",
  ...npmLines,
  "",
  ...(notices.length
    ? ["## NOTICE files", "", ...notices.flatMap((n) => [`### ${n.who}`, "", fence(n.text), ""])]
    : []),
  "## Licence texts",
  "",
  ...[...texts].flatMap(([id, t]) => [`### ${id}`, "", fence(t), ""]),
].join("\n");
writeFileSync(OUT, doc.trimEnd() + "\n");
console.log(
  `${OUT}: ${fontLines.length} fonts, ${rustLines.length} crates, ${npmLines.length} npm packages, ${texts.size} licence texts, ${(Buffer.byteLength(doc) / 1024).toFixed(0)} KB`,
);
