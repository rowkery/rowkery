import { useEffect, useRef, useState } from "react";
import {
  cancelSqlFile,
  forgetSqlFile,
  runSqlFile,
  scanSqlFile,
  type SqlFileFailure,
  type SqlFileProgress,
  type SqlFileReport,
  type SqlFileScan,
} from "./api";
import { InspectorHead } from "./Inspector";
import { formatBytes } from "./types";
import "./SqlFilePanel.css";

type Phase =
  | { at: "reading"; bytes: number }
  | { at: "unreadable"; message: string }
  | { at: "ready"; scan: SqlFileScan }
  | { at: "running"; scan: SqlFileScan; progress: SqlFileProgress | null; started: number }
  | { at: "ended"; scan: SqlFileScan; report: SqlFileReport };

const count = (n: number) => n.toLocaleString("en-US");
const plural = (n: number, one: string, many = `${one}s`) => `${count(n)} ${n === 1 ? one : many}`;
const clock = (ms: number) => {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
};
const fileName = (path: string) => path.split(/[\\/]/).pop() ?? path;
const at = (f: SqlFileFailure) => (f.line ? `Line ${count(f.line)}: ` : "");

/**
 * Run SQL file, in the inspector column (plan 2026-10-21): core reads the
 * .sql file first and the panel says what it does, kind by kind with the
 * destructive ones in red, before anything runs. Run is the confirmation on
 * a Confirm writes connection, since the panel shows what runs. By default
 * the whole file is one transaction; a file with statements that can't run
 * in one is per statement, and says why. An error or Cancel rolls back.
 */
