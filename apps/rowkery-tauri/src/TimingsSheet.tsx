import { useEffect, useMemo, useState, type KeyboardEvent } from "react";
import { showToast } from "./notify";
import { ledgerLines, queryTimings, rustMarks, type LedgerLine } from "./timings";
import { formatMs, overBudget, timingsReport, timingsText } from "./timingsReport";
import "./TimingsSheet.css";

/**
 * ⌘K Timings: the marks `timings.ts` measured in this run (launch, ⌘K, the
 * window's last query) against their budgets, the same numbers
 * latency-proof.sh asserts. A snapshot taken on open. Copy puts it on the
 * clipboard as plain lines; Esc closes.
 */
export function TimingsSheet({
  windowId,
  where,
  tabTitle,
  onClose,
}: {
  windowId: string;
  /** `connection / database`, for the title row and the copied text. */
  where: string | null;
  tabTitle: (tab: number) => string | undefined;
  onClose: () => void;
}) {
  // Rust's marks (the launch window's socket) come by IPC; the page's are here.
  const [rust, setRust] = useState<LedgerLine[]>([]);
  useEffect(() => {
    void rustMarks().then(setRust);
  }, []);
  const sections = useMemo(
    () => timingsReport([...rust, ...ledgerLines()], queryTimings(windowId), tabTitle),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [windowId, rust],
  );

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(timingsText(sections, where ? `Timings · ${where}` : "Timings"));
      showToast("Copied timings");
    } catch (e) {
      showToast("Couldn't copy", String(e), "error");
    }
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      onClose();
    }
  };

  return (
    <div
      className="tm-overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="tm-sheet" role="dialog" aria-modal="true" aria-label="Timings" data-timings onKeyDown={onKeyDown}>
        <div className="tm-head sheet-head">
          <h2 className="tm-title sheet-title">Timings</h2>
          {where && <span data-testid="tm-where" className="tm-where">{where}</span>}
          <button type="button" className="sheet-esc" title="Close  esc" onClick={onClose}>
            esc
          </button>
        </div>
        {sections.map((s) => (
          <section key={s.title} className="tm-section" data-section={s.title}>
            <div className="tm-section-head sheet-label">
              <span>{s.title}</span>
              <span className="tm-col">measured</span>
              <span className="tm-col">budget</span>
            </div>
            {s.rows.map((r) => {
              const over = overBudget(r);
              return (
                <div
                  key={r.label}
                  className="tm-row"
                  data-timing={r.label}
                  data-ms={r.ms ?? undefined}
                  data-over={over ? "" : undefined}
                >
                  <span className="tm-label">
                    {r.label}
                    {r.note && <span className="tm-note"> · {r.note}</span>}
                  </span>
                  <span className="tm-num">{formatMs(r.ms)}</span>
                  <span className={`tm-num tm-budget${over ? " over" : r.ms != null && r.budget != null ? " ok" : ""}`}>
                    {r.budget == null ? "" : `${r.budget} ${r.ms == null ? "" : over ? "over" : "✓"}`}
                  </span>
                </div>
              );
            })}
          </section>
        ))}
        <div className="tm-foot">
          {/* Both bordered: Copy commits nothing, so nothing here is ink. */}
          <button type="button" className="sheet-btn" title="Close  esc" onClick={onClose}>
            Close
          </button>
          <button type="button" className="sheet-btn" data-timings-copy autoFocus onClick={() => void copy()}>
            Copy
          </button>
        </div>
      </div>
    </div>
  );
}
