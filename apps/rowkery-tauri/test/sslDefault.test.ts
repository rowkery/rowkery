// A new connection's SSL default (`connectionEnv.ts`): Verify off this
// machine, Prefer for a local server.
import { describe, expect, test } from "vitest";
import { defaultSslMode, isLocalHost } from "../src/connectionEnv";

describe("default SSL mode for a new connection", () => {
  test("local hosts keep Prefer", () => {
    for (const host of [
      "localhost",
      "LOCALHOST",
      "localhost.",
      "127.0.0.1",
      "127.1.2.3",
      "::1",
      "[::1]",
      "/var/run/postgresql",
      "/tmp",
      "db.localhost",
      "mac-mini.local",
      "host.docker.internal",
      " localhost ",
    ]) {
      expect(isLocalHost(host), host).toBe(true);
      expect(defaultSslMode(host), host).toBe("prefer");
    }
  });

  test("anything else verifies the certificate", () => {
    for (const host of [
      "db.internal",
      "wallet.c9xyz.eu-west-1.rds.amazonaws.com",
      "10.0.3.12",
      "192.168.1.20",
      "128.0.0.1",
      "localhost.example.com",
      "local",
      "2001:db8::1",
    ]) {
      expect(isLocalHost(host), host).toBe(false);
      expect(defaultSslMode(host), host).toBe("verify");
    }
  });

  test("no host yet: Prefer", () => {
    expect(defaultSslMode("")).toBe("prefer");
    expect(defaultSslMode("  ")).toBe("prefer");
  });
});
