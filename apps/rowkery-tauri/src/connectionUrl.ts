import type { PgForm } from "./NewConnectionSheet";

/**
 * A pasted connection string → form fields, or null when the text isn't one.
 * Reads `postgres://` / `postgresql://` URLs, libpq keyword strings
 * (`host=… dbname=… user=…`), `psql -h … -U … -d …` lines, and any of these
 * behind a `DATABASE_URL=` (or `export …=`) prefix.
 */
export function parsePostgresUrl(text: string): Partial<PgForm> | null {
  let trimmed = text.trim();
  // DATABASE_URL=postgres://…, export PGURL="…"
  const assign = /^(?:export\s+)?[A-Z_][A-Z0-9_]*=(.*)$/s.exec(trimmed);
  if (assign) trimmed = unquote(assign[1].trim());
  if (/^postgres(ql)?:\/\//i.test(trimmed)) return parseUrl(trimmed);
  if (/^psql(\s|$)/.test(trimmed)) return parsePsql(trimmed);
  return parseKeywords(trimmed);
}

function unquote(s: string): string {
  return /^(["']).*\1$/s.test(s) ? s.slice(1, -1) : s;
}

function sslFrom(mode: string | null | undefined): PgForm["ssl"] | undefined {
  if (!mode) return undefined;
  if (mode === "disable") return "disable";
  if (mode === "require") return "require";
  if (mode === "verify-ca" || mode === "verify-full") return "verify";
  return "prefer";
}

function parseUrl(trimmed: string): Partial<PgForm> | null {
  let url: URL;
  try {
    // Non-special schemes parse inconsistently across engines; borrow http's rules.
    url = new URL(trimmed.replace(/^postgres(ql)?:/i, "http:"));
  } catch {
    return null;
  }
  const out: Partial<PgForm> = {};
  if (url.hostname) out.host = decodeURIComponent(url.hostname);
  out.port = url.port || "5432";
  const db = decodeURIComponent(url.pathname.replace(/^\//, ""));
  if (db) out.database = db;
  if (url.username) out.username = decodeURIComponent(url.username);
  if (url.password) out.password = decodeURIComponent(url.password);
  const ssl = sslFrom(url.searchParams.get("sslmode"));
  if (ssl) out.ssl = ssl;
  const rootCert = url.searchParams.get("sslrootcert");
  if (rootCert) out.sslRootCert = rootCert;
  return out;
}

/** Splits on spaces outside single or double quotes; quotes are dropped. */
function words(s: string): string[] {
  const out: string[] = [];
  const re = /(?:[^\s"']+|"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')+/g;
  for (const m of s.matchAll(re)) {
    out.push(m[0].replace(/"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'/g, (_, a, b) => (a ?? b).replace(/\\(.)/g, "$1")));
  }
  return out;
}

const KEYWORDS: Record<string, keyof PgForm> = {
  host: "host",
  hostaddr: "host",
  port: "port",
  dbname: "database",
  user: "username",
  password: "password",
  sslrootcert: "sslRootCert",
};

/** `host=db port=5432 dbname=app user=alice sslmode=require` (libpq). */
function parseKeywords(s: string): Partial<PgForm> | null {
  const pairs = words(s).map((w) => /^([a-z_]+)=(.*)$/s.exec(w));
  if (pairs.length === 0 || pairs.some((p) => !p)) return null;
  const out: Partial<PgForm> = {};
  let known = 0;
  for (const p of pairs) {
    const [, key, value] = p!;
    if (key === "sslmode") {
      const ssl = sslFrom(value);
      if (ssl) out.ssl = ssl;
      known++;
    } else if (KEYWORDS[key]) {
      (out as Record<string, string>)[KEYWORDS[key]] = value;
      known++;
    }
  }
  // One stray `a=b` isn't a connection string; host or dbname makes it one.
  if (known === 0 || !(out.host || out.database)) return null;
  return out;
}

/** `psql -h db -p 5433 -U alice -d app`, long flags too; a trailing word is the database. */
function parsePsql(s: string): Partial<PgForm> | null {
  const args = words(s).slice(1);
  const out: Partial<PgForm> = {};
  const flags: Record<string, keyof PgForm> = {
    "-h": "host",
    "--host": "host",
    "-p": "port",
    "--port": "port",
    "-U": "username",
    "--username": "username",
    "-d": "database",
    "--dbname": "database",
  };
  const loose: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    const long = /^(--[a-z]+)=(.*)$/.exec(a);
    if (long && flags[long[1]]) {
      (out as Record<string, string>)[flags[long[1]]] = long[2];
    } else if (flags[a] && i + 1 < args.length) {
      (out as Record<string, string>)[flags[a]] = args[++i];
    } else if (/^-[hpUd]./.test(a)) {
      (out as Record<string, string>)[flags[a.slice(0, 2)]] = a.slice(2);
    } else if (!a.startsWith("-")) {
      loose.push(a);
    }
  }
  // psql [dbname [username]], or a URL / keyword string as the dbname.
  if (loose[0]) {
    const inner = parsePostgresUrl(loose[0]);
    if (inner) Object.assign(out, inner);
    else if (!out.database) out.database = loose[0];
  }
  if (loose[1] && !out.username) out.username = loose[1];
  return Object.keys(out).length > 0 ? out : null;
}
