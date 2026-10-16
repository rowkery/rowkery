// The Content-Security-Policy (`csp.mjs`): tauri.conf.json carries it, and
// a build's report relay is the only other place the webview may reach.
import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
// @ts-expect-error plain ES module shared with tauri.mjs and the proof, no types
import { appCsp, devCsp, reportOrigin } from "../csp.mjs";

const conf = JSON.parse(readFileSync(new URL("../src-tauri/tauri.conf.json", import.meta.url), "utf8"));
const directives = (csp: string) =>
  Object.fromEntries(
    csp.split(";").map((d) => {
      const [name, ...sources] = d.trim().split(/\s+/);
      return [name, sources];
    }),
  ) as Record<string, string[]>;

describe("content security policy", () => {
  test("tauri.conf.json carries the policy for a build without a report URL", () => {
    expect(conf.app.security.csp).toBe(appCsp(""));
    expect(conf.app.security.devCsp).toBe(devCsp(""));
  });

  test("the built app runs only its own scripts and reaches only IPC", () => {
    const d = directives(appCsp(""));
    expect(d["default-src"]).toEqual(["'self'"]);
    expect(d["script-src"]).toEqual(["'self'"]);
    expect(d["style-src"]).toEqual(["'self'"]);
    expect(d["connect-src"]).toEqual(["ipc:", "http://ipc.localhost"]);
    expect(d["object-src"]).toEqual(["'none'"]);
    expect(d["frame-ancestors"]).toEqual(["'none'"]);
  });

  test("a report URL adds its origin, and nothing else, to connect-src", () => {
    const d = directives(appCsp("https://rowkery-report-relay.example.workers.dev/report?x=1"));
    expect(d["connect-src"]).toEqual(["ipc:", "http://ipc.localhost", "https://rowkery-report-relay.example.workers.dev"]);
    expect(directives(devCsp("https://relay.example.dev/report"))["connect-src"]).toContain("https://relay.example.dev");
    expect(reportOrigin("not a url")).toBeNull();
    expect(reportOrigin("javascript:alert(1)")).toBeNull();
    expect(reportOrigin("")).toBeNull();
    expect(appCsp("not a url")).toBe(appCsp(""));
  });

  test("tauri dev allows Vite's inline preamble, style tags and HMR socket", () => {
    const d = directives(devCsp(""));
    expect(d["script-src"]).toContain("'unsafe-inline'");
    expect(d["style-src"]).toContain("'unsafe-inline'");
    expect(d["connect-src"]).toContain("ws://localhost:1420");
    expect(directives(devCsp("", "192.168.1.5"))["connect-src"]).toContain("ws://192.168.1.5:1421");
  });
});
