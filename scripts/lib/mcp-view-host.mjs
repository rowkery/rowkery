// A stand-in MCP Apps host for Rowkery's view in the chat (crates/rowkery-mcp/src/view.html),
// speaking the postMessage protocol the way Claude Desktop does: it draws the page in a
// sandboxed frame, answers ui/initialize, sizes the frame to the page, and answers the page's
// tool calls (window.calls logs them; window.proposalStatus is proposal_status's answer).
// Used by scripts/mcp-view-browser-proof.mjs and scripts/docs-shots/chat-views.mjs.
import { readFileSync, writeFileSync } from "node:fs";

const ROOT = new globalThis.URL("../../", import.meta.url).pathname;

/** The page as `rowkery --mcp` serves it, the mark spliced in. */
export const VIEW_HTML = readFileSync(`${ROOT}crates/rowkery-mcp/src/view.html`, "utf8").replace(
  "<!--mark-->",
  readFileSync(`${ROOT}apps/rowkery-tauri/brand/rowkery-mark-no-shadow.svg`, "utf8"),
);

/** A tool result as `rowkery --mcp` sends it: the agent's text, plus _meta["rowkery/view"] for the page. */
export const toolResult = (text, view) => ({
  content: [{ type: "text", text: JSON.stringify(text) }],
  _meta: { "rowkery/view": view },
});

const hostPage = (theme, width) => `<!doctype html><html><body style="margin:0;padding:16px;background:${theme === "dark" ? "#262624" : "#f4f4f2"}">
<iframe id="v" sandbox="allow-scripts" style="border:0;width:${width}px;height:80px;display:block"></iframe>
<script>
window.calls = [];
window.proposalStatus = { state: "waiting" };
const frame = document.getElementById("v");
const reply = (id, result) => frame.contentWindow.postMessage({ jsonrpc: "2.0", id, result }, "*");
window.addEventListener("message", (e) => {
  const m = e.data;
  if (e.source !== frame.contentWindow || !m || m.jsonrpc !== "2.0") return;
  if (m.method === "ui/initialize") {
    reply(m.id, { protocolVersion: "2026-01-26", hostInfo: { name: "host", version: "1" },
      hostCapabilities: window.noTools ? {} : { serverTools: {} },
      hostContext: { theme: ${JSON.stringify(theme)}, displayMode: "inline", availableDisplayModes: ["inline", "fullscreen"] } });
  } else if (m.method === "ui/notifications/initialized") {
    window.ready = true;
  } else if (m.method === "ui/notifications/size-changed") {
    frame.style.height = m.params.height + "px";
  } else if (m.method === "tools/call") {
    window.calls.push(m.params);
    const body = m.params.name === "proposal_status" ? window.proposalStatus : { opened: true };
    reply(m.id, { content: [{ type: "text", text: JSON.stringify(body) }] });
  } else if (m.id !== undefined) {
    reply(m.id, {});
  }
});
window.send = (method, params) => frame.contentWindow.postMessage({ jsonrpc: "2.0", method, params }, "*");
</script></body></html>`;

/**
 * A new page with the view drawn for `result` (and the tool's arguments, `input`). Options:
 * `noTools` for a host that can't call tools, `width` of the frame, `out` the folder the host
 * page is written to. Returns { page, frame }.
 */
export async function drawView(browser, theme, result, { input, noTools = false, width = 640, out, viewport = { width: 700, height: 640 } } = {}) {
  const page = await browser.newPage({ viewport, deviceScaleFactor: 2 });
  const file = `${out}/host-${theme}.html`;
  writeFileSync(file, hostPage(theme, width));
  await page.goto(`file://${file}`);
  if (noTools) await page.evaluate(() => (window.noTools = true));
  await page.evaluate((html) => (document.getElementById("v").srcdoc = html), VIEW_HTML);
  await page.waitForFunction(() => window.ready === true);
  if (input) await page.evaluate((a) => window.send("ui/notifications/tool-input", { arguments: a }), input);
  await page.evaluate((r) => window.send("ui/notifications/tool-result", r), result);
  const frame = page.frameLocator("#v");
  await frame.locator('[data-testid="mcp-view"]').waitFor();
  return { page, frame };
}
