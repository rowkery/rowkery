import { showToast } from "./notify";
import { rawErrorLines } from "./queryError";

interface Props {
  message: string;
  sqlstate: string | null;
  /** The statement that ran, and the server's 1-based position in it. */
  sql: string | null;
  position: number | null;
  /** The server's DETAIL and HINT lines, under the raw text as psql prints them. */
  detail?: string | null;
  /** "Did you mean name?" (an unknown column or table). */
  suggestion: string | null;
  onReplace: () => void;
  onReport: () => void;
}

/**
 * In place of the grid after a failed run: the server's sentence, the name
 * it probably meant with Replace and run, and the raw text as psql prints it
 * (with the SQLSTATE), then Copy error and Report….
 */
export function QueryErrorView({ message, sqlstate, sql, position, detail, suggestion, onReplace, onReport }: Props) {
  const raw = [...rawErrorLines(message, sql, position), ...(detail ? detail.split("\n") : [])];
  const copy = async () => {
    try {
      await navigator.clipboard.writeText([...raw, ...(sqlstate ? [`SQLSTATE ${sqlstate}`] : [])].join("\n"));
      showToast("Copied", "error");
    } catch {
      showToast("Couldn't copy", undefined, "error");
    }
  };
  return (
    <div className="query-error" data-query-error={sqlstate ?? ""}>
      <p data-testid="qe-sentence" className="qe-sentence">{message}</p>
      {suggestion && (
        <p className="qe-suggest" data-suggestion={suggestion}>
          <span>
            Did you mean <b>{suggestion}</b>?
          </span>
          <button type="button" data-testid="qe-replace" className="qe-replace" onClick={onReplace}>
            Replace and run <kbd>↵</kbd>
          </button>
        </p>
      )}
      <pre data-testid="qe-raw" className="qe-raw">
        {raw.map((line, i) => (
          <span key={i} className="qe-raw-line">
            {line}
            {i === 0 && sqlstate && <span className="qe-state">{sqlstate}</span>}
            {"\n"}
          </span>
        ))}
      </pre>
      <div className="qe-actions">
        <button type="button" className="qe-link" onClick={() => void copy()}>
          Copy error
        </button>
        <button type="button" className="qe-link" onClick={onReport} title="Send the error with your note">
          Report…
        </button>
      </div>
    </div>
  );
}
