"use client";

import { useState } from "react";
import { CheckIcon, CopyIcon } from "./Icons";

/** A one-line shell command with a button that copies it; the icon turns to a tick for 2 s. */
export function CopyCommand({ command }: { command: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(command);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // No clipboard (an insecure context or a refused permission): the command stays selectable.
    }
  };
  return (
    <div className="cmd" data-command>
      <pre>{command}</pre>
      <button type="button" className="copy" onClick={copy} aria-label={copied ? "Copied" : "Copy the command"} data-copied={copied || undefined}>
        {copied ? <CheckIcon /> : <CopyIcon />}
      </button>
    </div>
  );
}
