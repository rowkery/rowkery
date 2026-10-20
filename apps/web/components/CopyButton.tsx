"use client";

import { useState } from "react";

/** Copy, in the corner of a code block: says Copied for a moment, or selects the block where there's no clipboard. */
export function CopyButton({ text }: { text: string }) {
  const [said, setSaid] = useState("Copy");
  const copy = async (e: React.MouseEvent<HTMLButtonElement>) => {
    const block = e.currentTarget.parentElement;
    try {
      await navigator.clipboard.writeText(text);
      setSaid("Copied");
    } catch {
      // No clipboard (an insecure context or a refused permission): select the block instead.
      if (block) getSelection()?.selectAllChildren(block);
      setSaid("Selected");
    }
    setTimeout(() => setSaid("Copy"), 1400);
  };
  return (
    <button type="button" className="copy" onClick={copy} data-copy>
      {said}
    </button>
  );
}