export function SqlFilePanel({
  windowId,
  path,
  engine,
  connectionName,
  onBusy,
  onRan,
  onChooseFile,
  onClose,
}: {
  windowId: string;
  path: string;
  engine: string;
  connectionName: string;
  /** Running: the panel can't close until the run ends. */
  onBusy: (busy: boolean) => void;
  /** The run ended having changed something: the schema may differ. */
  onRan: () => void;
  onChooseFile: () => void;
  onClose: () => void;
}) {
  const [phase, setPhase] = useState<Phase>({ at: "reading", bytes: 0 });
  const [wholeFile, setWholeFile] = useState(true);
  const [keepGoing, setKeepGoing] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const runRef = useRef<HTMLButtonElement>(null);
  const running = phase.at === "running";

  useEffect(() => {
    let live = true;
    scanSqlFile(windowId, path, engine, (bytes) => live && setPhase({ at: "reading", bytes })).then(
      (scan) => {
        if (!live) return;
        if (scan.per_statement) setWholeFile(false);
        setPhase({ at: "ready", scan });
      },
      (e) => live && setPhase({ at: "unreadable", message: String(e) }),
    );
    return () => {
      live = false;
      void forgetSqlFile(windowId).catch(() => {});
    };
  }, [windowId, path, engine]);

  useEffect(() => {
    if (phase.at === "ready" && !phase.scan.refused) runRef.current?.focus({ preventScroll: true });
  }, [phase]);

  useEffect(() => onBusy(running), [running, onBusy]);
  // Gone mid-run (the window lost its connection): core cancels the run.
  useEffect(() => () => onBusy(false), [onBusy]);

  useEffect(() => {
    if (!running) return;
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, [running]);

  const run = (scan: SqlFileScan) => {
    const started = Date.now();
    setNow(started);
    setPhase({ at: "running", scan, progress: null, started });
    runSqlFile(windowId, { wholeFile, keepGoing }, (progress) =>
      setPhase((cur) => (cur.at === "running" ? { ...cur, progress } : cur)),
    ).then(
      (report) => {
        setPhase({ at: "ended", scan, report });
        if (report.done > 0 && !report.rolled_back) onRan();
      },
      (e) => {
        setPhase({ at: "ended", scan, report: lostRun(String(e), Date.now() - started) });
        // It may have changed the schema before the answer was lost.
        onRan();
      },
    );
  };

  const scan = phase.at === "ready" || phase.at === "running" || phase.at === "ended" ? phase.scan : null;
  const destructive = !!scan?.kinds.some((k) => k.destructive);
  const meta = scan ? [fileName(path), formatBytes(scan.bytes), scan.source].filter(Boolean) : [fileName(path)];

  return (
    <>
      <InspectorHead onClose={onClose}>
        <h2 className="insp-title">Run SQL file</h2>
      </InspectorHead>
      <div className="sf-body" data-sql-file={phase.at}>
        <div className="sf-meta" title={path} data-sql-file-meta>
          {/* Breaks between the parts, never inside "pg_dump 16.4". */}
          {meta.map((m, i) => (
            <span key={i}>
              {i > 0 && " · "}
              <span className="sf-meta-part">{m}</span>
            </span>
          ))}
        </div>
        {phase.at === "reading" && (
          <div className="sf-wait">Reading the file{phase.bytes ? ` · ${formatBytes(phase.bytes)}` : "…"}</div>
        )}
        {phase.at === "unreadable" && (
          <div className="sf-wait error" data-sql-file-error>
            {phase.message}
          </div>
        )}
        {scan?.refused && (
          <div className="sf-wait error" data-sql-file-refused>
            {scan.refused.line ? `Line ${count(scan.refused.line)}: ` : ""}
            {scan.refused.message}
          </div>
        )}
        {scan && !scan.refused && phase.at !== "ended" && (
          <>
            <section className="sf-kinds">
              <div className="insp-label">What it does · {plural(scan.statements, "statement")}</div>
              {scan.kinds.map((k) => (
                <div key={k.label} className={`sf-kind${k.destructive ? " destructive" : ""}`} data-sql-kind={k.label}>
                  <span className="sf-kind-label">
                    {k.label}
                    {k.label === "COPY" && scan.copy_rows > 0 && <span className="sf-kind-sub"> · {plural(scan.copy_rows, "row")}</span>}
                  </span>
                  <span className="sf-kind-count">{count(k.count)}</span>
                </div>
              ))}
            </section>
            {phase.at === "ready" ? (
              <section className="sf-options">
                <div className="sf-option">
                  <span className="sf-option-label">Transaction</span>
                  <Segment
                    label="Transaction"
                    name="transaction"
                    value={wholeFile ? "whole" : "each"}
                    options={[
                      { value: "whole", label: "Whole file", disabled: !!scan.per_statement },
                      { value: "each", label: "Per statement" },
                    ]}
                    onPick={(v) => {
                      setWholeFile(v === "whole");
                      // One error ends a transaction: Keep going needs Per statement.
                      if (v === "whole") setKeepGoing(false);
                    }}
                  />
                </div>
                {scan.per_statement && (
                  <p className="sf-why" data-sql-file-why>
                    Line {count(scan.per_statement.line)}: {scan.per_statement.reason}
                  </p>
                )}
                <div className="sf-option">
                  <span className="sf-option-label">On error</span>
                  <Segment
                    label="On error"
                    name="on-error"
                    value={keepGoing ? "keep" : "stop"}
                    options={[
                      { value: "stop", label: "Stop" },
                      { value: "keep", label: "Keep going" },
                    ]}
                    onPick={(v) => {
                      setKeepGoing(v === "keep");
                      if (v === "keep") setWholeFile(false);
                    }}
                  />
                </div>
              </section>
            ) : (
              phase.at === "running" && <Running scan={scan} progress={phase.progress} elapsed={now - phase.started} />
            )}
          </>
        )}
        {phase.at === "ended" && <Ended report={phase.report} wholeFile={wholeFile} />}
      </div>
      <footer className="insp-foot">
        {phase.at === "running" ? (
          <>
            <span className="insp-gap" />
            <button type="button" className="insp-btn" data-sql-file-cancel onClick={() => void cancelSqlFile(windowId)}>
              {wholeFile ? "Cancel and roll back" : "Cancel"}
            </button>
          </>
        ) : phase.at === "ready" && !phase.scan.refused ? (
          <>
            <button type="button" className="insp-btn ghost" data-sql-file-close onClick={onClose}>
              Cancel
            </button>
            <span className="insp-gap" />
            <button
              ref={runRef}
              type="button"
              className={`insp-btn ${destructive ? "danger" : "ink"} sf-run`}
              data-sql-file-run
              data-destructive={destructive ? "" : undefined}
              title={`Run on ${connectionName}`}
              onClick={() => run(phase.scan)}
            >
              Run on {connectionName}
            </button>
          </>
        ) : (
          <>
            <button type="button" className="insp-btn ghost" data-sql-file-choose onClick={onChooseFile}>
              Choose file…
            </button>
            <span className="insp-gap" />
            <button
              type="button"
              className="insp-btn"
              data-sql-file-close
              onClick={() => {
                if (phase.at === "reading") void cancelSqlFile(windowId);
                onClose();
              }}
            >
              {phase.at === "reading" ? "Cancel" : "Close"}
            </button>
          </>
        )}
      </footer>
    </>
  );
}

function Segment({
  label,
  name,
  value,
  options,
  onPick,
}: {
  label: string;
  name: string;
  value: string;
  options: { value: string; label: string; disabled?: boolean }[];
  onPick: (value: string) => void;
}) {
  return (
    <div className="sf-segment" role="radiogroup" aria-label={label} data-sql-file-option={name}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={value === o.value}
          disabled={o.disabled}
          data-value={o.value}
          onClick={() => onPick(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

function Running({ scan, progress, elapsed }: { scan: SqlFileScan; progress: SqlFileProgress | null; elapsed: number }) {
  const share = progress && scan.bytes ? Math.min(1, progress.bytes / scan.bytes) : 0;
  return (
    <section className="sf-running" data-sql-file-running>
      <div className="sf-running-head">
        <span>
          Statement {count(Math.min(scan.statements, (progress?.done ?? 0) + 1))} of {count(scan.statements)}
        </span>
        <span className="sf-elapsed">{clock(elapsed)}</span>
      </div>
      <div className="sf-bar" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(share * 100)}>
        <span style={{ transform: `scaleX(${share})` }} />
      </div>
      {progress?.current && <pre className="sf-current">{progress.current}</pre>}
      {!!progress?.rows && <div className="sf-rows">{plural(progress.rows, "row")}</div>}
    </section>
  );
}

/**
 * A run whose answer never came (the call itself failed): Rowkery can't say
 * what ran, what was committed or what rolled back.
 */
export function lostRun(message: string, elapsedMs: number): SqlFileReport {
  return {
    done: 0,
    rows: 0,
    elapsed_ms: elapsedMs,
    failed: { line: null, statement: "", message },
    errors: 1,
    first_error: null,
    cancelled: false,
    rolled_back: false,
    lost: 0,
    unknown: true,
  };
}

/** How the panel words a run's end: its title, its kind and what was kept. */
export function endedText(report: SqlFileReport, wholeFile: boolean): { title: string; kind: string; kept: string } {
  if (report.unknown) {
    return { title: "Outcome unknown", kind: "unknown", kept: "Rowkery lost track of this run; check the tables it touches." };
  }
  const stayed = report.done - report.lost;
  const kept = report.rolled_back
    ? "Nothing was kept."
    : !wholeFile && report.done
      ? [
          stayed ? `The ${plural(stayed, "statement")} before it stay.` : "Nothing was kept.",
          report.lost ? `${plural(report.lost, "statement")} in the file's own open transaction rolled back.` : "",
        ]
          .filter(Boolean)
          .join(" ")
      : "";
  const [title, kind] = report.cancelled
    ? ["Cancelled", "cancelled"]
    : report.failed
      ? ["Stopped on an error", "failed"]
      : report.errors
        ? [`Done with ${plural(report.errors, "error")}`, "errors"]
        : ["Done", "done"];
  return { title, kind, kept };
}

function Ended({ report, wholeFile }: { report: SqlFileReport; wholeFile: boolean }) {
  const ran = report.unknown
    ? clock(report.elapsed_ms)
    : `${plural(report.done, "statement")} · ${plural(report.rows, "row")} · ${clock(report.elapsed_ms)}`;
  const { title, kind, kept } = endedText(report, wholeFile);
  const failure = report.failed ?? report.first_error;
  return (
    <section className={`sf-ended ${kind}`} data-sql-file-ended={kind}>
      <div className="sf-ended-title">{title}</div>
      <div className="sf-ended-line">{ran}</div>
      {failure && (
        <>
          <div className="sf-ended-error">
            {at(failure)}
            {failure.message}
          </div>
          {failure.statement && <pre className="sf-current">{failure.statement}</pre>}
        </>
      )}
      {(report.cancelled || report.failed) && kept && (
        <div className="sf-ended-line" data-sql-file-kept>
          {kept}
        </div>
      )}
    </section>
  );
}
