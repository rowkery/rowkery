import type { ReactNode } from "react";
import { isValidElement } from "react";

/** A heading's plain text, through any inline code or links inside it. */
export function textOf(node: ReactNode): string {
  if (node == null || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  if (isValidElement<{ children?: ReactNode }>(node)) return textOf(node.props.children);
  return "";
}

/** "If it can't connect" → "if-it-cant-connect". Search uses the same rule for its links. */
export function slug(text: string): string {
  return text
    .toLowerCase()
    .replace(/[’'`]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}
