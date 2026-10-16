import { describe, expect, test } from "vitest";
import { CatalogUpdates, type CatalogUpdate } from "../src/catalogUpdates";

const confirmed = (window_id: string, open_seq: number): CatalogUpdate => ({ kind: "confirmed", window_id, open_seq });

describe("CatalogUpdates", () => {
  test("an update for the open the reply named applies once", () => {
    const u = new CatalogUpdates();
    expect(u.expect("w1", 3)).toBeNull();
    expect(u.receive(confirmed("w1", 3))).toEqual(confirmed("w1", 3));
    expect(u.receive(confirmed("w1", 3))).toBeNull();
  });

  test("an update ahead of its reply waits for it", () => {
    const u = new CatalogUpdates();
    expect(u.receive(confirmed("w1", 5))).toBeNull();
    expect(u.expect("w1", 5)).toEqual(confirmed("w1", 5));
  });

  test("an older open's update is dropped; another window's is its own", () => {
    const u = new CatalogUpdates();
    u.expect("w1", 7);
    expect(u.receive(confirmed("w1", 6))).toBeNull();
    expect(u.expect("w1", 7)).toBeNull();
    u.expect("w2", 8);
    expect(u.receive(confirmed("w2", 8))).toEqual(confirmed("w2", 8));
  });

  test("forget drops what was pending", () => {
    const u = new CatalogUpdates();
    u.receive(confirmed("w1", 9));
    u.forget("w1");
    expect(u.expect("w1", 9)).toBeNull();
  });
});
