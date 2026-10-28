import { useEffect, useState } from "react";
import { closeWindow, openTransactions, type OpenTransaction } from "./api";
import { PenguinMark } from "./PenguinMark";
import { ReportSheet } from "./ReportSheet";

/**
 * What the root error boundary shows instead of a blank window: the tilted
 * penguin, the error, and Reload · Copy · Report. Saved windows and SQL are
 * persisted as they change, so Reload loses nothing typed before the crash.
 * A transaction left open can't come back (the reloaded tabs aren't the
 * sessions core holds), so Reload says so and closes those windows first:
 * otherwise core would refuse to re-point them, and they couldn't connect.
 */
export function FatalError({ error }: { error: Error }) {
  const [report, setReport] = useState(false);
  const [copied, setCopied] = useState(false);
  const [held, setHeld] = useState<OpenTransaction[]>([]);
  useEffect(() => {
    openTransactions().then(setHeld, () => {});
  }, []);
  const text = error.stack || error.message || String(error);

  const copy = () => {
    void navigator.clipboard
      .writeText(text)
      .then(() => setCopied(true))
      .catch(() => {});
  };

  const reload = async () => {
    for (const w of new Set(held.map((t) => t.window_id))) await closeWindow(w).catch(() => {});
    location.reload();
  };

  return (
    <div className="shell-fatal-error" data-fatal-error>
      <PenguinMark pose="tilted" size={40} />
      <h1>Rowkery hit an error it couldn't recover from</h1>
      <p>
        {held.length
          ? `Reload brings your windows and queries back, but rolls back the transaction open in ${held.length === 1 ? "a query tab" : `${held.length} query tabs`}.`
          : "Reload brings your windows and queries back as they were."}
      </p>
      <pre>{error.message || String(error)}</pre>
      <div className="fatal-actions">
        <button type="button" data-fatal-action="reload" onClick={() => void reload()}>
          Reload
        </button>
        <button type="button" data-fatal-action="copy" onClick={copy}>
          {copied ? "Copied" : "Copy"}
        </button>
        <button type="button" data-fatal-action="report" onClick={() => setReport(true)}>
          Report…
        </button>
      </div>
      {report && (
        <ReportSheet
          context={{
            connection: null,
            serverVersion: null,
            error: text,
            query: "",
            fromError: true,
          }}
          onClose={() => setReport(false)}
        />
      )}
    </div>
  );
}
