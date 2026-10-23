// Relay tests against a fake GitHub (global fetch is swapped), so nothing real
// is filed. Run: cd apps/relay && npm test
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import relay, { issueFor, parseReport, type Env } from "../src/index.ts";

type Call = { url: string; body: any };
let calls: Call[] = [];
let replies: Response[] = [];

beforeEach(() => {
  calls = [];
  replies = [];
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    calls.push({ url, body: JSON.parse(String(init.body)) });
    return replies.shift() ?? new Response(JSON.stringify({ number: 7 }), { status: 201 });
  }) as typeof fetch;
});

const okLimiter = { limit: async () => ({ success: true }) };
const env: Env = { GITHUB_TOKEN: "t", GITHUB_REPO: "rowkery/reports", REPORT_LIMITER: okLimiter };
const post = (body: unknown, e: Env = env, extra: Record<string, string> = {}) =>
  relay.fetch(
    new Request("https://relay.example/report", {
      method: "POST",
      headers: {
        "cf-connecting-ip": "1.2.3.4",
        "content-type": "application/json",
        ...extra,
      },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
    e,
  );
const report = {
  description: "Structure shows no indexes\nfor wallet_tx",
  app: "Rowkery 0.1.0 · macOS 26.0 · aarch64",
  database: "PostgreSQL 16.4",
};

test("files an issue with the user-report label and returns its number", async () => {
  const res = await post(report, env, { Origin: "http://localhost:1420" });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, number: 7 });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://api.github.com/repos/rowkery/reports/issues");
  assert.deepEqual(calls[0].body.labels, ["user-report", "bug"]);
  assert.match(calls[0].body.body, /\| Type \| Bug \|/);
  assert.equal(calls[0].body.title, "Report: Structure shows no indexes");
  assert.match(calls[0].body.body, /\| Database \| PostgreSQL 16\.4 \|/);
  assert.equal(res.headers.get("access-control-allow-origin"), "http://localhost:1420");
  assert.equal(res.headers.get("vary"), "Origin");
});

test("retries with fewer labels when GitHub rejects them", async () => {
  replies = [new Response("{}", { status: 422 })];
  const res = await post(report);
  assert.equal(res.status, 200);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1].body.labels, ["user-report"]);
});

test("rejects empty, oversized and malformed reports without calling GitHub", async () => {
  assert.equal((await post({ ...report, description: "  " })).status, 400);
  assert.equal((await post("{not json")).status, 400);
  assert.equal((await post({ ...report, description: "x".repeat(21_000) })).status, 413);
  assert.equal(calls.length, 0);
});

test("only POST /report, and CORS preflight answers for allowed origins", async () => {
  const get = await relay.fetch(new Request("https://relay.example/report"), env);
  assert.equal(get.status, 405);
  const other = await relay.fetch(new Request("https://relay.example/other", { method: "POST" }), env);
  assert.equal(other.status, 404);
  const pre = await relay.fetch(
    new Request("https://relay.example/report", {
      method: "OPTIONS",
      headers: { Origin: "tauri://localhost" },
    }),
    env,
  );
  assert.equal(pre.status, 204);
  assert.equal(pre.headers.get("access-control-allow-origin"), "tauri://localhost");
  assert.equal(pre.headers.get("access-control-allow-methods"), "POST, OPTIONS");
  const foreignPre = await relay.fetch(
    new Request("https://relay.example/report", {
      method: "OPTIONS",
      headers: { Origin: "https://evil.example" },
    }),
    env,
  );
  assert.equal(foreignPre.status, 204);
  assert.equal(foreignPre.headers.get("access-control-allow-origin"), null);
});

test("rejects a browser POST from a foreign Origin without calling GitHub", async () => {
  const res = await post(report, env, { Origin: "https://evil.example" });
  assert.equal(res.status, 403);
  assert.equal(calls.length, 0);
});

test("rejects non-JSON Content-Type without calling GitHub", async () => {
  const res = await relay.fetch(
    new Request("https://relay.example/report", {
      method: "POST",
      headers: { "cf-connecting-ip": "1.2.3.4", "content-type": "text/plain" },
      body: JSON.stringify(report),
    }),
    env,
  );
  assert.equal(res.status, 415);
  assert.equal(calls.length, 0);
});

test("allows POST with no Origin (e.g. curl) without CORS allow-origin", async () => {
  const res = await post(report);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("access-control-allow-origin"), null);
});

test("returns 503 when the rate limiter binding is missing", async () => {
  const { REPORT_LIMITER: _, ...noLimiter } = env;
  const res = await post(report, noLimiter as Env);
  assert.equal(res.status, 503);
  assert.equal(calls.length, 0);
});

test("rate limiter blocks by client IP", async () => {
  const keys: string[] = [];
  const limited: Env = {
    ...env,
    REPORT_LIMITER: { limit: async ({ key }) => (keys.push(key), { success: false }) },
  };
  const res = await post(report, limited);
  assert.equal(res.status, 429);
  assert.deepEqual(keys, ["1.2.3.4"]);
  assert.equal(calls.length, 0);
});

test("rate limiter uses a fixed key when cf-connecting-ip is absent", async () => {
  const keys: string[] = [];
  const limited: Env = {
    ...env,
    REPORT_LIMITER: { limit: async ({ key }) => (keys.push(key), { success: false }) },
  };
  const res = await relay.fetch(
    new Request("https://relay.example/report", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(report),
    }),
    limited,
  );
  assert.equal(res.status, 429);
  assert.deepEqual(keys, ["no-client-ip"]);
});

test("GitHub failure is a 502 without leaking GitHub's reply", async () => {
  replies = [new Response("bad credentials", { status: 401 })];
  const orig = console.error;
  console.error = () => {};
  const res = await post(report);
  console.error = orig;
  assert.equal(res.status, 502);
  assert.doesNotMatch(await res.text(), /credentials/);
});

test("user text can't break out of its code fences or ping people", () => {
  const r = parseReport({ ...report, description: "cc @alice see #12", query: "select '```' ;", error: "boom" });
  assert.ok(typeof r !== "string");
  const { body } = issueFor(r);
  assert.match(body, /@​alice/);
  assert.match(body, /#​12/);
  assert.match(body, /````sql\nselect '```' ;\n````/);
  assert.match(body, /```text\nboom\n```/);
});

test("optional parts stay out when absent", () => {
  const r = parseReport(report);
  assert.ok(typeof r !== "string");
  const { body } = issueFor(r);
  assert.doesNotMatch(body, /Error|Query/);
});

test("maps the picked type to a label", async () => {
  await post({ ...report, kind: "feature" });
  assert.deepEqual(calls[0].body.labels, ["user-report", "enhancement"]);
  await post({ ...report, kind: "feedback" });
  assert.deepEqual(calls[1].body.labels, ["user-report", "feedback"]);
  await post({ ...report, kind: "nonsense" });
  assert.deepEqual(calls[2].body.labels, ["user-report", "bug"]);
});

test("takes reports at the root too, for builds whose URL left off /report", async () => {
  const res = await relay.fetch(
    new Request("https://relay.example/", {
      method: "POST",
      headers: { "cf-connecting-ip": "5.6.7.8", "content-type": "application/json" },
      body: JSON.stringify(report),
    }),
    env,
  );
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, number: 7 });
});
