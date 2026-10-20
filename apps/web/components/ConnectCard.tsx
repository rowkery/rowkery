"use client";

import { useRef, useState } from "react";
import { APP_EXE } from "@/lib/site";
import { Pg } from "./Pg";
import { CopyButton } from "./CopyButton";

/**
 * Connecting an agent, per client: Claude Code's own command, and the entry Claude Desktop or
 * Cursor reads from its config file (what the app's Connect an agent writes for Claude
 * Desktop, src-tauri/src/mcp_connect.rs). The penguin peeks over the card and says one line
 * after another; tap it and it hops and moves on.
 */
const entry = (file: string) => ({
  label: `// ${file}`,
  text: `"rowkery": {\n  "command": "${APP_EXE}",\n  "args": ["--mcp"]\n}`,
});
const CLIENTS = [
  { id: "code", name: "Claude Code", prompt: true, label: "", text: `claude mcp add --scope user rowkery \\\n  -- ${APP_EXE} \\\n  --mcp` },
  { id: "desktop", name: "Claude Desktop", prompt: false, ...entry("claude_desktop_config.json › mcpServers") },
  { id: "cursor", name: "Cursor", prompt: false, ...entry("~/.cursor/mcp.json › mcpServers") },
];
const LINES = ["SELECT * FROM fish;", "I only read what you share", "Nothing changes until you press Commit", "⌘K, then anything", "No account. Just me."];
// The bubble's cycle (globals.css, .bubble and .hops): the first line after the peek, then one
// every LINE_MS. CSS runs it, so nothing on the page lays out while it sits still.
const FIRST_MS = 2100;
const LINE_MS = 5200;

export function ConnectCard() {
  const [client, setClient] = useState(CLIENTS[0]);
  // The line shown under Reduce Motion, where nothing cycles by itself.
  const [still, setStill] = useState(0);
  const box = useRef<HTMLDivElement>(null);
  // A tap starts the next line now: every animation in the cycle jumps to that line's start,
  // which also lands the penguin's hop.
  const next = () => {
    const cycle = box.current!.getAnimations({ subtree: true }).filter((a) => a instanceof CSSAnimation && (a.animationName === "say" || a.animationName === "hop"));
    if (!cycle.length) return setStill((n) => (n + 1) % LINES.length);
    const t = Number(cycle[0].currentTime ?? 0);
    const at = t < FIRST_MS ? FIRST_MS : t + LINE_MS - ((t - FIRST_MS) % LINE_MS);
    for (const a of cycle) a.currentTime = at;
  };
  return (
    <div className="connect" ref={box}>
      {LINES.map((l, i) => (
        <div className={`bubble${i === still ? " on" : ""}`} key={l} style={{ animationDelay: `${FIRST_MS + i * LINE_MS}ms` }} aria-hidden="true">
          {l}
        </div>
      ))}
      <button type="button" className="peek" onClick={next} aria-label="Say something else" data-peek>
        <span className="hops">
          <Pg />
        </span>
      </button>
      <div className="card">
        <h3>
          Connect your agent <span>MCP</span>
        </h3>
        <div className="tabs" role="tablist" aria-label="Agent">
          {CLIENTS.map((c) => (
            <button key={c.id} type="button" className="tab" role="tab" aria-selected={c === client} onClick={() => setClient(c)} data-client={c.id}>
              {c.name}
            </button>
          ))}
        </div>
        <div className="code" role="tabpanel" aria-label={client.name}>
          <CopyButton text={client.text} />
          {client.prompt && <span className="p">$ </span>}
          {client.label && <span className="c">{`${client.label}\n`}</span>}
          {client.text}
        </div>
        <p className="connect-note">
          Or press <kbd>⌘K</kbd> › Connect an agent in the app.
        </p>
      </div>
    </div>
  );
}
