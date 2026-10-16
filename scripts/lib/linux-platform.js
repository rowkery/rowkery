// Pins the platform to Linux for a proof that doesn't load frames-shim.js
// (which does the same): proofs are written with Linux keys and labels
// (Ctrl+K, "Ctrl+C"), as on the Linux runner, so they behave the same on a
// Mac. A proof about macOS keys sets navigator.platform itself, after this.
// `await page.addInitScript({ path: LINUX_PLATFORM })`, before the stub.
(() => {
  const linuxAgent = navigator.userAgent.replace(/\(Macintosh;[^)]*\)/, "(X11; Linux x86_64)");
  for (const [prop, value] of [["platform", "Linux x86_64"], ["userAgent", linuxAgent]]) {
    Object.defineProperty(Navigator.prototype, prop, { get: () => value, configurable: true });
  }
})();
