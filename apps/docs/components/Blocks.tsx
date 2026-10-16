import Link from "next/link";
import type { ReactNode } from "react";

/** A real app screen (dark, 2x) in a rounded panel; `side` floats it beside the text that follows on wide screens. */
export function Shot({ src, alt, width, height, caption, side }: { src: string; alt: string; width: number; height: number; caption?: string; side?: boolean }) {
  return (
    <figure className={side ? "shot shot-side" : "shot"}>
      <img src={src} alt={alt} width={width} height={height} loading="lazy" />
      {caption && <figcaption>{caption}</figcaption>}
    </figure>
  );
}

/** Numbered steps: each ### heading inside is one step, its number drawn by CSS. */
export function Steps({ children }: { children: ReactNode }) {
  return <div className="steps">{children}</div>;
}

export function Cards({ children }: { children: ReactNode }) {
  return <div className="cards">{children}</div>;
}

/** A whole card is the link: a title and one line under it. */
export function Card({ href, title, children }: { href: string; title: string; children: ReactNode }) {
  return (
    <Link className="card" href={href}>
      <b>{title}</b>
      <span>{children}</span>
    </Link>
  );
}

export function Note({ children }: { children: ReactNode }) {
  return <div className="note">{children}</div>;
}

/** An environment tag as the app draws it: dot and word on its own wash. */
export function Env({ name }: { name: "prd" | "stg" | "dev" | "local" }) {
  return (
    <span className={`env ${name}`}>
      <i />
      {name}
    </span>
  );
}
