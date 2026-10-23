// Rowkery report relay: a Cloudflare Worker that turns a report from the
// app's Report an Issue sheet into an issue in the private reports repo. The
// GitHub token lives here as a secret, never in the app. Nothing is stored.

export interface Env {
  /** Fine-grained token with Issues: read and write on `GITHUB_REPO` only. */
  GITHUB_TOKEN: string;
  /** "owner/name" that reports are filed in (private), set in wrangler.toml. */
  GITHUB_REPO: string;
  /** Cloudflare rate limiting binding, keyed by client IP (503 when absent). */
  REPORT_LIMITER?: { limit(options: { key: string }): Promise<{ success: boolean }> };
}

/** What the app sends. Every field is text the user saw in the sheet. */
export interface Report {
  /** Picked in the sheet; becomes a GitHub label beside user-report. */
  kind: Kind;
  description: string;
  /** "Rowkery 0.1.0 · macOS 26.0 · aarch64" */
  app: string;
  /** "PostgreSQL 16.4", absent without a connection. */
  database?: string;
  /** Only when the user left the Error toggle on; hosts already masked. */
  error?: string;
  /** Only when the user turned the Query toggle on. */
  query?: string;
}

export type Kind = "bug" | "feature" | "feedback";
const KINDS: Record<Kind, { label: string; name: string }> = {
  bug: { label: "bug", name: "Bug" },
  feature: { label: "enhancement", name: "Feature" },
  feedback: { label: "feedback", name: "Feedback" },
};

export const MAX_BODY_BYTES = 20_000;
const LABEL = "user-report";

/** Webview and Vite dev origins that may POST reports from the browser. */
export const ALLOWED_ORIGINS = new Set([
  "tauri://localhost",
  "http://tauri.localhost",
  "https://tauri.localhost",
  "http://localhost:1420",
]);

const CORS_BASE = {
  "access-control-allow-methods": "POST, OPTIONS",
  "access-control-allow-headers": "content-type",
  "access-control-max-age": "86400",
  vary: "Origin",
};

function corsHeaders(origin: string | null): Record<string, string> {
  if (origin && ALLOWED_ORIGINS.has(origin)) {
    return { ...CORS_BASE, "access-control-allow-origin": origin };
  }
  return { ...CORS_BASE };
}

function json(status: number, body: unknown, request: Request): Response {
  const origin = request.headers.get("Origin");
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...corsHeaders(origin) },
  });
}

const text = (v: unknown, max: number): string | undefined =>
  typeof v === "string" && v.trim() ? v.trim().slice(0, max) : undefined;

/** The report, or why it can't be one. */
export function parseReport(raw: unknown): Report | string {
  if (!raw || typeof raw !== "object") return "Expected a JSON object";
  const r = raw as Record<string, unknown>;
  const description = text(r.description, 8000);
  const app = text(r.app, 200);
  if (!description) return "Describe the issue";
  if (!app) return "Missing app details";
  // Older app builds send no type.
  const kind: Kind = typeof r.kind === "string" && r.kind in KINDS ? (r.kind as Kind) : "bug";
  return {
    kind,
    description,
    app,
    database: text(r.database, 200),
    error: text(r.error, 4000),
    query: text(r.query, 8000),
  };
}

/** A fence longer than any run of backticks inside, so text can't close it. */
function fenced(body: string, lang = ""): string {
  const longest = Math.max(2, ...[...body.matchAll(/`+/g)].map((m) => m[0].length));
  const fence = "`".repeat(longest + 1);
  return `${fence}${lang}\n${body}\n${fence}`;
}

/** Stops @mentions and #refs in user text from pinging people or linking issues. */
const quiet = (s: string) => s.replace(/@(?=\w)/g, "@​").replace(/#(?=\d)/g, "#​");

export function issueFor(report: Report): { title: string; body: string } {
  const first = report.description.split("\n")[0].trim();
  const title = first.length > 80 ? `${first.slice(0, 79)}…` : first;
  const rows = [
    ["Type", KINDS[report.kind].name],
    ["App", report.app],
    ["Database", report.database],
  ].filter((r): r is [string, string] => !!r[1]);
  const parts = [
    quiet(report.description),
    ["| | |", "|---|---|", ...rows.map(([k, v]) => `| ${k} | ${quiet(v).replace(/\|/g, "\\|")} |`)].join("\n"),
  ];
  if (report.error) parts.push(`**Error**\n\n${fenced(report.error, "text")}`);
  if (report.query) parts.push(`**Query**\n\n${fenced(report.query, "sql")}`);
  parts.push("_Sent from Rowkery's Report an Issue sheet._");
  return { title: `Report: ${title}`, body: parts.join("\n\n") };
}

async function createIssue(env: Env, issue: { title: string; body: string; labels: string[] }): Promise<Response> {
  const { labels: wanted, ...fields } = issue;
  const send = (labels: string[]) =>
    fetch(`https://api.github.com/repos/${env.GITHUB_REPO}/issues`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${env.GITHUB_TOKEN}`,
        accept: "application/vnd.github+json",
        "content-type": "application/json",
        "user-agent": "rowkery-report-relay",
        "x-github-api-version": "2022-11-28",
      },
      body: JSON.stringify({ ...fields, labels }),
    });
  const res = await send([LABEL, ...wanted]);
  // A token that can't apply a label (or a missing label) still files the issue.
  if (res.status !== 422) return res;
  const plain = await send([LABEL]);
  return plain.status === 422 ? send([]) : plain;
}

function isJsonContentType(request: Request): boolean {
  const ct = request.headers.get("content-type");
  if (!ct) return false;
  const media = ct.split(";")[0].trim().toLowerCase();
  return media === "application/json";
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const origin = request.headers.get("Origin");

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }

    const url = new URL(request.url);
    // The root also takes reports, so a build whose report URL left off /report still works.
    if (url.pathname !== "/report" && url.pathname !== "/") return json(404, { ok: false, error: "Not found" }, request);
    if (request.method !== "POST") return json(405, { ok: false, error: "Use POST" }, request);

    if (origin && !ALLOWED_ORIGINS.has(origin)) {
      return json(403, { ok: false, error: "Forbidden" }, request);
    }

    if (!isJsonContentType(request)) {
      return json(415, { ok: false, error: "Content-Type must be application/json" }, request);
    }

    if (!env.REPORT_LIMITER) {
      return json(503, { ok: false, error: "Reporting is temporarily unavailable" }, request);
    }

    const rateKey = request.headers.get("cf-connecting-ip") ?? "no-client-ip";
    if (!(await env.REPORT_LIMITER.limit({ key: rateKey })).success) {
      return json(429, { ok: false, error: "Too many reports, try again in a minute" }, request);
    }

    const raw = await request.text();
    if (new TextEncoder().encode(raw).length > MAX_BODY_BYTES) {
      return json(413, { ok: false, error: "The report is too long" }, request);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return json(400, { ok: false, error: "Expected JSON" }, request);
    }
    const report = parseReport(parsed);
    if (typeof report === "string") return json(400, { ok: false, error: report }, request);

    try {
      const res = await createIssue(env, { ...issueFor(report), labels: [KINDS[report.kind].label] });
      if (!res.ok) {
        console.error("GitHub refused the issue", res.status, await res.text());
        return json(502, { ok: false, error: "Couldn't file the report" }, request);
      }
      const { number } = (await res.json()) as { number: number };
      return json(200, { ok: true, number }, request);
    } catch {
      return json(502, { ok: false, error: "Couldn't file the report" }, request);
    }
  },
};
