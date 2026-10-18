// The Cloud SQL part of the New connection form: the Google account a
// connection signs in with, and the instance picker (grouped by project,
// filterable, or any connection name typed in).
import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import {
  cloudsqlInstances,
  type CloudSqlAccount,
  type CloudSqlInstance,
  type CloudSqlInstanceList,
  type CloudSqlLogin,
} from "./api";
import { ChevronDownIcon, SearchIcon } from "./icons";
import { useGlideHover } from "./motion";

/** The command that makes a gcloud login Rowkery can use (`cloudsql::GCLOUD_LOGIN`). */
export const GCLOUD_LOGIN = "gcloud auth application-default login";

/** `project:region:instance` (a Workspace project has a colon of its own). */
export function isConnectionName(text: string): boolean {
  const parts = text.trim().split(":");
  return (parts.length === 3 || parts.length === 4) && parts.every((p) => p.length > 0 && !/[\s/]/.test(p));
}

/** The instance's own name, the last part of its connection name. */
export const instanceShortName = (connectionName: string) => connectionName.trim().split(":").pop() ?? "";

export function CloudSqlAccountRow({
  account,
  credentials,
  error,
  onUseKey,
  onUseGcloud,
  onRecheck,
}: {
  /** undefined while looking; null: no gcloud login (or no key picked yet). */
  account: CloudSqlAccount | null | undefined;
  credentials: "gcloud" | "key";
  error?: string;
  onUseKey: () => void;
  onUseGcloud: () => void;
  onRecheck: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const state = error ? "error" : account === undefined ? "loading" : account ? account.kind : "none";
  return (
    <div data-testid="nc-field" className={`nc-field${error ? " invalid" : ""}`} data-field="account" data-invalid={error ? "" : undefined}>
      <span data-testid="nc-label" className="nc-label">
        Google account
        {credentials === "key" && account && <span className="nc-label-aside">key kept in the keychain</span>}
      </span>
      <div data-testid="csql-account" className="nc-group csql-account" data-state={state}>
        {account === undefined && !error ? (
          <div className="csql-account-row">
            <span className="csql-account-text">
              <span className="csql-account-sub">{credentials === "key" ? "Reading the key…" : "Looking for a gcloud login…"}</span>
            </span>
          </div>
        ) : account && !error ? (
          <div className="csql-account-row">
            <span className="csql-avatar" aria-hidden>
              {(account.email ?? "?").slice(0, 1).toUpperCase()}
            </span>
            <span className="csql-account-text">
              <span className="csql-account-email" data-csql-email>
                {account.email ?? "Signed in"}
              </span>
              <span className="csql-account-sub">{account.kind === "gcloud" ? "gcloud login on this computer" : "service account key"}</span>
            </span>
            <button type="button" className="nc-btn" data-csql-switch onClick={account.kind === "gcloud" ? onUseKey : onUseGcloud}>
              {account.kind === "gcloud" ? "Use a key file…" : "Use gcloud login"}
            </button>
          </div>
        ) : credentials === "key" ? (
          <div className="csql-account-row">
            <span className="csql-account-text">
              <span className="csql-account-email">{error ?? "No key file yet"}</span>
            </span>
            <button type="button" className="nc-btn" data-csql-key onClick={onUseKey}>
              Choose key file…
            </button>
            <button type="button" className="nc-btn" data-csql-switch onClick={onUseGcloud}>
              Use gcloud login
            </button>
          </div>
        ) : (
          <>
            <div className="csql-account-row">
              <span className="csql-account-text">
                <span className="csql-account-email">{error ?? "No gcloud login on this computer"}</span>
                <span className="csql-account-sub">Run this in Terminal, or use a service account key</span>
              </span>
            </div>
            <div className="csql-command">
              <code>{GCLOUD_LOGIN}</code>
              <button
                type="button"
                className="nc-btn"
                data-csql-copy
                onClick={() => {
                  void navigator.clipboard?.writeText(GCLOUD_LOGIN).catch(() => {});
                  setCopied(true);
                }}
              >
                {copied ? "Copied" : "Copy"}
              </button>
            </div>
            <div className="csql-account-acts">
              <button type="button" className="nc-btn" data-csql-recheck onClick={onRecheck}>
                Check again
              </button>
              <button type="button" className="nc-btn" data-csql-key onClick={onUseKey}>
                Use a key file…
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

/** One row of the picker: an instance, or a connection name typed in. */
type Row = { kind: "instance"; instance: CloudSqlInstance } | { kind: "typed"; name: string };

export function CloudSqlInstanceField({
  value,
  login,
  disabled,
  error,
  onPick,
}: {
  /** The connection name, `project:region:instance`. */
  value: string;
  login: CloudSqlLogin;
  disabled: boolean;
  error?: string;
  onPick: (connectionName: string) => void;
}) {
  const [open, setOpen] = useState(false);
  // Listed once per login while the sheet is open.
  const [listed, setListed] = useState<{ key: string; list?: CloudSqlInstanceList; error?: string } | null>(null);
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  useGlideHover(listRef, ".csql-option");
  const loginKey = JSON.stringify(login);

  useEffect(() => {
    if (!open || listed?.key === loginKey) return;
    setListed({ key: loginKey });
    cloudsqlInstances(login).then(
      (list) => setListed((cur) => (cur?.key === loginKey ? { key: loginKey, list } : cur)),
      (e) => setListed((cur) => (cur?.key === loginKey ? { key: loginKey, error: String(e) } : cur)),
    );
  }, [open, loginKey]);

  // A click outside closes it.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  const list = listed?.key === loginKey ? listed.list : undefined;
  const listError = listed?.key === loginKey ? listed.error : undefined;
  const all = list?.instances ?? [];
  const postgres = all.filter((i) => i.postgres);
  const others = all.length - postgres.length;
  const q = query.trim().toLowerCase();
  const matches = postgres.filter((i) => !q || i.connection_name.toLowerCase().includes(q));
  const typed = isConnectionName(query) && !all.some((i) => i.connection_name === query.trim());
  const rows: Row[] = [
    ...(typed ? [{ kind: "typed" as const, name: query.trim() }] : []),
    ...matches.map((instance) => ({ kind: "instance" as const, instance })),
  ];
  const projects = [...new Set(matches.map((i) => i.project))];
  const pick = (row: Row) => {
    onPick(row.kind === "typed" ? row.name : row.instance.connection_name);
    setOpen(false);
    setQuery("");
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const step = e.key === "ArrowDown" ? 1 : -1;
      setCursor((c) => (rows.length ? (c + step + rows.length) % rows.length : 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      e.stopPropagation();
      const row = rows[cursor];
      if (row) pick(row);
    } else if (e.key === "Escape") {
      // Closes the picker, not the sheet.
      e.preventDefault();
      e.stopPropagation();
      setOpen(false);
    }
  };

  const option = (row: Row, n: number) => {
    const name = row.kind === "typed" ? row.name : row.instance.connection_name;
    return (
      <li key={name} role="option" aria-selected={n === cursor}>
        <button
          type="button"
          data-csql-option={row.kind === "typed" ? "typed" : row.instance.name}
          className={`conn-option csql-option${n === cursor ? " cursor" : ""}`}
          data-state={row.kind === "instance" ? row.instance.state : undefined}
          onMouseMove={() => setCursor(n)}
          onClick={() => pick(row)}
        >
          <span className="db-check">{value.trim() === name ? "✓" : ""}</span>
          {row.kind === "typed" ? (
            <span className="csql-option-text">
              <span className="csql-option-name mono">{row.name}</span>
              <span className="conn-option-sub">Use this connection name</span>
            </span>
          ) : (
            <span className="csql-option-text">
              <span className="csql-option-name">{row.instance.name}</span>
              <span className="conn-option-sub">
                {row.instance.region} · {row.instance.engine}
              </span>
            </span>
          )}
          {row.kind === "instance" && row.instance.state !== "running" && (
            <span className="csql-option-state">{row.instance.state === "stopped" ? "Stopped" : row.instance.state}</span>
          )}
        </button>
      </li>
    );
  };

  return (
    <div
      ref={rootRef}
      data-testid="nc-field"
      className={`nc-field csql-instance${error ? " invalid" : ""}`}
      data-field="instance"
      data-invalid={error ? "" : undefined}
    >
      <span data-testid="nc-label" className="nc-label">
        Instance *
      </span>
      <button
        type="button"
        data-testid="csql-instance"
        className={`nc-input mono csql-instance-btn${value ? "" : " empty"}`}
        disabled={disabled}
        aria-expanded={open}
        onClick={() => {
          setOpen((v) => !v);
          setCursor(0);
        }}
      >
        <span className="csql-instance-value">{value || "Choose an instance"}</span>
        <ChevronDownIcon size={10} />
      </button>
      {error && (
        <p className="nc-hint csql-error" data-invalid="" data-testid="csql-error">
          {error}
        </p>
      )}
      {open && (
        <div data-testid="csql-popover" className="conn-popover csql-popover" role="dialog" aria-label="Choose an instance">
          <label className="conn-search">
            <SearchIcon size={13} />
            <input
              autoFocus
              value={query}
              placeholder="Filter, or type project:region:instance"
              spellCheck={false}
              data-csql-filter
              onKeyDown={onKeyDown}
              onChange={(e) => {
                setQuery(e.target.value);
                setCursor(0);
              }}
            />
          </label>
          <ul className="conn-list csql-list" role="listbox" ref={listRef}>
            {typed && option(rows[0], 0)}
            {list === undefined && !listError ? (
              <li className="conn-empty">Loading instances…</li>
            ) : listError ? (
              <li className="conn-empty" data-csql-list-error title={listError}>
                Couldn't list instances. Type the connection name instead.
              </li>
            ) : matches.length === 0 && !typed ? (
              <li className="conn-empty">{postgres.length ? "No matches" : "No Postgres instances. Type a connection name instead."}</li>
            ) : (
              projects.map((p) => (
                <li key={p} className="csql-project">
                  <span className="csql-project-name">{p}</span>
                  <ul>{matches.filter((i) => i.project === p).map((i) => option({ kind: "instance", instance: i }, rows.findIndex((r) => r.kind === "instance" && r.instance === i)))}</ul>
                </li>
              ))
            )}
          </ul>
          {list && (others > 0 || list.skipped.length > 0) && (
            <div className="db-foot csql-foot" data-csql-foot>
              {[
                others > 0 ? `${others} MySQL / SQL Server ${others === 1 ? "instance" : "instances"} not shown` : "",
                list.skipped.length > 0 ? `${list.skipped.length} ${list.skipped.length === 1 ? "project" : "projects"} couldn't be listed` : "",
              ]
                .filter(Boolean)
                .join(" · ")}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
