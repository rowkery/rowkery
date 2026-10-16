"use client";

import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";

/** On a phone the sidebar is hidden; Menu shows it over the page until a page is picked. */
export function MenuButton() {
  const [open, setOpen] = useState(false);
  const path = usePathname();
  useEffect(() => setOpen(false), [path]);
  useEffect(() => {
    document.body.classList.toggle("menu-open", open);
  }, [open]);
  return (
    <button type="button" className="menu-btn" aria-expanded={open} aria-controls="side" onClick={() => setOpen((o) => !o)}>
      {open ? "Close" : "Menu"}
    </button>
  );
}
