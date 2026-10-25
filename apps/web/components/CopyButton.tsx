"use client";

import { useState } from "react";

/**
 * Copy, at the end of a command box: goes just before the command, inside a `.box`, so it stays
 * put while the command scrolls. Says Copied for a moment, or selects the command where there's
 * no clipboard.
 */
export function CopyButton({ text }: { text: string }) {
  const [said, setSaid] = useState("Copy");
  const copy = async (e: React.MouseEvent<HTMLButtonElement>) => {
    const block = e.currentTarget.nextElementSibling;
    try {
      await navigator.clipboard.writeText(text);
      setSaid("Copied");
    } catch {
      // No clipboard (an insecure context or a refused permission): select the command instead.
      if (block) getSelection()?.selectAllChildren(block);
      setSaid("Selected");
    }
    setTimeout(() => setSaid("Copy"), 1400);
  };
  return (
    <button type="button" className="copy" onClick={copy}>
      <svg viewBox="0 0 16 16" aria-hidden="true">
        <rect x="5" y="5" width="8.5" height="8.5" rx="2" />
        <path d="M11 3.2V3a1.5 1.5 0 0 0-1.5-1.5h-6A1.5 1.5 0 0 0 2 3v6a1.5 1.5 0 0 0 1.5 1.5h.2" />
      </svg>
      {said}
    </button>
  );
}
