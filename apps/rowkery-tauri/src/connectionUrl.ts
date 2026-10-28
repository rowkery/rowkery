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

/**
 * Percent-decodes; where the text isn't all valid (`a%41%zz`), each run of
 * escapes that is decodes and the rest stays as typed (`aA%zz`). This runs
 * during render, so it never throws.
 */
function decode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s.replace(/(?:%[0-9a-fA-F]{2})+/g, (run) => {
      try {
        return decodeURIComponent(run);
      } catch {
        return run;
      }
    });
  }
}

/**
 * `postgres://…` as http's rules read it, or null; `socket` when it names
 * no host (`app@/db?host=/var/run/postgresql`), read as `localhost` until
 * `?host=` names one. As libpq does, the user part is what comes before an
 * `@` ahead of the first `/`, so a password holding `#`, `?` or `@` needn't be
 * encoded (`app:pa#ss@db`); one holding `/` must be (`%2F`).
 */
function readUrl(trimmed: string): { url: URL; socket: boolean } | null {
  // Non-special schemes parse inconsistently across engines; borrow http's rules.
  const rest = trimmed.replace(/^postgres(ql)?:\/\//i, "");
  const slash = rest.indexOf("/");
  const at = rest.lastIndexOf("@", slash < 0 ? rest.length : slash);
  const user = at < 0 ? "" : `${rest.slice(0, at).replace(/[#?@]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)}@`;
  const after = rest.slice(at + 1);
  const socket = /^(?:[/?]|$)/.test(after);
  try {
    return { url: new URL(`http://${user}${socket ? "localhost" : ""}${after}`), socket };
  } catch {
    return null;
  }
}

function parseUrl(trimmed: string): Partial<PgForm> | null {
  const read = readUrl(trimmed);
  if (!read) return null;
  const { url, socket } = read;
  const out: Partial<PgForm> = {};
  const q = (key: string) => url.searchParams.get(key) || undefined;
  const host = q("host") ?? (socket ? undefined : decode(url.hostname));
  if (host) out.host = host;
  out.port = q("port") ?? (url.port || "5432");
  const db = q("dbname") ?? decode(url.pathname.replace(/^\//, ""));
  if (db) out.database = db;
  const username = q("user") ?? (url.username ? decode(url.username) : undefined);
  if (username) out.username = username;
  const password = q("password") ?? (url.password ? decode(url.password) : undefined);
  if (password) out.password = password;
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

/** What a hidden password reads as in the URL field. */
export const HIDDEN_PASSWORD = "•••";

/**
 * `text` with the password it holds shown as {@link HIDDEN_PASSWORD}: the
 * URL's (`user:…@`, `?password=…`) or a keyword string's (`password=…`).
 * Text that holds none comes back as it was.
 */
export function hidePassword(text: string): string {
  if (/^\s*(?:(?:export\s+)?[A-Z_][A-Z0-9_]*=["']?)?postgres(ql)?:\/\//i.test(text)) {
    const start = text.indexOf("//") + 2;
    const slash = text.indexOf("/", start);
    const at = text.lastIndexOf("@", slash < 0 ? text.length : slash);
    const colon = text.indexOf(":", start);
    let out = text;
    if (at > start && colon >= 0 && colon < at) out = `${text.slice(0, colon + 1)}${HIDDEN_PASSWORD}${text.slice(at)}`;
    return out.replace(/([?&]password=)[^&#\s"']*/i, `$1${HIDDEN_PASSWORD}`);
  }
  return text.replace(/(\bpassword=)('(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|\S+)/, `$1${HIDDEN_PASSWORD}`);
}

/**
 * Why a pasted `postgres://` URL can't be read, or null when it can (or
 * isn't one).
 */
export function connectionUrlProblem(text: string): string | null {
  const t = text.trim();
  if (!/^(?:(?:export\s+)?[A-Z_][A-Z0-9_]*=["']?)?postgres(ql)?:\/\//i.test(t) || parsePostgresUrl(t)) return null;
  return "A / in the password needs %2F";
}
