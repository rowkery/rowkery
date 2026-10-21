import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { isMacPlatform } from "./platform";
import "./McpConnectSheet.css";

/**
 * ⌘K Connect an agent: adds Rowkery's MCP server to Claude Code or Claude
 * Desktop after showing exactly what will run (Rust: `mcp_connect.rs`).
 * Claude Code gets its own `claude mcp add`; Claude Desktop gets an entry in
 * its config file. Each tab checks first, so a missing client, an existing
 * entry or another copy of Rowkery is said before anything runs.
 */
export type AgentClient = "claude-code" | "claude-desktop";

type CheckState = "missing" | "ready" | "connected" | "other" | "unreadable";

interface ConnectCheck {
  client: AgentClient;
  state: CheckState;
  preview: string;
  copy: string;
  existing: string | null;
  config_file: string | null;
  problem: string | null;
}

interface ConnectRun {
  ok: boolean;
  output: string;
  check: ConnectCheck;
}

type Phase = { kind: "idle" } | { kind: "running" } | { kind: "done"; ok: boolean; output: string };

const CLIENTS: { id: AgentClient; label: string }[] = [
  { id: "claude-code", label: "Claude Code" },
  { id: "claude-desktop", label: "Claude Desktop" },
];

const IDLE: Phase = { kind: "idle" };

