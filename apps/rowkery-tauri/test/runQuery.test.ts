// api.runQuery: frames on the run's channel → one result; progress per frame.
import { beforeEach, describe, expect, test, vi } from "vitest";

type Handler = (frame: unknown) => void;
const plays: { frames: unknown[]; reject?: string }[] = [];

vi.mock("@tauri-apps/api/core", () => {
  class Channel {
    onmessage: Handler = () => {};
  }
  return {
    Channel,
    invoke: vi.fn(async (_cmd: string, args: { onFrame: { onmessage: Handler } }) => {
      const play = plays.shift()!;
      if (play.reject) throw new Error(play.reject);
      // Frames land after the invoke resolves, in order.
      setTimeout(() => play.frames.forEach((f) => args.onFrame.onmessage(f)), 0);
      return 1;
    }),
  };
});

const { runQuery } = await import("../src/api");

const columns = [{ t: "columns", query_id: 1, columns: [{ name: "id", type_name: "int4" }] }];
const done = (extra = {}) => ({
  t: "done",
  query_id: 1,
  status: "ok",
  row_count: 3,
  affected_rows: null,
  elapsed_ms: 9,
  first_row_ms: 2,
  frames: 2,
  error: null,
  sqlstate: null,
  error_position: null,
  hold: null,
  ...extra,
});

beforeEach(() => {
  plays.length = 0;
  let id = 0;
  const timers = new Map<number, ReturnType<typeof setTimeout>>();
  vi.stubGlobal("requestAnimationFrame", (fn: () => void) => {
    const n = ++id;
    timers.set(n, setTimeout(fn, 16));
    return n;
  });
  vi.stubGlobal("cancelAnimationFrame", (n: number) => clearTimeout(timers.get(n)));
});

describe("runQuery", () => {
  test("assembles columns and rows; NULL becomes { Null: null }", async () => {
    plays.push({
      frames: [
        ...columns,
        { t: "rows", query_id: 1, seq: 0, rows: [[{ Int: 1 }], [null]] },
        { t: "rows", query_id: 1, seq: 1, rows: [[{ BigInt: "9223372036854775807" }]] },
        done(),
      ],
    });
    const res = await runQuery("w1", 1, "select");
    expect(res.columns.map((c) => c.name)).toEqual(["id"]);
    expect(res.rows.row(0, 1)).toEqual([{ Int: 1 }]);
    expect(res.rows.isNull(1, 0)).toBe(true);
    expect(res.rows.get(2, 0)).toEqual({ BigInt: "9223372036854775807" });
    expect(res).toMatchObject({ row_count: 3, elapsed_ms: 9, first_row_ms: 2, frames: 2, error: null, cancelled: false });
  });

  test("binary rows frames decode into the result's rows", async () => {
    const { readFileSync } = await import("node:fs");
    const bin = readFileSync(new URL("../../../crates/rowkery-core/tests/frames/golden.bin", import.meta.url));
    const buf = bin.buffer.slice(bin.byteOffset, bin.byteOffset + bin.byteLength);
    plays.push({ frames: [{ t: "columns", query_id: 1, columns: [] }, buf, buf, done({ row_count: 8 })] });
    const res = await runQuery("w1", 1, "select");
    expect(res.rows.length).toBe(8);
    expect(res.rows.text(4, 2)).toBe("9223372036854775807");
  });

  test("a result that lands whole never reports progress", async () => {
    const onProgress = vi.fn();
    plays.push({ frames: [...columns, { t: "rows", query_id: 1, seq: 0, rows: [[{ Int: 1 }]] }, done()] });
    await runQuery("w1", 1, "select", { onProgress });
    await new Promise((r) => setTimeout(r, 40));
    expect(onProgress).not.toHaveBeenCalled();
  });

  test("a slow stream hands over its growing rows once", async () => {
    const seen: number[] = [];
    const frames = [...columns, { t: "rows", query_id: 1, seq: 0, rows: [[{ Int: 1 }], [{ Int: 2 }]] }];
    plays.push({ frames });
    const run = runQuery("w1", 1, "select", { onProgress: (p) => seen.push(p.rows.length) });
    await new Promise((r) => setTimeout(r, 40));
    expect(seen).toEqual([2]);
    // The rest of the stream and its done frame, through the same channel.
    const { invoke } = await import("@tauri-apps/api/core");
    const channel = (vi.mocked(invoke).mock.calls.at(-1)![1] as { onFrame: { onmessage: Handler } }).onFrame;
    channel.onmessage({ t: "rows", query_id: 1, seq: 1, rows: [[{ Int: 3 }]] });
    channel.onmessage(done());
    const res = await run;
    expect(res.rows.length).toBe(3);
    // Called once; the rows it handed over grew in place.
    expect(seen).toEqual([2]);
  });

  test("error, cancel and hold come from the done frame", async () => {
    plays.push({ frames: [{ t: "columns", query_id: 1, columns: [] }, done({ status: "error", row_count: 0, error: "boom", sqlstate: "42P01", error_position: 15 })] });
    expect(await runQuery("w1", 1, "x")).toMatchObject({ error: "boom", sqlstate: "42P01", error_position: 15, cancelled: false });
    plays.push({ frames: [done({ status: "cancelled", error: "Query cancelled" })] });
    expect(await runQuery("w1", 1, "x")).toMatchObject({ cancelled: true });
    const hold = { action: "confirm", statements: [] };
    plays.push({ frames: [done({ status: "held", hold })] });
    expect((await runQuery("w1", 1, "x")).hold).toEqual(hold);
  });

  test("a failed invoke rejects", async () => {
    plays.push({ frames: [], reject: "This window is not connected" });
    await expect(runQuery("w1", 1, "x")).rejects.toThrow("not connected");
  });
});
