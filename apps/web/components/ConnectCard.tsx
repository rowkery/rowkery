"use client";

import { useState } from "react";
import { APP_EXE } from "@/lib/site";
import { CopyButton } from "./CopyButton";

/**
 * Connecting an agent, per client: Claude Code's own command, and the entry Claude Desktop or
 * Cursor reads from its config file (what the app's Connect an agent writes for Claude
 * Desktop, src-tauri/src/mcp_connect.rs).
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

export function ConnectCard() {
  const [client, setClient] = useState(CLIENTS[0]);
  return (
    <div className="card connect" id="connect">
      <h2>Connect your agent</h2>
      <p className="more-lead">One click in the app for Claude Code and Claude Desktop. Any other MCP client runs the app with --mcp.</p>
      <div className="tabs" role="tablist" aria-label="Agent">
        {CLIENTS.map((c) => (
          <button key={c.id} type="button" className="tab" role="tab" aria-selected={c === client} onClick={() => setClient(c)} data-client={c.id}>
            {c.name}
          </button>
        ))}
      </div>
      <div className="code-box">
        <CopyButton text={client.text} />
        <div className="code" role="tabpanel" aria-label={client.name}>
          {client.prompt && <span className="p">$ </span>}
          {client.label && <span className="c">{`${client.label}\n`}</span>}
          {client.text}
        </div>
      </div>
      <p className="connect-note">
        Or press <kbd>⌘K</kbd> › Connect an agent in the app.
      </p>
    </div>
  );
}
