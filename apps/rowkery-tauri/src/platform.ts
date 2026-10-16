export function isMacPlatform(): boolean {
  if (typeof navigator === "undefined") return false;
  return (
    /Mac|iPhone|iPod|iPad/i.test(navigator.platform) ||
    /Mac OS X/i.test(navigator.userAgent)
  );
}

export function runShortcutLabel(): string {
  return isMacPlatform() ? "⌘ Enter" : "Ctrl Enter";
}
