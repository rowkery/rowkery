"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { GROUPS } from "@/lib/pages";

/** The page list, grouped; the open page is the filled one. On a phone it opens from Menu. */
export function Sidebar() {
  const path = usePathname();
  const here = path.endsWith("/") ? path : `${path}/`;
  return (
    <aside className="side" id="side" aria-label="Docs">
      {GROUPS.map((g) => (
        <nav key={g.title} aria-label={g.title}>
          <h4>{g.title}</h4>
          {g.pages.map((p) => (
            <Link key={p.href} href={p.href} aria-current={p.href === here ? "page" : undefined} data-testid="side-link">
              {p.title}
            </Link>
          ))}
        </nav>
      ))}
    </aside>
  );
}