export function McpConnectSheet({
  inline = false,
  sharedCount,
  onOpenAccess,
  onClose,
}: {
  /** On the Agents page, under its head, instead of a sheet over the window. */
  inline?: boolean;
  /** Connections agents can read right now. */
  sharedCount: number;
  onOpenAccess: () => void;
  onClose: () => void;
}) {
  const [checks, setChecks] = useState<Partial<Record<AgentClient, ConnectCheck | string>>>({});
  const [client, setClient] = useState<AgentClient | null>(null);
  const [phase, setPhase] = useState<Record<AgentClient, Phase>>({ "claude-code": IDLE, "claude-desktop": IDLE });
  const [copied, setCopied] = useState(false);
  const primary = useRef<HTMLButtonElement>(null);
  const mac = isMacPlatform();
  const machine = mac ? "this Mac" : "this computer";

  const runCheck = async (c: AgentClient) => {
    try {
      const check = await invoke<ConnectCheck | null>("mcp_connect_check", { client: c });
      if (!check) throw new Error("Rowkery didn't answer");
      setChecks((prev) => ({ ...prev, [c]: check }));
      return check;
    } catch (e) {
      setChecks((prev) => ({ ...prev, [c]: String(e) }));
      return null;
    }
  };

  // Check both on open; start on the first that has something to do.
  useEffect(() => {
    let live = true;
    void Promise.all(CLIENTS.map((c) => runCheck(c.id))).then((all) => {
      if (!live) return;
      const pick =
        all.find((c) => c && (c.state === "ready" || c.state === "other")) ??
        all.find((c) => c && c.state !== "missing") ??
        null;
      setClient((cur) => cur ?? pick?.client ?? "claude-code");
    });
    return () => {
      live = false;
    };
  }, []);

  const shown = client ?? "claude-code";
  const check = checks[shown];
  const ph = phase[shown];
  const name = shown === "claude-code" ? "Claude Code" : "Claude Desktop";

  useEffect(() => {
    primary.current?.focus();
  }, [shown, check, ph.kind]);

  const run = async () => {
    setPhase((p) => ({ ...p, [shown]: { kind: "running" } }));
    try {
      const r = await invoke<ConnectRun>("mcp_connect_run", { client: shown });
      setChecks((prev) => ({ ...prev, [shown]: r.check }));
      setPhase((p) => ({ ...p, [shown]: { kind: "done", ok: r.ok, output: r.output } }));
    } catch (e) {
      setPhase((p) => ({ ...p, [shown]: { kind: "done", ok: false, output: String(e) } }));
    }
  };

  const retry = () => {
    setPhase((p) => ({ ...p, [shown]: IDLE }));
    setChecks((prev) => ({ ...prev, [shown]: undefined }));
    void runCheck(shown);
  };

  const copy = (text: string) => {
    void navigator.clipboard.writeText(text).then(
      () => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1400);
      },
      () => {},
    );
  };

  // Keys on the window, ahead of everything: the sheet may open over another
  // one (the connection sheet), and focus may still be on its way back from ⌘K.
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopImmediatePropagation();
        closeRef.current();
      } else if (e.key === "Enter" && !e.metaKey && !e.ctrlKey && primary.current) {
        // ↵ is always the marked button (Run / Replace / Done / Try again).
        e.preventDefault();
        e.stopImmediatePropagation();
        primary.current.click();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  const shared =
    sharedCount === 0
      ? "No connection is shared yet: turn on Share with agents for one."
      : `${sharedCount} ${sharedCount === 1 ? "connection is" : "connections are"} shared right now.`;
  const restart =
    shown === "claude-code"
      ? "Start a new Claude Code session to use it. A session that's already open won't see it until you restart it."
      : `Quit Claude Desktop${mac ? " (⌘Q)" : ""} and open it again to use it.`;

  let body: React.ReactNode;
  let foot: React.ReactNode;
  const copyBtn = (text: string, label = shown === "claude-code" ? "Copy command" : "Copy entry") => (
    <button type="button" className="mcp-btn" data-mc-copy onClick={() => copy(text)}>
      {copied ? "Copied" : label}
    </button>
  );
  const accessBtn = (
    <button
      type="button"
      className="mcp-btn"
      data-mc-access
      onClick={() => {
        onClose();
        onOpenAccess();
      }}
    >
      Choose what agents can reach
    </button>
  );
  const doneBtn = (
    <button type="button" className="mc-done" data-mc-primary="done" ref={primary} onClick={onClose}>
      Done <kbd>↵</kbd>
    </button>
  );
  const retryBtn = (
    <button type="button" className="mc-done" data-mc-primary="retry" ref={primary} onClick={retry}>
      Try again
    </button>
  );

  if (client === null || check === undefined) {
    body = (
      <pre className="mc-term" data-mc-term>
        <span className="run">Looking for {name}…</span>
      </pre>
    );
    foot = <span className="mcp-grow" />;
  } else if (typeof check === "string") {
    body = <Note kind="err" title={`Couldn't check ${name}.`} text={check} />;
    foot = (
      <>
        <span className="mcp-grow" />
        {retryBtn}
      </>
    );
  } else if (ph.kind === "done" && ph.ok) {
    body = (
      <>
        <Term check={check} output={ph.output} />
        <Note kind="ok" title={`Rowkery is in ${name}.`} text={`${restart} ${shared}`} />
      </>
    );
    foot = (
      <>
        {accessBtn}
        <span className="mcp-grow" />
        {doneBtn}
      </>
    );
  } else if (ph.kind === "done") {
    body = (
      <>
        <Term check={check} output={ph.output} error />
        <Note
          kind="err"
          title={shown === "claude-code" ? "Claude Code couldn't add it." : "Rowkery couldn't update Claude Desktop's config."}
          text={
            shown === "claude-code"
              ? "Its message is above. You can run the command yourself in a terminal."
              : "The message is above. You can add the entry to the file yourself."
          }
        />
      </>
    );
    foot = (
      <>
        {copyBtn(check.copy)}
        <span className="mcp-grow" />
        <button type="button" className="mcp-btn" onClick={onClose}>
          Close
        </button>
        {retryBtn}
      </>
    );
  } else if (check.state === "missing") {
    body = (
      <>
        <Note
          kind="err"
          title={`${name} isn't installed on ${machine}.`}
          text={
            shown === "claude-code"
              ? "Rowkery looked for claude in your shell's PATH and didn't find it. Install Claude Code (claude.com/claude-code), then try again."
              : "Install Claude Desktop from claude.ai/download and open it once, then try again."
          }
        />
        <Term check={check} />
      </>
    );
    foot = (
      <>
        {copyBtn(check.copy)}
        <span className="mcp-grow" />
        {retryBtn}
      </>
    );
  } else if (check.state === "unreadable") {
    body = (
      <>
        <Note
          kind="err"
          title="Claude Desktop's config file isn't valid JSON."
          text={`${check.problem ?? ""} Rowkery won't change it. Fix the file, or add this entry yourself.`}
        />
        <Term check={check} />
      </>
    );
    foot = (
      <>
        {copyBtn(check.copy)}
        <span className="mcp-grow" />
        {retryBtn}
      </>
    );
  } else if (check.state === "connected") {
    body = (
      <>
        <Note
          kind="ok"
          title={`${name} already has Rowkery.`}
          text={`Nothing to run. ${shown === "claude-code" ? "If a session that's open doesn't list it, restart that session." : restart} ${shared}`}
        />
        <Term check={check} />
      </>
    );
    foot = (
      <>
        {accessBtn}
        <span className="mcp-grow" />
        {doneBtn}
      </>
    );
  } else {
    const other = check.state === "other";
    const running = ph.kind === "running";
    body = (
      <>
        {other ? (
          <Note
            kind="warn"
            title={`${name} already has a Rowkery MCP server.`}
            text={
              <>
                It runs <code>{check.existing}</code>. Replace it with this copy of Rowkery?
              </>
            }
          />
        ) : (
          <p className="mc-lead">
            {shown === "claude-code"
              ? "Rowkery will run this command to add its MCP server to Claude Code."
              : "Rowkery will add this entry to Claude Desktop's config file."}
          </p>
        )}
        <Term check={check} running={running} />
        {!other && (
          // One quiet line: in Paper a border means a control, and these aren't.
          <p className="mc-facts" data-testid="mc-facts">
            {[
              ...(shown === "claude-code"
                ? ["Runs once in your login shell", "Adds rowkery for all your projects"]
                : ["Keeps everything else in the file"]),
              `Nothing leaves ${machine}`,
            ].join(" · ")}
          </p>
        )}
      </>
    );
    foot = running ? (
      <>
        <span className="mcp-grow" />
        <button type="button" className="mc-run" disabled>
          Running…
        </button>
      </>
    ) : (
      <>
        {!other && copyBtn(check.copy)}
        <span className="mcp-grow" />
        <button type="button" className="mcp-btn" onClick={onClose}>
          {other ? "Keep it" : "Cancel"}
        </button>
        <button type="button" className="mc-run" data-mc-primary="run" ref={primary} onClick={() => void run()}>
          {other ? "Replace" : "Run"} <kbd>↵</kbd>
        </button>
      </>
    );
  }

  const state =
    check === undefined || client === null
      ? "checking"
      : typeof check === "string"
        ? "error"
        : ph.kind === "done"
          ? ph.ok
            ? "added"
            : "failed"
          : ph.kind === "running"
            ? "running"
            : check.state;
  const panel = (
    <div
      className={inline ? "mc-inline" : "mcp-sheet mc-sheet"}
      role={inline ? "region" : "dialog"}
      aria-modal={inline ? undefined : "true"}
      aria-label="Connect an agent"
      data-mc-sheet={shown}
      data-mc-state={state}
    >
      <div className="mcp-head sheet-head">
        <h2 className="mcp-title sheet-title">Connect an agent</h2>
        <div className="mcp-seg" role="tablist" aria-label="Agent">
          {CLIENTS.map((c) => (
            <button
              key={c.id}
              type="button"
              role="tab"
              data-mc-client={c.id}
              aria-selected={shown === c.id}
              onClick={() => setClient(c.id)}
            >
              {c.label}
            </button>
          ))}
        </div>
        <span className="mcp-grow" />
        <button type="button" className="mcp-esc sheet-esc" title="Close  esc" onClick={onClose}>
          esc
        </button>
      </div>
      <div className="mc-body">{body}</div>
      <div className="mc-foot">{foot}</div>
    </div>
  );
  if (inline) return panel;
  return (
    <div
      className="mcp-overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      {panel}
    </div>
  );
}

function Note({ kind, title, text }: { kind: "ok" | "warn" | "err"; title: string; text: React.ReactNode }) {
  return (
    <div className="mc-note" data-mc-note={kind}>
      <span className="mc-dot" data-k={kind} />
      <b>{title}</b>
      <span>{text}</span>
    </div>
  );
}

/** The command (or config entry) and, once run, what came back. */
function Term({
  check,
  output,
  error,
  running,
}: {
  check: ConnectCheck;
  output?: string;
  error?: boolean;
  running?: boolean;
}) {
  const lines = check.preview.split("\n");
  const desktop = check.client === "claude-desktop";
  return (
    <pre className="mc-term" data-mc-term>
      {lines.map((l, i) =>
        desktop && i === 0 ? (
          <span key={i} className="o">
            {l}
            {"\n"}
          </span>
        ) : (
          <span key={i}>
            {!desktop && <span className="p">$ </span>}
            {l}
            {i < lines.length - 1 ? "\n" : ""}
          </span>
        ),
      )}
      {running && <span className="run">{`\n${desktop ? "Saving…" : "Adding rowkery…"}`}</span>}
      {output && (
        <span className={error ? "e" : "o"} data-mc-output>
          {`\n${output}`}
        </span>
      )}
    </pre>
  );
}
