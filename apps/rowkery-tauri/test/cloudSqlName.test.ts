// The form's connection-name check matches the core's
// (`cloudsql::InstanceName::parse`), so a name the form offers is one the
// connector takes.
import { describe, expect, test } from "vitest";
import { isConnectionName } from "../src/CloudSqlFields";

describe("isConnectionName", () => {
  test("takes project:region:instance and a Workspace project", () => {
    expect(isConnectionName(" acme-prod:asia-southeast1:orders-prd ")).toBe(true);
    expect(isConnectionName("example.com:acme:us-central1:db")).toBe(true);
  });

  test("refuses what the core refuses", () => {
    for (const bad of [
      "",
      "orders-prd",
      "p:r",
      "p::i",
      ":r:i",
      "a:b:c:d:e",
      "p:r:i x",
      "p/x:r:i",
      "p:r:i?x",
      "p:r:i#x",
      "acme:r:..",
      "..:r:i",
      "p:r:-i",
      "p:r:i_x",
      "a..b:p:r:i",
      ".example.com:p:r:i",
    ]) {
      expect(isConnectionName(bad), bad).toBe(false);
    }
  });
});
