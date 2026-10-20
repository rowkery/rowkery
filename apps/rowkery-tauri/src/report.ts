import { invoke } from "@tauri-apps/api/core";
import type { ConnectionRecord } from "./types";

/** The relay's `/report` endpoint (apps/relay), set at build time; see its README. */
export const REPORT_URL = (import.meta.env.VITE_ROWKERY_REPORT_URL as string | undefined) ?? "";

/** What the window knew when the user asked to report. */
export interface ReportContext {
  connection: ConnectionRecord | null;
  /** "16.4" from the last connect. */
  serverVersion: string | null;
  /** The connection or query error on screen, unmasked. */
  error: string | null;
  /** SQL in the current query tab. */
  query: string;
  /** Opened from an error's Report button, so the error starts included. */
  fromError: boolean;
}

export interface AppInfo {
  version: string;
  os: string;
  os_version: string | null;
  arch: string;
}

const OS_NAMES: Record<string, string> = { macos: "macOS", windows: "Windows", linux: "Linux" };
const ARCH_NAMES: Record<string, string> = { aarch64: "Apple Silicon", x86_64: "Intel" };

export async function loadAppInfo(): Promise<AppInfo> {
  try {
    return await invoke<AppInfo>("app_info");
  } catch {
    return { version: "unknown", os: "unknown", os_version: null, arch: "unknown" };
  }
}

export function describeApp(info: AppInfo): string {
  const os = [OS_NAMES[info.os] ?? info.os, info.os_version].filter(Boolean).join(" ");
  const arch = info.os === "macos" ? (ARCH_NAMES[info.arch] ?? info.arch) : info.arch;
  return `Rowkery ${info.version} · ${os} · ${arch}`;
}

export function describeDatabase(
  connection: ConnectionRecord | null,
  serverVersion: string | null,
): string | null {
  if (!connection) return null;
  const engine = connection.kind === "postgres" ? "PostgreSQL" : "SQLite";
  const via = connection.kind === "postgres" && connection.ssh ? " · over SSH" : "";
  return `${[engine, serverVersion].filter(Boolean).join(" ")}${via}`;
}

export const MASKS = { host: "‹host›", user: "‹user›", database: "‹database›", path: "‹path›", project: "‹project›" };

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Hides where the database lives in error text: the connection's host, SSH
 * host, user, database and file path, a Cloud SQL instance's project and name
 * (and any Google project number), then any IP address or dotted host name
 * left (three or more labels, so `schema.table` stays readable).
 */
export function maskSensitive(text: string, connection: ConnectionRecord | null): string {
  const known: [string | undefined | null, string][] = [];
  if (connection?.kind === "postgres") {
    known.push(
      [connection.host, MASKS.host],
      [connection.ssh?.host, MASKS.host],
      [connection.username, MASKS.user],
      [connection.ssh?.username, MASKS.user],
      [connection.database, MASKS.database],
    );
    const instance = connection.cloud_sql?.instance.trim().split(":") ?? [];
    if (instance.length >= 3) {
      const project = instance.slice(0, -2);
      known.push([project.join(":"), MASKS.project], [project[project.length - 1], MASKS.project], [instance[instance.length - 1], MASKS.host]);
    }
  } else if (connection?.kind === "sqlite") {
    known.push([connection.path, MASKS.path]);
  }
  let out = text;
  // Longest first, so a host that contains the database name masks whole.
  for (const [value, mask] of known
    .filter((k): k is [string, string] => !!k[0] && k[0].length >= 2)
    .sort((a, b) => b[0].length - a[0].length)) {
    out = out.replace(new RegExp(`(?<![\\w.-])${escapeRe(value)}(?![\\w-])`, "g"), mask);
  }
  return out
    .replace(/\b(projects?[ /])\d{6,}\b/g, `$1${MASKS.project}`)
    .replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, MASKS.host)
    .replace(/[0-9a-f:]{4,}/gi, (m) => (isIpv6(m) ? MASKS.host : m))
    .replace(/\b(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.){2,}[a-z][a-z0-9-]*[a-z0-9]\b/gi, MASKS.host)
    .replace(/(?:~\/|\/Users\/|\/home\/|[A-Z]:\\Users\\)[^\s"']*/g, MASKS.path);
}

/** Full (six or more groups) or `::`-compressed with two groups; not 12:30:45 or x::int. */
function isIpv6(s: string): boolean {
  const groups = s.split(":");
  const filled = groups.filter((g) => /^[0-9a-f]{1,4}$/i.test(g));
  if (groups.some((g) => g.length > 4)) return false;
  return s.includes("::") ? filled.length >= 2 : filled.length >= 6 && filled.length === groups.length;
}

export type ReportKind = "bug" | "feature" | "feedback";

export const REPORT_KINDS: { id: ReportKind; label: string }[] = [
  { id: "bug", label: "Bug" },
  { id: "feature", label: "Feature" },
  { id: "feedback", label: "Feedback" },
];

export interface ReportPayload {
  kind: ReportKind;
  description: string;
  app: string;
  database?: string;
  error?: string;
  query?: string;
}

/** The report as plain text, for Copy report. */
export function reportText(p: ReportPayload): string {
  // A report without a kind (the crash screen's) has no Type line: it used to
  // print "Type: undefined".
  const kind = p.kind ? REPORT_KINDS.find((k) => k.id === p.kind)?.label ?? p.kind : null;
  const lines = [p.description, "", ...(kind ? [`Type: ${kind}`] : []), p.app];
  if (p.database) lines.push(p.database);
  if (p.error) lines.push("", "Error:", p.error);
  if (p.query) lines.push("", "Query:", p.query);
  return lines.join("\n");
}


/** Sends to the relay; resolves on success, throws a sentence the sheet shows. */
export async function sendReport(p: ReportPayload, url = REPORT_URL): Promise<void> {
  if (!url) throw new Error("Reporting isn't set up in this build");
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(p),
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new Error("Couldn't reach the Rowkery team");
  }
  const body = (await res.json().catch(() => null)) as { ok?: boolean; error?: string } | null;
  if (!res.ok || !body?.ok) throw new Error(body?.error ?? `Couldn't send (${res.status})`);
}
