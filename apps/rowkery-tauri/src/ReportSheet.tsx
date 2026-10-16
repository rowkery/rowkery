import { useEffect, useMemo, useState, type KeyboardEvent } from "react";
import { BugIcon, FeedbackIcon, LockIcon, SparkleIcon } from "./icons";
import { showToast } from "./notify";
import { isMacPlatform } from "./platform";
import {
  REPORT_KINDS,
  REPORT_URL,
  describeApp,
  describeDatabase,
  loadAppInfo,
  maskSensitive,
  reportText,
  sendReport,
  type AppInfo,
  type ReportContext,
  type ReportKind,
  type ReportPayload,
} from "./report";
import "./ReportSheet.css";
import { Keys } from "./Keys";

const KIND_ICONS = { bug: BugIcon, feature: SparkleIcon, feedback: FeedbackIcon } as const;

interface ReportSheetProps {
  context: ReportContext;
  onClose: () => void;
}

const MAX_QUERY = 8000;

/**
 * Help > Report an Issue…: a note from the user plus a list of exactly what
 * gets sent. App and database versions always go; the error and the query
 * only when their toggle is on. Sent through the relay (apps/relay).
 */
export function ReportSheet({ context, onClose }: ReportSheetProps) {
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [kind, setKind] = useState<ReportKind>("bug");
  const [description, setDescription] = useState("");
  const [withError, setWithError] = useState(context.fromError);
  const [withQuery, setWithQuery] = useState(false);
  const [state, setState] = useState<"idle" | "sending" | "failed">("idle");
  const [failure, setFailure] = useState<string | null>(null);
  const mod = isMacPlatform() ? "⌘" : "Ctrl+";

  useEffect(() => {
    void loadAppInfo().then(setInfo);
  }, []);

  const app = info ? describeApp(info) : "Rowkery";
  const database = describeDatabase(context.connection, context.serverVersion);
  const error = useMemo(
    () => (context.error ? maskSensitive(context.error, context.connection) : null),
    [context.error, context.connection],
  );
  const query = context.query.trim().slice(0, MAX_QUERY);

  const payload = (): ReportPayload => ({
    kind,
    description: description.trim(),
    app,
    database: database ?? undefined,
    error: withError && error ? error : undefined,
    query: withQuery && query ? query : undefined,
  });

  const ready = description.trim().length > 0 && state !== "sending";

  const copy = async () => {
    await navigator.clipboard.writeText(reportText(payload()));
    showToast("Copied report");
  };

  const send = async () => {
    if (!ready) return;
    if (!REPORT_URL) return void copy();
    setState("sending");
    setFailure(null);
    try {
      await sendReport(payload());
      showToast("Report sent", "thank you");
      onClose();
    } catch (e) {
      setFailure(e instanceof Error ? e.message : String(e));
      setState("failed");
    }
  };

  const onKeyDown = (e: KeyboardEvent) => {
    const modKey = isMacPlatform() ? e.metaKey : e.ctrlKey;
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      onClose();
    } else if (e.key === "Enter" && modKey) {
      e.preventDefault();
      void send();
    }
  };

  const row = (
    label: string,
    value: string,
    toggle?: { on: boolean; set: (on: boolean) => void },
  ) => (
    <div data-testid="rp-row" className={`rp-row${toggle && !toggle.on ? " off" : ""}`} data-part={label.toLowerCase()}>
      <span data-testid="rp-k" className="rp-k">{label}</span>
      <span data-testid="rp-v" className="rp-v" title={value}>
        {highlightMasks(value)}
      </span>
      {toggle ? (
        <button
          type="button"
          role="switch"
          aria-checked={toggle.on}
          aria-label={`Include ${label.toLowerCase()}`}
          data-testid="rp-switch"
          className="rp-switch"
          onClick={() => toggle.set(!toggle.on)}
        />
      ) : (
        <span className="rp-lock" title="Always sent">
          <LockIcon size={11} />
        </span>
      )}
    </div>
  );

  const primaryLabel = !REPORT_URL
    ? "Copy report"
    : state === "sending"
      ? "Sending…"
      : state === "failed"
        ? "Try again"
        : "Send report";

  return (
    <div
      className="rp-overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        data-testid="rp-sheet"
        className="rp-sheet"
        data-relay={REPORT_URL ? "on" : "off"}
        role="dialog"
        aria-modal="true"
        aria-label="Report an issue"
        onKeyDown={onKeyDown}
      >
        <div className="rp-head sheet-head">
          <h2 className="sheet-title">Report an issue</h2>
          {/* Reports are filed in a private repo, not public GitHub Issues (2026-10-16). */}
          {REPORT_URL && (
            <span data-testid="rp-sub" className="rp-sub">
              Sent privately to the Rowkery team
            </span>
          )}
          <button type="button" className="sheet-esc" title="Close  esc" onClick={onClose}>
            esc
          </button>
        </div>
        <div className="rp-body">
          <div className="rp-kinds" role="radiogroup" aria-label="Type of report">
            {REPORT_KINDS.map((k) => {
              const Icon = KIND_ICONS[k.id];
              return (
              <button
                key={k.id}
                type="button"
                role="radio"
                aria-checked={kind === k.id}
                data-testid="rp-kind"
                data-kind={k.id}
                className="rp-kind"
                onClick={() => setKind(k.id)}
              >
                <Icon size={13} />
                {k.label}
              </button>
              );
            })}
          </div>
          <textarea
            data-testid="rp-text"
            className="rp-text"
            autoFocus
            spellCheck
            placeholder="What happened? What did you expect instead?"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
          <div className="rp-label sheet-label">Sent with the report</div>
          <div className="rp-incl">
            {row("App", app)}
            {database && row("Database", database)}
            {error && row("Error", error, { on: withError, set: setWithError })}
            {query &&
              row("Query", query.replace(/\s+/g, " "), { on: withQuery, set: setWithQuery })}
          </div>
          {state === "failed" && failure && (
            <div data-testid="rp-failure" className="rp-failure" role="alert">
              Not sent: {failure}
            </div>
          )}
        </div>
        <div className="rp-foot">
          <span className="rp-note">
            {state === "failed"
              ? ""
              : REPORT_URL
                ? "Only what's listed here is sent."
                : "Sending isn't set up in this build."}
          </span>
          {REPORT_URL && state === "failed" && (
            <button type="button" data-testid="rp-copy" className="rp-btn sheet-btn" onClick={() => void copy()}>
              Copy report
            </button>
          )}
          {!(REPORT_URL && state === "failed") && (
            <button type="button" data-testid="rp-cancel" className="rp-btn sheet-btn" onClick={onClose}>
              Cancel
            </button>
          )}
          <button
            type="button"
            data-testid="rp-send"
            className="rp-btn sheet-btn ink"
            disabled={!ready}
            onClick={() => void send()}
          >
            {primaryLabel}
            <kbd><Keys text={`${mod}↵`} /></kbd>
          </button>
        </div>
      </div>
    </div>
  );
}

/** Shows masked parts (‹host›) as small chips so the user sees what was hidden. */
function highlightMasks(value: string) {
  const parts = value.split(/(‹[a-z]+›)/g);
  return parts.map((p, i) =>
    /^‹[a-z]+›$/.test(p) ? (
      <span key={i} className="rp-mask">
        {p.slice(1, -1)}
      </span>
    ) : (
      p
    ),
  );
}
