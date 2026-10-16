import type { ConnectionEnv, SslMode } from "./types";

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "0.0.0.0", "host.docker.internal"]);

/**
 * This machine or the local network's own names: localhost (and
 * `*.localhost`), 127.x, ::1, a Unix socket directory, an mDNS `.local` name.
 */
export function isLocalHost(host: string): boolean {
  const h = host.trim().toLowerCase().replace(/^\[(.*)\]$/, "$1").replace(/\.$/, "");
  return (
    LOCAL_HOSTS.has(h) ||
    h.startsWith("/") ||
    /^127(\.\d{1,3}){3}$/.test(h) ||
    h.endsWith(".localhost") ||
    h.endsWith(".local")
  );
}

/**
 * SSL for a new connection to `host`: Verify (the certificate and host name
 * are checked) for anything off this machine, Prefer for a local server,
 * which rarely has a certificate. Saved connections keep their own.
 */
export function defaultSslMode(host: string): SslMode {
  return host.trim() && !isLocalHost(host) ? "verify" : "prefer";
}

const WORDS: [ConnectionEnv, RegExp][] = [
  ["prd", /^(prd|prod|production|live)$/],
  ["stg", /^(stg|stage|staging|uat|preprod)$/],
  ["dev", /^(dev|develop|development|test|qa)$/],
  ["local", /^(local|localhost)$/],
];

/**
 * Suggests an environment from the connection name, database and host, e.g.
 * "orders-prod" → prd, localhost → local. Production words win so a prod
 * database on a local tunnel still reads as prd. Null when nothing matches.
 */
export function guessEnvironment(
  parts: string[],
  host?: string,
): ConnectionEnv | null {
  const tokens = parts
    .join(" ")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  for (const [env, re] of WORDS) {
    if (tokens.some((t) => re.test(t))) return env;
  }
  if (host && LOCAL_HOSTS.has(host.trim().toLowerCase())) return "local";
  return null;
}
