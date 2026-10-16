"use client";

import { useRef, useState, type ComponentPropsWithoutRef } from "react";

/** A code block with a Copy button that copies exactly the code. */
export function CodeBlock(props: ComponentPropsWithoutRef<"pre">) {
  const ref = useRef<HTMLPreElement>(null);
  const [copied, setCopied] = useState(false);
  const copy = () => {
    const text = ref.current?.querySelector("code")?.textContent ?? ref.current?.textContent ?? "";
    navigator.clipboard?.writeText(text.replace(/\n$/, "")).then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1200);
      },
      () => {},
    );
  };
  return (
    <div className="code">
      <pre ref={ref} {...props} />
      <button type="button" className="copy" onClick={copy} data-testid="copy">
        {copied ? "Copied" : "Copy"}
      </button>
    </div>
  );
}
