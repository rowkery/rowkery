"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { PAGES, pageAt } from "@/lib/pages";

/** Previous and next page, in sidebar order. */
export function Pager() {
  const here = pageAt(usePathname());
  if (!here) return null;
  const i = PAGES.indexOf(here);
  const prev = PAGES[i - 1];
  const next = PAGES[i + 1];
  return (
    <nav className="pager" aria-label="Previous and next page">
      {prev && (
        <Link href={prev.href}>
          <small>Previous</small>
          <b>{prev.title}</b>
        </Link>
      )}
      {next && (
        <Link className="next" href={next.href}>
          <small>Next</small>
          <b>{next.title}</b>
        </Link>
      )}
    </nav>
  );
}
