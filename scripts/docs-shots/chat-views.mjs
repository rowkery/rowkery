#!/usr/bin/env node
// Docs screens for /rows-in-the-chat/: Rowkery's view in the chat, drawn by the stand-in MCP Apps
// host of scripts/lib/mcp-view-host.mjs in the dark scheme the docs use:
//  - rows-in-the-chat-rows: a query's rows as a grid, a masked column, Open in Rowkery;
//  - rows-in-the-chat-proposal: a proposed change waiting, Review in Rowkery;
//  - rows-in-the-chat-committed: the same card once you committed it.
// Not a proof (scripts/mcp-view-browser-proof.mjs is): it checks nothing beyond waiting for each screen.
//
//   node scripts/docs-shots/chat-views.mjs [outDir] [--write] [--only=chat-rows,proposal,committed]
import { launch, shot, close, sizes, OUT } from "./lib.mjs";
import { drawView, toolResult } from "../lib/mcp-view-host.mjs";

const browser = await launch();
const conn = { name: "shop", environment: "prd" };
const draw = (r, opts) => drawView(browser, "dark", r, { out: OUT, width: 720, viewport: { width: 760, height: 600 }, ...opts });

const rows = [
  [4127, "masked:3f9a0c11e2", "Paylane", "412.00", "2026-10-21 09:14"],
  [4126, "masked:a1c07e5d93", "Stripe", "388.50", "2026-10-21 08:52"],
  [4124, "masked:0d6e2bb841", "Stripe", "301.20", "2026-10-20 17:30"],
  [4123, "masked:7be41f0c2a", "Adyen", "129.00", "2026-10-20 16:05"],
  [4120, "masked:c58d9e0371", "Paylane", "96.40", "2026-10-20 11:48"],
  [4118, "masked:52f1a7d6e0", "Stripe", "54.90", "2026-10-19 21:17"],
];
{
  const { page } = await draw(
    toolResult(
      { columns: ["id", "email", "provider", "total", "created_at"], types: ["int8", "text", "text", "numeric", "timestamptz"], rows, row_count: rows.length, more: false, elapsed_ms: 12, masked: ["email"] },
      { kind: "rows", call: "1760000000000-1760000001234-9f2cabcdef0123456789abcdef012345", connection: conn, database: "shop" },
    ),
  );
  await shot(page, "rows-in-the-chat-rows", { el: "#v", pad: 0 });
  await page.close();
}
const SQL = "UPDATE orders SET status = 'failed'\nWHERE status = 'pending' AND provider_id = 4\n  AND created_at < '2026-10-20'";
const proposal = toolResult(
  { id: "p_0123456789ab", state: "waiting" },
  { kind: "proposal", id: "p_0123456789ab", connection: conn, database: "shop", statements: [{ verb: "UPDATE", target: "orders", sql: SQL }], reason: "Mark the Paylane orders stuck since Monday as failed, so customers get the retry email.", expect_rows: 29 },
);
{
  const { page, frame } = await draw(proposal);
  await shot(page, "rows-in-the-chat-proposal", { el: "#v" });
  await page.evaluate(() => (window.proposalStatus = { id: "p_0123456789ab", state: "committed", rows: [29], at_ms: Date.UTC(2026, 9, 22, 6, 6) }));
  await frame.locator('[data-testid="view-state"][data-state="committed"]').waitFor({ timeout: 6000 });
  await shot(page, "rows-in-the-chat-committed", { el: "#v" });
  await page.close();
}
sizes();
await close();
