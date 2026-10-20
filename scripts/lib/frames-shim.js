// Stubbed-invoke proofs: lets a stub keep answering `run_query` with a whole
// result object ({ columns, rows, row_count, elapsed_ms, error, cancelled,
// hold }) while the app expects frames on the run's channel (src-tauri
// `Frame`). Wraps the stub's invoke as soon as the stub installs it, replays
// the result as columns / rows (200 per frame) / done frames on
// `args.onFrame`, and resolves the invoke with a query id, like the backend.
// `browse_table` and `follow_keys` are answered from the stub's
// `browse_table_sql` and `run_query`.
// It also pins the platform to Linux (see below).
// Load it before the stub: `await page.addInitScript({ path: FRAMES_SHIM })`.
(() => {
  // Proofs are written with Linux keys and labels (Ctrl+K, "Ctrl+C"), as on
  // the Linux runner: pin the platform so they behave the same on a Mac. A
  // proof about macOS keys sets navigator.platform itself, after this.
  const linuxAgent = navigator.userAgent.replace(/\(Macintosh;[^)]*\)/, "(X11; Linux x86_64)");
  for (const [prop, value] of [["platform", "Linux x86_64"], ["userAgent", linuxAgent]]) {
    Object.defineProperty(Navigator.prototype, prop, { get: () => value, configurable: true });
  }
  let internals;
  let nextId = 0;
  const frames = (res, queryId) => {
    if (res.hold) {
      return [{ t: "done", query_id: queryId, status: "held", row_count: 0, affected_rows: null, elapsed_ms: 0, first_row_ms: null, frames: 0, error: null, sqlstate: null, error_position: null, hold: res.hold }];
    }
    const out = [{ t: "columns", query_id: queryId, columns: res.columns ?? [] }];
    const rows = (res.rows ?? []).map((row) => row.map((cell) => (cell === "Null" ? null : cell)));
    let seq = 0;
    for (let i = 0; i < rows.length; i += 200) {
      out.push({ t: "rows", query_id: queryId, seq: seq++, rows: rows.slice(i, i + 200) });
    }
    out.push({
      t: "done",
      query_id: queryId,
      status: res.cancelled ? "cancelled" : res.error ? "error" : "ok",
      row_count: res.row_count ?? rows.length,
      affected_rows: res.affected_rows ?? null,
      elapsed_ms: res.elapsed_ms ?? 0,
      first_row_ms: res.first_row_ms ?? (rows.length ? 1 : null),
      frames: seq,
      error: res.error ?? null,
      sqlstate: res.sqlstate ?? null,
      error_position: res.error_position ?? null,
      hold: null,
      paged: res.paged ?? false,
      more: res.more ?? false,
    });
    return out;
  };
  const literal = (v) =>
    v && "Int" in v ? String(v.Int) : v && "BigInt" in v ? v.BigInt : v && "Text" in v ? `'${v.Text.replace(/'/g, "''")}'` : null;
  const wrap = (invoke) =>
    async function (cmd, args, ...rest) {
      const call = (c, a) => invoke.call(this, c, a, ...rest);
      // browse_table = the stub's browse_table_sql, then run_query.
      if (cmd === "browse_table") {
        const sql = await call("browse_table_sql", args);
        const queryId = await wrapped.call(this, "run_query", { ...args, sql }, ...rest);
        return { query_id: queryId, sql };
      }
      // follow_keys = one stubbed run_query per key, its first row.
      if (cmd === "follow_keys") {
        return Promise.all(
          args.lookups.map(async (l) => {
            const lit = literal(l.value);
            if (lit === null) return null;
            const quoted = `"${l.column.replace(/"/g, '""')}"`;
            const sql = await call("browse_table_sql", {
              engine: "postgres",
              schema: l.schema,
              table: l.table,
              filter: `${quoted} = ${lit}`,
              limit: 1,
            });
            const res = await call("run_query", { windowId: args.windowId, tabId: 0, sql });
            const row = res?.rows?.[0];
            return row ? { columns: res.columns, row: row.map((c) => (c === "Null" ? null : c)) } : null;
          }),
        );
      }
      const channel = cmd === "run_query" ? args?.onFrame : undefined;
      const res = await call(cmd, args);
      if (!channel || !res || typeof res !== "object") return res;
      const queryId = ++nextId;
      // After the invoke resolves, like a real channel (frames may also race it).
      setTimeout(() => {
        for (const frame of frames(res, queryId)) channel.onmessage(frame);
      }, 0);
      return queryId;
    };
  let wrapped;
  Object.defineProperty(window, "__TAURI_INTERNALS__", {
    configurable: true,
    get: () => internals,
    set(value) {
      internals = value;
      if (value && typeof value.invoke === "function" && !value.__framesShim) {
        wrapped = wrap(value.invoke);
        value.invoke = wrapped;
        value.__framesShim = true;
      }
    },
  });
})();
