// The app's Content-Security-Policy, in one place. tauri.conf.json holds the
// policy for a build without a report URL (test/csp.test.ts keeps the two
// the same); `tauri.mjs` (what `npm run tauri` runs) passes the policy for
// this build's VITE_ROWKERY_REPORT_URL to `tauri build` / `tauri dev`, and
// scripts/csp-browser-proof.mjs serves the built app under it.
//
// Scripts come only from the app itself: Tauri adds hashes for the inline
// scripts in index.html when it builds, and nothing else may run. Requests
// go only to Tauri's IPC and the report relay (the updater fetches from
// Rust, outside the webview).

/** The report relay's origin (`https://relay.example.dev`), or null. */
export function reportOrigin(reportUrl) {
  if (!reportUrl) return null;
  try {
    const url = new URL(reportUrl);
    return url.protocol === "https:" || url.protocol === "http:" ? url.origin : null;
  } catch {
    return null;
  }
}

const join = (directives) =>
  Object.entries(directives)
    .map(([name, sources]) => [name, ...sources].join(" "))
    .join("; ");

/** The policy the built app runs under. */
export function appCsp(reportUrl) {
  const report = reportOrigin(reportUrl);
  return join({
    "default-src": ["'self'"],
    "script-src": ["'self'"],
    "style-src": ["'self'"],
    "img-src": ["'self'", "data:", "blob:"],
    "font-src": ["'self'", "data:"],
    "connect-src": ["ipc:", "http://ipc.localhost", ...(report ? [report] : [])],
    "object-src": ["'none'"],
    "base-uri": ["'self'"],
    "form-action": ["'none'"],
    "frame-ancestors": ["'none'"],
  });
}

/**
 * `tauri dev`: Vite serves modules, injects CSS as <style> tags, runs the
 * React Refresh preamble inline and talks HMR over a WebSocket on its port.
 */
export function devCsp(reportUrl, devHost = null) {
  const report = reportOrigin(reportUrl);
  const vite = devHost
    ? [`http://${devHost}:1420`, `ws://${devHost}:1420`, `ws://${devHost}:1421`]
    : ["http://localhost:1420", "ws://localhost:1420"];
  return join({
    "default-src": ["'self'"],
    "script-src": ["'self'", "'unsafe-inline'"],
    "style-src": ["'self'", "'unsafe-inline'"],
    "img-src": ["'self'", "data:", "blob:"],
    "font-src": ["'self'", "data:"],
    "connect-src": ["ipc:", "http://ipc.localhost", ...vite, ...(report ? [report] : [])],
    "object-src": ["'none'"],
    "base-uri": ["'self'"],
    "form-action": ["'none'"],
    "frame-ancestors": ["'none'"],
  });
}
