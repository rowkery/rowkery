import { describe, expect, it } from "vitest";
import { EMPTY_HISTORY, MAX_HISTORY, goHistory, historyLabel, pushHistory, type HistoryEntry } from "../src/history";

const e = (tableKey: string, more: Partial<HistoryEntry> = {}): HistoryEntry => ({
  tableKey,
  name: tableKey.split(".").pop()!,
  view: "data",
  filter: "",
  sort: [],
  ...more,
});

describe("history", () => {
  it("pushes, walks back and forward, and a new step drops the ones ahead", () => {
    let h = pushHistory(EMPTY_HISTORY, e("db.public.a"));
    h = pushHistory(h, e("db.public.b"));
    h = pushHistory(h, e("db.public.c"));
    expect(h.index).toBe(2);
    h = goHistory(h, -1)!;
    h = goHistory(h, -1)!;
    expect(h.entries[h.index].tableKey).toBe("db.public.a");
    expect(goHistory(h, -1)).toBeNull();
    h = goHistory(h, 1)!;
    h = pushHistory(h, e("db.public.d"));
    expect(h.entries.map((x) => x.name)).toEqual(["a", "b", "d"]);
    expect(goHistory(h, 1)).toBeNull();
  });

  it("keeps what you changed on the entry you leave", () => {
    let h = pushHistory(EMPTY_HISTORY, e("db.public.a"));
    const changed = e("db.public.a", { filter: "id > 3", sort: [{ column: "id", desc: true }] });
    h = pushHistory(h, e("db.public.b"), changed);
    h = goHistory(h, -1)!;
    expect(h.entries[h.index]).toEqual(changed);
  });

  it("doesn't repeat the entry it is on, and caps at 50", () => {
    let h = pushHistory(EMPTY_HISTORY, e("db.public.a"));
    h = pushHistory(h, e("db.public.a"));
    expect(h.entries).toHaveLength(1);
    h = pushHistory(h, e("db.public.a", { view: "structure" }));
    expect(h.entries).toHaveLength(2);
    for (let i = 0; i < 60; i++) h = pushHistory(h, e(`db.public.t${i}`));
    expect(h.entries).toHaveLength(MAX_HISTORY);
    expect(h.index).toBe(MAX_HISTORY - 1);
  });

  it("labels entries like the stack list", () => {
    expect(historyLabel(e("db.public.wallet_tx", { filter: "status = 'pending'", sort: [{ column: "amount", desc: true }, { column: "id", desc: false }] }))).toBe(
      "wallet_tx · status = 'pending' · amount ↓, id ↑",
    );
    expect(historyLabel(e("db.public.wallets", { view: "structure" }))).toBe("wallets · Structure");
  });
});
