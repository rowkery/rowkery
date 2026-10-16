import { useState } from "react";
import { PenguinMark } from "./PenguinMark";
import { ReportSheet } from "./ReportSheet";

/**
 * What the root error boundary shows instead of a blank window: the tilted
 * penguin, the error, and Reload · Copy · Report. Saved windows and SQL are
 * persisted as they change, so Reload loses nothing typed before the crash.
 */
export function FatalError({ error }: { error: Error }) {
  const [report, setReport] = useState(false);
  const [copied, setCopied] = useState(false);
  const text = error.stack || error.message || String(error);

  const copy = () => {
    void navigator.clipboard
      .writeText(text)
      .then(() => setCopied(true))
      .catch(() => {});
  };

  return (
    <div className="shell-fatal-error" data-fatal-error>
      <PenguinMark pose="tilted" size={40} />
      <h1>Rowkery hit an error it couldn't recover from</h1>
      <p>Reload brings your windows and queries back as they were.</p>
      <pre>{error.message || String(error)}</pre>
      <div className="fatal-actions">
        <button type="button" data-fatal-action="reload" onClick={() => location.reload()}>
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
