"use client";

import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { EDIT_BASE } from "@/lib/site";
import { pageAt } from "@/lib/pages";

type Item = { id: string; text: string };

/** "On this page": the page's ## headings, the one being read in white. */
export function Toc() {
  const path = usePathname();
  const [items, setItems] = useState<Item[]>([]);
  const [on, setOn] = useState<string | null>(null);

  useEffect(() => {
    const hs = [...document.querySelectorAll<HTMLHeadingElement>("main h2[id]")];
    setItems(hs.map((h) => ({ id: h.id, text: h.textContent ?? "" })));
    const onScroll = () => {
      let cur: string | null = null;
      for (const h of hs) if (h.getBoundingClientRect().top < 120) cur = h.id;
      setOn(cur);
    };
    onScroll();
    addEventListener("scroll", onScroll, { passive: true });
    return () => removeEventListener("scroll", onScroll);
  }, [path]);

  const page = pageAt(path);
  return (
    <aside className="toc" aria-label="On this page">
      {items.length > 0 && <h5>On this page</h5>}
      {items.map((i) => (
        <a key={i.id} href={`#${i.id}`} className={i.id === on ? "on" : undefined}>
          {i.text}
        </a>
      ))}
      {page && (
        <a className="edit" href={`${EDIT_BASE}/${page.file}`}>
          Edit this page on GitHub
        </a>
      )}
    </aside>
  );
}
