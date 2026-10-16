"use client";

import { usePathname, useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import type { SearchEntry } from "@/lib/search-index";

/**
 * ⌘K (Ctrl+K off the Mac) or a click on the search pill opens the search over every page
 * and heading. ↑↓ pick, ↵ opens, Esc closes. The index is built at build time.
 */
export function Search({ index }: { index: SearchEntry[] }) {
  const router = useRouter();
  const path = usePathname();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [sel, setSel] = useState(0);
  const [mac, setMac] = useState(true);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => setMac(/Mac|iPhone|iPad/.test(navigator.platform)), []);
  useEffect(() => setOpen(false), [path]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((o) => !o);
      }
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    if (open) {
      setQ("");
      setSel(0);
      input.current?.focus();
    }
  }, [open]);

  const hits = useMemo(() => {
    const words = q.toLowerCase().split(/\s+/).filter(Boolean);
    if (!words.length) return index.filter((e) => !e.href.includes("#"));
    // Titles that start with the words first, then titles holding them, then the rest; in page order within each.
    const rank = (e: SearchEntry) => {
      const t = e.title.toLowerCase();
      return t.startsWith(words.join(" ")) ? 0 : words.every((w) => t.includes(w)) ? 1 : 2;
    };
    return index
      .filter((e) => words.every((w) => `${e.title} ${e.page}`.toLowerCase().includes(w)))
      .map((e, i) => ({ e, i, r: rank(e) }))
      .sort((a, b) => a.r - b.r || a.i - b.i)
      .slice(0, 12)
      .map((x) => x.e);
  }, [q, index]);

  const go = (e?: SearchEntry) => {
    if (!e) return;
    setOpen(false);
    router.push(e.href);
  };

  const keys = mac ? "⌘K" : "Ctrl K";
  return (
    <>
      <button type="button" className="search" onClick={() => setOpen(true)} data-testid="search-open">
        <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
          <circle cx="7" cy="7" r="5" />
          <path d="m11 11 3.5 3.5" />
        </svg>
        <span className="ph">Search the docs</span>
        <span className="k">{keys}</span>
      </button>
      {open && (
        <div className="scrim" onMouseDown={() => setOpen(false)}>
          <div className="finder" role="dialog" aria-label="Search the docs" onMouseDown={(e) => e.stopPropagation()} data-testid="search">
            <input
              ref={input}
              value={q}
              placeholder="Search pages and sections"
              aria-label="Search pages and sections"
              onChange={(e) => {
                setQ(e.target.value);
                setSel(0);
              }}
              onKeyDown={(e) => {
                if (e.key === "Escape") setOpen(false);
                else if (e.key === "ArrowDown") {
                  e.preventDefault();
                  setSel((s) => Math.min(s + 1, hits.length - 1));
                } else if (e.key === "ArrowUp") {
                  e.preventDefault();
                  setSel((s) => Math.max(s - 1, 0));
                } else if (e.key === "Enter") go(hits[sel]);
              }}
            />
            <ul>
              {hits.map((h, i) => (
                <li key={h.href}>
                  <button type="button" aria-selected={i === sel} onMouseEnter={() => setSel(i)} onClick={() => go(h)} data-testid="search-hit">
                    <b>{h.title}</b>
                    <span>{h.page}</span>
                  </button>
                </li>
              ))}
              {hits.length === 0 && <li className="none">Nothing matches “{q}”</li>}
            </ul>
          </div>
        </div>
      )}
    </>
  );
}
