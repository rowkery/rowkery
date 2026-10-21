import type { CSSProperties, ReactNode } from "react";
import { DatabaseIcon, TableIcon } from "../Icons";
import "./story.css";

/** A scene's height in scroll units (engine.ts: the stage stays pinned for that many units). */
export const units = (n: number) => ({ "--n": n }) as CSSProperties;

/** A big title, one span per word so the words can arrive one after another. */
export function Title({ lines, className = "title" }: { lines: string[]; className?: string }) {
  return (
    <h2 className={className}>
      {lines.map((line, l) => (
        <span className="ln" key={line}>
          {l > 0 && " "}
          {line.split(" ").map((w, i) => (
            <span key={i}>
              {i > 0 && " "}
              <span className="w">{w}</span>
            </span>
          ))}
        </span>
      ))}
    </h2>
  );
}

/** The scene's steps: a caption each, and a rail of slim bars, the current one filling as you scroll. */
export function Steps({ steps }: { steps: [title: string, text: string][] }) {
  return (
    <>
      <div className="rail" aria-hidden="true">
        {steps.map(([t]) => (
          <b key={t}>
            <i />
          </b>
        ))}
      </div>
      <ol className="caps">
        {steps.map(([t, p], i) => (
          <li className="cap" key={t}>
            <span className="n" aria-hidden="true">
              0{i + 1} / 0{steps.length}
            </span>
            <h3>{t}</h3>
            <p>{p}</p>
          </li>
        ))}
      </ol>
    </>
  );
}

/** A little app window's title bar: the lights, the connection's tab, and whatever sits at the right. */
export function TitleBar({ env, children }: { env: "prd" | "local"; children: ReactNode }) {
  return (
    <div className="tb">
      <span className="lights">
        <i />
        <i />
        <i />
      </span>
      <span className="tab">
        <DatabaseIcon />
        storefront <i className={`dot ${env}`} />
      </span>
      <span className="sp" />
      {children}
    </div>
  );
}

/** The window's schema column: the database, its host and its tables, with row counts. */
export function Side({ host, env, tables, on }: { host: string; env: "prd" | "local"; tables: [name: string, rows: string][]; on?: string }) {
  return (
    <div className="side">
      <div className="db">shop</div>
      <div className="host">
        {host} <i className={`dot ${env}`} />
      </div>
      <div className="filter">Filter tables</div>
      <div className="sch">public</div>
      {tables.map(([t, n]) => (
        <div className={`t${t === on ? " on" : ""}`} data-t={t} key={t}>
          <TableIcon />
          {t}
          <b>{n}</b>
        </div>
      ))}
    </div>
  );
}

/** SQL with its keywords in orange: a keyword is a one-item array. */
export function Sql({ parts, className = "sql" }: { parts: (string | [string])[]; className?: string }) {
  return (
    <div className={className}>
      {parts.map((p, i) =>
        typeof p === "string" ? (
          p
        ) : (
          <span className="k" key={i}>
            {p[0]}
          </span>
        ),
      )}
    </div>
  );
}
