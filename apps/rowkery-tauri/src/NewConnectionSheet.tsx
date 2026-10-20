import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import {
  chooseFile,
  cloudsqlAccount,
  cloudsqlKeyFile,
  type CloudSqlAccount,
  type CloudSqlLogin,
  deleteConnection,
  explainConnectError,
  probeConnection,
  saveConnection,
  type ProbeResult,
} from "./api";
import { defaultSslMode, guessEnvironment } from "./connectionEnv";
import { parsePostgresUrl } from "./connectionUrl";
import { commandTip, keysFor } from "./commands";
import { isMacPlatform } from "./platform";
import { prefetchOn, setPrefetch } from "./prefetchSwitch";
import {
  CONNECTION_ENVS,
  SAFE_MODES,
  formatMs,
  type ConnectionEnv,
  type ConnectionRecord,
  type ConnectionSecrets,
  type SafeMode,
  type SslMode,
  type CloudSqlIpType,
} from "./types";
import { Inspector, InspectorHead } from "./Inspector";
import "./NewConnectionSheet.css";
import { defaultAccess } from "./mcpAccess";
import { mcpShared, sinceLabel, type McpStats } from "./mcpActivity";
import { Keys } from "./Keys";
import { CloudSqlAccountRow, CloudSqlInstanceField, instanceShortName, isConnectionName } from "./CloudSqlFields";

interface NewConnectionSheetProps {
  /** Edit this saved connection instead of creating one. */
  editing?: ConnectionRecord | null;
  onClose: () => void;
  /** Called after the record is saved; the app connects (or reconnects) it. */
  /** `firstShare`: shared with agents here for the first time, no tables picked yet. */
  onSaved: (id: string, name: string, firstShare: boolean) => void;
  /** A failed connection's field to focus, with the reason printed under it. */
  markField?: { field: string; message: string } | null;
  /** Called after `editing` was deleted. */
  onDeleted?: (id: string) => void;
  /**
   * A new connection's starting point: a pasted connection string (⌘V), or
   * fields from a Found on this Mac row. The caret goes to the first blank
   * field.
   */
  prefill?: { url?: string; fields?: Partial<PgForm> } | null;
  /** What agents did with `editing` through MCP (calls today, refused, last read). */
  mcpStats?: McpStats | null;
  /** View activity / See what it can reach. */
  onOpenMcp?: (tab: "activity" | "access" | "connect") => void;
}

type Engine = "postgres" | "sqlite";
type SshAuth = "keyfile" | "password";
type Probe =
  | { state: "idle" }
  | { state: "testing" }
  | ({ state: "done" } & ProbeResult);

export interface PgForm {
  name: string;
  host: string;
  port: string;
  database: string;
  username: string;
  password: string;
  ssl: SslMode;
  sslRootCert: string;
  sshOn: boolean;
  sshHost: string;
  sshPort: string;
  sshUser: string;
  sshAuth: SshAuth;
  sshKeyPath: string;
  sshSecret: string;
  sshTrust: boolean;
  /** Connect to: host and port, or a Cloud SQL instance through the connector. */
  via: "host" | "cloudsql";
  csqlInstance: string;
  csqlIp: CloudSqlIpType;
  csqlCreds: "gcloud" | "key";
  /** The id of a service account key picked in this sheet; the key itself stays in Rust (blank keeps the stored one). */
  csqlKey: string;
}

const EMPTY_PG: PgForm = {
  name: "",
  host: "localhost",
  port: "5432",
  database: "",
  username: "",
  password: "",
  ssl: "prefer",
  sslRootCert: "",
  sshOn: false,
  sshHost: "",
  sshPort: "22",
  sshUser: "",
  sshAuth: "keyfile",
  sshKeyPath: "~/.ssh/id_ed25519",
  sshSecret: "",
  sshTrust: true,
  via: "host",
  csqlInstance: "",
  csqlIp: "public",
  csqlCreds: "gcloud",
  csqlKey: "",
};

const SSL_MODES: { value: SslMode; label: string }[] = [
  { value: "disable", label: "Off" },
  { value: "prefer", label: "Prefer" },
  { value: "require", label: "Require" },
  { value: "verify", label: "Verify" },
];

function newId(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `conn-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function validPort(p: string): boolean {
  const n = Number(p);
  return Number.isInteger(n) && n > 0 && n < 65536;
}

function basename(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] || path;
}

/** Form fields for a saved record. Secrets stay blank: blank keeps the stored ones. */
function pgFormFor(c: ConnectionRecord): PgForm {
  if (c.kind !== "postgres") return EMPTY_PG;
  return {
    ...EMPTY_PG,
    name: c.name,
    host: c.host,
    port: String(c.port),
    database: c.database,
    username: c.username,
    ssl: c.ssl_mode ?? "prefer",
    sslRootCert: c.ssl_root_cert ?? "",
    sshOn: !!c.ssh,
    sshHost: c.ssh?.host ?? "",
    sshPort: String(c.ssh?.port ?? 22),
    sshUser: c.ssh?.username ?? "",
    sshAuth: c.ssh?.auth_method ?? "keyfile",
    sshKeyPath: c.ssh?.private_key_path ?? EMPTY_PG.sshKeyPath,
    sshTrust: c.ssh?.trust_host ?? true,
    via: c.cloud_sql ? "cloudsql" : "host",
    csqlInstance: c.cloud_sql?.instance ?? "",
    csqlIp: c.cloud_sql?.ip_type ?? "public",
    csqlCreds: c.cloud_sql?.credentials ?? "gcloud",
  };
}

function Field({
  label,
  error,
  className,
  name,
  aside,
  children,
}: {
  label: string;
  error?: string;
  /** Dim words at the label's right ("kept in the keychain"). */
  aside?: string;
  className?: string;
  /** For marking from outside (a failed connection's Edit…). */
  name?: string;
  children: ReactNode;
}) {
  return (
    <label data-testid="nc-field" className={`nc-field${error ? " invalid" : ""} ${className ?? ""}`} data-field={name} data-invalid={error ? "" : undefined}>
      <span data-testid="nc-label" className="nc-label">
        {label}
        {error && <span className="nc-error-text">{error}</span>}
        {aside && !error && <span className="nc-label-aside">{aside}</span>}
      </span>
      {children}
    </label>
  );
}

/** A probe's failure mapped to the field it is about (`explain_connect_error`). */
interface ProbeMark {
  field: string | null;
  message: string;
  auth: boolean;
}

/** Auth failures in a row before auto-probing stops until a field changes. */
const AUTH_LOCKOUT = 2;
const PROBE_DELAY_MS = 600;
/** The prototype's words: the environment tags themselves (the title says the full word). */
const ENV_WORDS: { value: ConnectionEnv | null; label: string; title: string }[] = [
  { value: null, label: "None", title: "No environment" },
  ...(["prd", "stg", "dev", "local"] as const).map((value) => ({
    value,
    label: value,
    title: CONNECTION_ENVS.find((e) => e.value === value)?.label ?? value,
  })),
];
const ADVANCED_FIELDS = new Set(["ssl", "sshHost", "sshPort", "sshUser", "sshKeyPath", "sshSecret", "sslRootCert", "ipType"]);

export function NewConnectionSheet({
  editing,
  markField,
  onClose,
  onSaved,
  onDeleted,
  prefill,
  mcpStats,
  onOpenMcp,
}: NewConnectionSheetProps) {
  const [engine, setEngine] = useState<Engine>(editing?.kind ?? "postgres");
  const prefilled = useMemo(
    () => (editing || !prefill ? null : { ...(prefill.url ? parsePostgresUrl(prefill.url) : null), ...prefill.fields }),
    // The sheet's starting point, read once.
    [],
  );
  const [url, setUrl] = useState(() => (prefilled && prefill?.url) || "");
  // A new connection's SSL follows its host (`defaultSslMode`) until picked,
  // or set by a pasted string's sslmode; a saved one keeps its own.
  const [pg, setPg] = useState<PgForm>(() => {
    if (editing) return pgFormFor(editing);
    const form = { ...EMPTY_PG, ...prefilled };
    return prefilled?.ssl ? form : { ...form, ssl: defaultSslMode(form.host) };
  });
  // Host and port start on libpq's defaults, drawn dim until edited.
  const [edited, setEdited] = useState<Set<keyof PgForm>>(
    () => new Set(editing ? ["host", "port"] : (Object.keys(prefilled ?? {}) as (keyof PgForm)[])),
  );
  const [sqlitePath, setSqlitePath] = useState(
    editing?.kind === "sqlite" ? editing.path : "",
  );
  const [sqliteName, setSqliteName] = useState(
    editing?.kind === "sqlite" ? editing.name : "",
  );
  const [probe, setProbe] = useState<Probe>({ state: "idle" });
  const [probeMark, setProbeMark] = useState<ProbeMark | null>(null);
  const [locked, setLocked] = useState(false);
  const [saving, setSaving] = useState(false);
  // Delete… asks first: the foot turns into Keep / Delete until one is picked.
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  // Save on a tuple that failed keeps the sheet once; the next Save keeps it anyway.
  const [blockedTuple, setBlockedTuple] = useState<string | null>(null);
  const [showErrors, setShowErrors] = useState(false);
  // Fields typed in since the sheet opened: auto-probe waits for the first.
  // A pasted connection string counts (unless a failure is marked on it).
  const [dirty, setDirty] = useState(() => !!prefilled && !!prefill?.url && !markField);
  const [advanced, setAdvanced] = useState(
    () =>
      (editing?.kind === "postgres" &&
        (editing.cloud_sql
          ? (editing.cloud_sql.ip_type ?? "public") !== "public"
          : !!editing.ssh || (editing.ssl_mode ?? "prefer") !== "prefer")) ||
      ADVANCED_FIELDS.has(markField?.field ?? ""),
  );
  const [dragging, setDragging] = useState(false);
  // Cloud SQL: the account the connection signs in with, looked up again
  // when the login changes or on Check again.
  const cloud = engine === "postgres" && pg.via === "cloudsql";
  const csqlLogin: CloudSqlLogin = {
    credentials: pg.csqlCreds,
    key: pg.csqlCreds === "key" && pg.csqlKey ? pg.csqlKey : null,
    connectionId: editing?.id ?? null,
  };
  const [csqlAccount, setCsqlAccount] = useState<{ key: string; account?: CloudSqlAccount | null; error?: string } | null>(null);
  const [recheck, setRecheck] = useState(0);
  const csqlLoginKey = JSON.stringify([csqlLogin, recheck]);
  useEffect(() => {
    if (!cloud || csqlAccount?.key === csqlLoginKey) return;
    setCsqlAccount({ key: csqlLoginKey });
    cloudsqlAccount(csqlLogin).then(
      (account) => setCsqlAccount((cur) => (cur?.key === csqlLoginKey ? { key: csqlLoginKey, account } : cur)),
      (e) => setCsqlAccount((cur) => (cur?.key === csqlLoginKey ? { key: csqlLoginKey, error: String(e) } : cur)),
    );
  }, [cloud, csqlLoginKey]);
  const account = csqlAccount?.key === csqlLoginKey ? csqlAccount : null;
  const pickKeyFile = async () => {
    try {
      const picked = await cloudsqlKeyFile();
      if (!picked) return;
      setField("csqlCreds", "key");
      setField("csqlKey", picked.key);
      const loginKey = JSON.stringify([{ ...csqlLogin, credentials: "key", key: picked.key }, recheck]);
      setCsqlAccount({ key: loginKey, account: picked.account });
    } catch (e) {
      setSaveError(String(e));
    }
  };
  // undefined until the user picks one; until then we suggest from the name/host.
  // An edited connection keeps its environment unless changed.
  const [envPicked, setEnvPicked] = useState<ConnectionEnv | null | undefined>(
    editing ? (editing.environment ?? null) : undefined,
  );
  // Off unless the user turns it on; never inferred from the environment.
  const [safeMode, setSafeMode] = useState<SafeMode>(editing?.safe_mode ?? "off");
  // Hover prefetch: off for every connection until turned on here.
  const [prefetch, setPrefetchOn] = useState(() => prefetchOn(editing?.id));
  // Off unless the user turns it on; never inferred from the environment.
  // A share whose time ran out reads as off; saving it on shares until turned off.
  const [allowMcp, setAllowMcp] = useState(() => (editing ? mcpShared(editing) : false));
  // On unless turned off: a 24 h sample of what each agent query returned.
  const [mcpSamples, setMcpSamples] = useState(() => !editing?.mcp_samples_off);
  const mcpKeep = {
    mcp_hidden_tables: editing?.mcp_hidden_tables,
    mcp_access: editing?.mcp_access,
    masked_columns: editing?.masked_columns,
    mcp_until: allowMcp && editing && mcpShared(editing) ? editing.mcp_until : null,
    mcp_samples_off: !mcpSamples,
  };
  // A stale probe must not overwrite the result for newer field values.
  const probeSeq = useRef(0);
  // Tuples probed since the sheet opened (auto-probe never repeats one), with
  // their outcome so Save can reuse it.
  const probed = useRef(new Map<string, boolean>());
  const authFails = useRef(0);
  const mac = isMacPlatform();

  const touch = () => {
    probeSeq.current++;
    setProbe({ state: "idle" });
    setProbeMark(null);
    setSaveError(null);
    setDirty(true);
    // Any change lifts the lockout.
    if (locked) {
      authFails.current = 0;
      setLocked(false);
    }
  };

  /** SSL still follows the host: a new connection, SSL not picked. */
  const sslFollowsHost = !editing && !edited.has("ssl");

  const setField = <K extends keyof PgForm>(key: K, value: PgForm[K]) => {
    // The name isn't part of what a probe connects with.
    if (key !== "name") touch();
    setEdited((prev) => (prev.has(key) ? prev : new Set(prev).add(key)));
    setPg((prev) => {
      const next = { ...prev, [key]: value };
      return key === "host" && sslFollowsHost ? { ...next, ssl: defaultSslMode(next.host) } : next;
    });
  };

  const onUrl = (text: string) => {
    setUrl(text);
    const parsed = parsePostgresUrl(text);
    if (parsed) {
      touch();
      setEdited((prev) => new Set([...prev, ...(Object.keys(parsed) as (keyof PgForm)[])]));
      // Its own sslmode wins; without one, SSL follows its host.
      setPg((prev) => {
        const next = { ...prev, ...parsed };
        return !parsed.ssl && sslFollowsHost ? { ...next, ssl: defaultSslMode(next.host) } : next;
      });
      if (parsed.ssl || parsed.sslRootCert) setAdvanced(true);
    }
  };

  const setPath = (path: string) => {
    touch();
    setSqlitePath(path);
  };

  // A .sqlite / .db dropped on the window while the sheet is open fills the
  // SQLite tab (main.tsx forwards Tauri's drag-drop as `rowkery:file-drag`).
  useEffect(() => {
    if (editing && editing.kind !== "sqlite") return;
    const onDrag = (e: Event) => {
      const { type, paths } = (e as CustomEvent<{ type: string; paths: string[] }>).detail;
      if (type === "enter" || type === "over") setDragging(true);
      else setDragging(false);
      if (type !== "drop") return;
      const file = paths.find((p) => /\.(sqlite3?|db)$/i.test(p)) ?? paths[0];
      if (!file) return;
      setEngine("sqlite");
      setShowErrors(false);
      setPath(file);
    };
    window.addEventListener("rowkery:file-drag", onDrag);
    return () => window.removeEventListener("rowkery:file-drag", onDrag);
  }, [editing, locked]);

  const choose = async (kind: "sqlite" | "pem" | "key") => {
    const path = await chooseFile(kind).catch(() => null);
    if (!path) return;
    if (kind === "sqlite") setPath(path);
    else setField(kind === "pem" ? "sslRootCert" : "sshKeyPath", path);
  };

  const pgName = pg.name.trim() || (cloud ? instanceShortName(pg.csqlInstance) : "") || pg.database.trim() || pg.host.trim();
  const liteName = sqliteName.trim() || basename(sqlitePath.trim());

  const guess =
    engine === "postgres"
      ? cloud
        ? guessEnvironment([pg.name, pg.database, pg.csqlInstance], pg.csqlInstance)
        : guessEnvironment([pg.name, pg.database, pg.host], pg.host)
      : null;
  const env: ConnectionEnv | null = envPicked !== undefined ? envPicked : guess;

  const errors: Record<string, string> = {};
  if (engine === "postgres" && cloud) {
    if (!isConnectionName(pg.csqlInstance)) errors.instance = "Required, as project:region:instance";
    if (!pg.database.trim()) errors.database = "Required";
    if (!pg.username.trim()) errors.username = "Required";
    // Blank keeps the stored key when the saved record already used one.
    const storedKey = editing?.kind === "postgres" && editing.cloud_sql?.credentials === "key";
    if (pg.csqlCreds === "key" && !pg.csqlKey && !storedKey) errors.account = "Choose a key file";
  } else if (engine === "postgres") {
    if (!pg.host.trim()) errors.host = "Required";
    if (!validPort(pg.port)) errors.port = "1–65535";
    if (!pg.database.trim()) errors.database = "Required";
    if (!pg.username.trim()) errors.username = "Required";
    if (pg.sshOn) {
      if (!pg.sshHost.trim()) errors.sshHost = "Required";
      if (!validPort(pg.sshPort)) errors.sshPort = "1–65535";
      if (!pg.sshUser.trim()) errors.sshUser = "Required";
      if (pg.sshAuth === "keyfile" && !pg.sshKeyPath.trim())
        errors.sshKeyPath = "Required";
      // Blank keeps the stored password when the saved record already used one.
      const storedSshPassword =
        editing?.kind === "postgres" && editing.ssh?.auth_method === "password";
      if (pg.sshAuth === "password" && !pg.sshSecret && !storedSshPassword)
        errors.sshSecret = "Required";
    }
  } else if (!sqlitePath.trim()) {
    errors.path = "Required";
  }
  const valid = Object.keys(errors).length === 0;
  const err = (key: string) =>
    (showErrors ? errors[key] : undefined) ??
    (probeMark?.field === key ? probeMark.message : undefined) ??
    (!dirty && markField?.field === key ? markField.message : undefined);
  // Prefilled: the caret goes to the first blank field (usually Password).
  useEffect(() => {
    if (!prefilled || markField) return;
    const blank = (["host", "port", "database", "username", "password"] as const).find((k) => !pg[k]);
    const input = document.querySelector<HTMLInputElement>(`[data-field="${blank ?? "name"}"] input`);
    input?.focus();
    // Once, on open.
  }, []);
  // Opened from a failed connection's Edit…: the field it names gets focus.
  useEffect(() => {
    if (!markField) return;
    const input = document.querySelector<HTMLInputElement>(`[data-field="${markField.field}"] input`);
    input?.focus();
    input?.select();
  }, [markField]);

  // Shared here for the first time: the own database, no tables until
  // ticked on the Agents page (a connection shared before keeps its access).
  const isFirstShare = (rec: ConnectionRecord) => !!rec.allow_mcp && !rec.mcp_access && !editing?.allow_mcp;
  const build = (id: string): [ConnectionRecord, ConnectionSecrets, boolean] => {
    const [rec, secrets] = buildRaw(id);
    const first = isFirstShare(rec);
    return [first ? { ...rec, mcp_access: defaultAccess(rec) } : rec, secrets, first];
  };
  const buildRaw = (id: string): [ConnectionRecord, ConnectionSecrets] => {
    if (engine === "sqlite") {
      return [
        {
          kind: "sqlite",
          id,
          name: liteName,
          path: sqlitePath.trim(),
          environment: env,
          safe_mode: safeMode,
          allow_mcp: allowMcp,
          ...mcpKeep,
        },
        {},
      ];
    }
    if (cloud) {
      return [
        {
          kind: "postgres",
          id,
          name: pgName,
          // Names the instance on screen; the connector finds its address.
          host: pg.csqlInstance.trim(),
          port: 5432,
          database: pg.database.trim(),
          username: pg.username.trim(),
          ssl_mode: pg.ssl,
          ssl_root_cert: null,
          ssh: null,
          cloud_sql: { instance: pg.csqlInstance.trim(), ip_type: pg.csqlIp, credentials: pg.csqlCreds },
          environment: env,
          safe_mode: safeMode,
          allow_mcp: allowMcp,
          ...mcpKeep,
        },
        {
          db_password: pg.password || null,
          gcp_key: pg.csqlCreds === "key" && pg.csqlKey ? pg.csqlKey : null,
        },
      ];
    }
    const ssh = pg.sshOn
      ? {
          host: pg.sshHost.trim(),
          port: Number(pg.sshPort),
          username: pg.sshUser.trim(),
          auth_method: pg.sshAuth,
          private_key_path:
            pg.sshAuth === "keyfile" ? pg.sshKeyPath.trim() : null,
          trust_host: pg.sshTrust,
        }
      : null;
    return [
      {
        kind: "postgres",
        id,
        name: pgName,
        host: pg.host.trim(),
        port: Number(pg.port),
        database: pg.database.trim(),
        username: pg.username.trim(),
        ssl_mode: pg.ssl,
        ssl_root_cert: pg.ssl === "verify" && pg.sslRootCert.trim() ? pg.sslRootCert.trim() : null,
        ssh,
        environment: env,
        safe_mode: safeMode,
        allow_mcp: allowMcp,
        ...mcpKeep,
      },
      {
        db_password: pg.password || null,
        ssh_password:
          pg.sshOn && pg.sshAuth === "password" && pg.sshSecret ? pg.sshSecret : null,
        ssh_key_passphrase:
          pg.sshOn && pg.sshAuth === "keyfile" && pg.sshSecret ? pg.sshSecret : null,
      },
    ];
  };

  // What a probe connects with; name, environment and safe mode aren't part of it.
  const tuple = (() => {
    const [record, secrets] = build("t");
    const { name: _n, environment: _e, safe_mode: _s, ...where } = record;
    return JSON.stringify([where, secrets]);
  })();

  /** Probes the form as it is; resolves to whether it connected (null if superseded). */
  const runProbe = async (): Promise<boolean | null> => {
    const seq = ++probeSeq.current;
    const key = tuple;
    setProbe({ state: "testing" });
    setProbeMark(null);
    let res: ProbeResult;
    try {
      // An edited record probes under its own id, so blank secrets fall back
      // to the stored ones.
      const [record, secrets] = build(editing?.id ?? "probe");
      res = await probeConnection(record, secrets);
    } catch (e) {
      res = { ok: false, message: String(e), elapsed_ms: 0 };
    }
    if (seq !== probeSeq.current) return null;
    probed.current.set(key, res.ok);
    let mark: ProbeMark | null = null;
    if (!res.ok) {
      const x =
        engine === "postgres"
          ? await explainConnectError(res.message, {
              host: pg.host.trim(),
              port: Number(pg.port),
              username: pg.username.trim(),
              sshHost: pg.sshOn && !cloud ? pg.sshHost.trim() : null,
              cloudSql: cloud ? pg.csqlInstance.trim() : null,
            }).catch(() => null)
          : null;
      if (seq !== probeSeq.current) return null;
      const auth = x?.class === "auth" || x?.class === "role" || x?.class === "ssh_auth";
      mark = {
        field: x?.field === "sshPassword" ? "sshSecret" : (x?.field ?? (engine === "sqlite" ? "path" : null)),
        message: x?.cause ?? res.message,
        auth,
      };
      if (mark.field && ADVANCED_FIELDS.has(mark.field)) setAdvanced(true);
      authFails.current = auth ? authFails.current + 1 : 0;
      if (authFails.current >= AUTH_LOCKOUT) setLocked(true);
    } else {
      authFails.current = 0;
    }
    setProbeMark(mark);
    setProbe({ state: "done", ...res });
    return res.ok;
  };

  // Auto-probe: 600 ms after the last edit, once the form could connect, for
  // a tuple not probed yet, unless two logins in a row were refused.
  useEffect(() => {
    if (!dirty || !valid || locked || probed.current.has(tuple)) return;
    const t = window.setTimeout(() => void runProbe(), PROBE_DELAY_MS);
    return () => window.clearTimeout(t);
  }, [dirty, valid, locked, tuple]);

  // Test ⌘T always probes: no dedupe, no lockout.
  const onTest = async () => {
    setShowErrors(true);
    if (!valid || probe.state === "testing") return;
    await runProbe();
  };

  const onSave = async () => {
    setShowErrors(true);
    if (!valid || saving) return;
    // The sheet never closes on a failure: Save probes (again) a tuple it
    // hasn't seen connect, and a failed one keeps the sheet open with the field
    // marked. Saving the same failed tuple again keeps it anyway (a server
    // only reachable from elsewhere).
    if (blockedTuple !== tuple && probed.current.get(tuple) !== true) {
      const ok = await runProbe();
      if (ok === null) return;
      if (!ok) {
        setBlockedTuple(tuple);
        return;
      }
    }
    setSaving(true);
    setSaveError(null);
    try {
      const id = editing?.id ?? newId();
      const [record, secrets, firstShare] = build(id);
      await saveConnection(record, secrets);
      if (record.kind === "postgres") setPrefetch(id, prefetch);
      onSaved(id, record.name, firstShare);
    } catch (e) {
      setSaveError(String(e));
      setSaving(false);
    }
  };

  const onDelete = async () => {
    if (!editing || saving) return;
    setSaving(true);
    try {
      // Asked first in the foot; the toast still offers Undo, so the
      // keychain entries stay until it is gone.
      await deleteConnection(editing.id, true);
      onDeleted?.(editing.id);
    } catch (e) {
      setSaveError(String(e));
      setSaving(false);
    }
  };

  const onKeyDown = (e: KeyboardEvent) => {
    const modKey = isMacPlatform() ? e.metaKey : e.ctrlKey;
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      // Esc backs out of the delete question before it closes the sheet.
      if (confirmDelete) setConfirmDelete(false);
      else onClose();
    } else if (e.key === "Enter" && modKey && !confirmDelete) {
      // connection-save's chord (commands.ts). Test has none: ⌘T is New window.
      e.preventDefault();
      void onSave();
    }
  };

  const failedHere = probe.state === "done" && !probe.ok;
  const probeLine = (
    <div
      className="nc-probe"
      data-probe={saveError ? "error" : locked ? "locked" : probe.state === "testing" ? "testing" : probe.state === "done" ? (probe.ok ? "ok" : "error") : "idle"}
      aria-live="polite"
    >
      {saveError ? (
        <span className="nc-status error" title={saveError}>
          <span className="conn-dot error" />
          {saveError}
        </span>
      ) : probe.state === "testing" ? (
        <span className="nc-status">
          <span className="conn-dot connecting" />
          Connecting…
        </span>
      ) : locked ? (
        <span className="nc-status">
          <span className="conn-dot idle" />
          Stopped trying after two failed logins · change a field or Test
        </span>
      ) : probe.state === "idle" ? (
        <span className="nc-status idle">
          <span className="conn-dot idle" />
          {engine === "sqlite" ? "Type or drop a file" : cloud ? "Probes once Instance, Database and User are set" : "Probes once Host, Database and User are set"}
        </span>
      ) : probe.state === "done" ? (
        probe.ok ? (
          <span className="nc-status ok">
            <span className="conn-dot connected" />
            {engine === "sqlite" ? "Opened" : "Connected"} in {formatMs(probe.elapsed_ms)} · {probe.message}
          </span>
        ) : (
          <span className="nc-status error" title={probe.message}>
            <span className="conn-dot error" />
            Couldn't connect{probeMark?.field ? "" : ` · ${probeMark?.message ?? probe.message}`}
          </span>
        )
      ) : null}
    </div>
  );

  const labels = (
    <section className="nc-section" data-section="labels">
      <div className="nc-row">
        <span data-testid="nc-label" className="nc-label">
          Environment
          <span className="nc-suggested" data-suggested={envPicked === undefined && guess ? "" : undefined}>
            {envPicked === undefined && guess ? "suggested" : ""}
          </span>
        </span>
        <div data-testid="nc-env" className="nc-segment wide nc-env" role="radiogroup" aria-label="Environment">
          {ENV_WORDS.map((e) => (
            <button
              key={e.value ?? "none"}
              type="button"
              role="radio"
              data-env-choice={e.value ?? "none"}
              aria-checked={env === e.value}
              aria-selected={env === e.value}
              title={e.title}
              className={e.value ? `env-${e.value}` : undefined}
              onClick={() => setEnvPicked(e.value)}
            >
              {e.value && <span className="nc-env-dot" />}
              {e.label}
            </button>
          ))}
        </div>
      </div>
      <div className="nc-row">
        <span data-testid="nc-label" className="nc-label">Safe mode</span>
        <div className="nc-segment wide nc-safe" role="radiogroup" aria-label="Safe mode">
          {SAFE_MODES.map((m) => (
            <button
              key={m.value}
              type="button"
              role="radio"
              data-safe-choice={m.value}
              aria-checked={safeMode === m.value}
              aria-selected={safeMode === m.value}
              onClick={() => {
                setSafeMode(m.value);
                setSaveError(null);
              }}
            >
              {m.label}
            </button>
          ))}
        </div>
      </div>
      <div className="nc-group nc-mcp">
        <label className="nc-toggle-row nc-mcp-row">
          <span className="nc-toggle-text">
            <span className="nc-toggle-label">Share with agents (MCP)</span>
            <span className="nc-toggle-sub">read-only · setup command after save</span>
          </span>
          <input
            type="checkbox"
            className="nc-switch"
            role="switch"
            data-mcp-switch
            checked={allowMcp}
            onChange={(e) => {
              setAllowMcp(e.target.checked);
              setSaveError(null);
            }}
          />
        </label>
        {allowMcp && (
          <label className="nc-toggle-row">
            <span className="nc-toggle-text">
              <span className="nc-toggle-label">Keep result samples</span>
              <span className="nc-toggle-sub">first 5 rows of each query, on this Mac, 24 h</span>
            </span>
            <input
              type="checkbox"
              className="nc-switch"
              role="switch"
              data-mcp-samples-switch
              checked={mcpSamples}
              onChange={(e) => {
                setMcpSamples(e.target.checked);
                setSaveError(null);
              }}
            />
          </label>
        )}
        {editing && mcpStats && onOpenMcp && (allowMcp || mcpStats.last !== null) && (
          <div data-testid="nc-mcp-stats" className="nc-mcp-stats">
            <span>
              <b>{mcpStats.today.toLocaleString()}</b> {mcpStats.today === 1 ? "call" : "calls"} today
            </span>
            {mcpStats.refused > 0 && (
              <span>
                <b>{mcpStats.refused.toLocaleString()}</b> refused
              </span>
            )}
            <span>
              Last read <b>{mcpStats.last === null ? "never" : sinceLabel(mcpStats.last)}</b>
            </span>
            <span className="nc-mcp-acts">
            <button type="button" className="mcp-btn" data-nc-mcp="activity" onClick={() => onOpenMcp("activity")}>
              View activity
            </button>
            <button type="button" className="mcp-btn" data-nc-mcp="access" onClick={() => onOpenMcp("access")}>
              What it can reach
            </button>
            </span>
          </div>
        )}
      </div>
      {allowMcp && onOpenMcp && (
        <div className="nc-mcp-connect">
          <button type="button" className="mcp-btn" data-nc-mcp="connect" onClick={() => onOpenMcp("connect")}>
            Connect Claude Code or Claude Desktop
          </button>
        </div>
      )}
    </section>
  );


  return (
    // The inspector column at the window's right (Paper, 2026-10-10; it
    // was a modal sheet): the window stays in view and usable beside it.
    <div data-testid="nc-overlay" className="nc-overlay">
      <Inspector
        kind="connect"
        data-testid="nc-sheet"
        className="nc-sheet"
        role="dialog"
        aria-label={editing ? "Edit connection" : "New connection"}
        data-engine={engine}
        onKeyDown={onKeyDown}
      >
        <InspectorHead
          onClose={onClose}
          tools={
          /* A saved record keeps its engine. */
          !editing && (
            <div className="nc-segment nc-engine" role="tablist" aria-label="Engine">
              {(["postgres", "sqlite"] as const).map((k) => (
                <button
                  key={k}
                  type="button"
                  role="tab"
                  data-engine-tab={k}
                  aria-selected={engine === k}
                  onClick={() => {
                    touch();
                    setDirty(false);
                    setShowErrors(false);
                    setEngine(k);
                  }}
                >
                  {k === "postgres" ? "Postgres" : "SQLite"}
                </button>
              ))}
            </div>
          )
          }
        >
          <h2 data-testid="nc-title" className="insp-title nc-title">
            {editing ? "Edit connection" : "New connection"}
          </h2>
        </InspectorHead>

        <form
          className="nc-body"
          onSubmit={(e) => {
            e.preventDefault();
            void onSave();
          }}
        >
          {engine === "postgres" ? (
            <>
              <div className="nc-row" data-field="via">
                <span data-testid="nc-label" className="nc-label">Connect to</span>
                <div className="nc-segment wide" role="radiogroup" aria-label="Connect to">
                  {(["host", "cloudsql"] as const).map((v) => (
                    <button
                      key={v}
                      type="button"
                      role="radio"
                      data-via-choice={v}
                      aria-checked={pg.via === v}
                      aria-selected={pg.via === v}
                      onClick={() => pg.via !== v && setField("via", v)}
                    >
                      {v === "host" ? "Host and port" : "Google Cloud SQL"}
                    </button>
                  ))}
                </div>
              </div>
              {!cloud && (
              <Field label="Paste a connection URL" name="url">
                <input
                  autoFocus={!editing}
                  data-testid="nc-input"
                  className="nc-input mono"
                  value={url}
                  placeholder="postgres://user:password@host:5432/database"
                  spellCheck={false}
                  autoComplete="off"
                  onChange={(e) => onUrl(e.target.value)}
                />
              </Field>
              )}

              <section className="nc-section" data-section="identity">
                <Field label="Name" name="name">
                  <input
                    autoFocus={!!editing && !markField}
                    data-testid="nc-input"
                    className="nc-input"
                    value={pg.name}
                    placeholder={cloud ? instanceShortName(pg.csqlInstance) || "My database" : pg.database.trim() || pg.host.trim() || "My database"}
                    spellCheck={false}
                    onChange={(e) => setField("name", e.target.value)}
                  />
                </Field>
                {cloud ? (
                  <>
                    <CloudSqlAccountRow
                      account={account?.account}
                      credentials={pg.csqlCreds}
                      error={account?.error ?? err("account")}
                      onUseKey={() => void pickKeyFile()}
                      onUseGcloud={() => {
                        setField("csqlCreds", "gcloud");
                        setField("csqlKey", "");
                      }}
                      onRecheck={() => setRecheck((n) => n + 1)}
                    />
                    <CloudSqlInstanceField
                      value={pg.csqlInstance}
                      login={csqlLogin}
                      error={err("instance")}
                      onPick={(name) => setField("csqlInstance", name)}
                    />
                  </>
                ) : (
                <div className="nc-grid cols-4">
                  <Field label="Host" name="host" error={err("host")} className="span-3">
                    <input
                      data-testid="nc-input"
                      className={`nc-input mono${edited.has("host") ? "" : " nc-default"}`}
                      value={pg.host}
                      spellCheck={false}
                      autoComplete="off"
                      onChange={(e) => setField("host", e.target.value)}
                    />
                  </Field>
                  <Field label="Port" name="port" error={err("port")}>
                    <input
                      data-testid="nc-input"
                      className={`nc-input mono${edited.has("port") ? "" : " nc-default"}`}
                      value={pg.port}
                      inputMode="numeric"
                      onChange={(e) => setField("port", e.target.value.replace(/\D/g, ""))}
                    />
                  </Field>
                </div>
                )}
                <div className="nc-grid cols-2">
                  <Field label="Database *" name="database" error={err("database")}>
                    <input
                      data-testid="nc-input"
                      className="nc-input mono"
                      value={pg.database}
                      spellCheck={false}
                      autoComplete="off"
                      aria-required
                      onChange={(e) => setField("database", e.target.value)}
                    />
                  </Field>
                  <Field label="User *" name="username" error={err("username")}>
                    <input
                      data-testid="nc-input"
                      className="nc-input mono"
                      value={pg.username}
                      spellCheck={false}
                      autoComplete="off"
                      aria-required
                      onChange={(e) => setField("username", e.target.value)}
                    />
                  </Field>
                </div>
                <Field label="Password" name="password" error={err("password")} aside="kept in the keychain">
                  <input
                    data-testid="nc-input"
                    className="nc-input mono"
                    type="password"
                    value={pg.password}
                    placeholder={editing ? "Unchanged" : undefined}
                    autoComplete="new-password"
                    onChange={(e) => setField("password", e.target.value)}
                  />
                </Field>
                {probeLine}
              </section>

              <section className="nc-section nc-advanced" data-section="advanced" data-open={advanced ? "" : undefined}>
                <button
                  type="button"
                  data-testid="nc-disclosure"
                  className="nc-disclosure"
                  aria-expanded={advanced}
                  onClick={() => setAdvanced((v) => !v)}
                >
                  <span className="nc-caret" aria-hidden>
                    ▸
                  </span>
                  Advanced
                </button>
                {advanced && (
                  <div data-testid="nc-advanced-body" className="nc-advanced-body">
                    {cloud ? (
                      <>
                        <div className={`nc-row${err("ipType") ? " invalid" : ""}`} data-field="ipType" data-invalid={err("ipType") ? "" : undefined}>
                          <span data-testid="nc-label" className="nc-label">IP</span>
                          <div className="nc-segment wide" role="radiogroup" aria-label="IP">
                            {([["public", "Public"], ["private", "Private"], ["psc", "PSC"]] as const).map(([v, l]) => (
                              <button key={v} type="button" role="radio" data-ip-choice={v} aria-checked={pg.csqlIp === v} aria-selected={pg.csqlIp === v} onClick={() => setField("csqlIp", v)}>
                                {l}
                              </button>
                            ))}
                          </div>
                        </div>
                        {err("ipType") && (
                          <p className="nc-hint indent" data-invalid="" data-testid="csql-ip-error">
                            {err("ipType")}
                          </p>
                        )}
                        <div className="nc-row" data-field="ssl">
                          <span data-testid="nc-label" className="nc-label">SSL</span>
                          <span className="csql-fixed">Always on · server checked against the instance's CA</span>
                        </div>
                      </>
                    ) : (<>
                    <div className="nc-row" data-field="ssl">
                      <span data-testid="nc-label" className="nc-label">SSL</span>
                      <div className="nc-segment wide" role="radiogroup" aria-label="SSL mode">
                        {SSL_MODES.map((m) => (
                          <button
                            key={m.value}
                            type="button"
                            role="radio"
                            data-ssl-choice={m.value}
                            aria-checked={pg.ssl === m.value}
                            aria-selected={pg.ssl === m.value}
                            onClick={() => setField("ssl", m.value)}
                          >
                            {m.label}
                          </button>
                        ))}
                      </div>
                    </div>
                    {err("ssl") ? (
                      <p className="nc-hint indent" data-invalid="" data-testid="nc-ssl-error">
                        {err("ssl")}
                      </p>
                    ) : (
                      <p className="nc-hint indent">
                        Prefer and Require don't check the server's certificate. Verify does.
                      </p>
                    )}
                    {pg.ssl === "verify" && (
                      <Field label="CA certificate" name="sslRootCert" error={err("sslRootCert")}>
                        <span className="nc-input-row">
                          <input
                            data-testid="nc-input"
                            className="nc-input mono"
                            value={pg.sslRootCert}
                            placeholder="System trust store"
                            spellCheck={false}
                            autoComplete="off"
                            onChange={(e) => setField("sslRootCert", e.target.value)}
                          />
                          <button type="button" className="nc-btn" onClick={() => void choose("pem")}>
                            Choose…
                          </button>
                        </span>
                      </Field>
                    )}

                    <div className="nc-group">
                      <label className="nc-toggle-row">
                        <span className="nc-toggle-label">SSH tunnel</span>
                        {pg.sshOn && pg.sshHost && (
                          <span className="nc-toggle-meta">
                            {pg.sshUser || "user"}@{pg.sshHost}
                          </span>
                        )}
                        <input
                          type="checkbox"
                          className="nc-switch"
                          role="switch"
                          data-ssh-switch
                          checked={pg.sshOn}
                          onChange={(e) => setField("sshOn", e.target.checked)}
                        />
                      </label>
                      {pg.sshOn && (
                        <div className="nc-group-body">
                          <div className="nc-grid cols-4">
                            <Field label="Host" name="sshHost" error={err("sshHost")} className="span-2">
                              <input
                                data-testid="nc-input"
                                className="nc-input mono"
                                value={pg.sshHost}
                                placeholder="bastion.example.com"
                                spellCheck={false}
                                onChange={(e) => setField("sshHost", e.target.value)}
                              />
                            </Field>
                            <Field label="Port" name="sshPort" error={err("sshPort")}>
                              <input
                                data-testid="nc-input"
                                className="nc-input mono"
                                value={pg.sshPort}
                                inputMode="numeric"
                                onChange={(e) =>
                                  setField("sshPort", e.target.value.replace(/\D/g, ""))
                                }
                              />
                            </Field>
                            <Field label="User" name="sshUser" error={err("sshUser")}>
                              <input
                                data-testid="nc-input"
                                className="nc-input mono"
                                value={pg.sshUser}
                                spellCheck={false}
                                onChange={(e) => setField("sshUser", e.target.value)}
                              />
                            </Field>
                          </div>
                          <div className="nc-grid cols-4">
                            <div data-testid="nc-field" className="nc-field">
                              <span data-testid="nc-label" className="nc-label">Auth</span>
                              <div className="nc-segment wide" role="radiogroup" aria-label="SSH auth">
                                {(["keyfile", "password"] as const).map((a) => (
                                  <button
                                    key={a}
                                    type="button"
                                    role="radio"
                                    aria-checked={pg.sshAuth === a}
                                    aria-selected={pg.sshAuth === a}
                                    onClick={() => setField("sshAuth", a)}
                                  >
                                    {a === "keyfile" ? "Key file" : "Password"}
                                  </button>
                                ))}
                              </div>
                            </div>
                            {pg.sshAuth === "keyfile" ? (
                              <>
                                <Field label="Key file" name="sshKeyPath" error={err("sshKeyPath")} className="span-2">
                                  <span className="nc-input-row">
                                    <input
                                      data-testid="nc-input"
                                      className="nc-input mono"
                                      value={pg.sshKeyPath}
                                      spellCheck={false}
                                      onChange={(e) => setField("sshKeyPath", e.target.value)}
                                    />
                                    <button type="button" className="nc-btn" onClick={() => void choose("key")}>
                                      Choose…
                                    </button>
                                  </span>
                                </Field>
                                <Field label="Passphrase" name="sshSecret" error={err("sshSecret")}>
                                  <input
                                    data-testid="nc-input"
                                    className="nc-input"
                                    type="password"
                                    value={pg.sshSecret}
                                    placeholder={editing ? "Unchanged" : "Optional"}
                                    autoComplete="new-password"
                                    onChange={(e) => setField("sshSecret", e.target.value)}
                                  />
                                </Field>
                              </>
                            ) : (
                              <Field label="SSH password" name="sshSecret" error={err("sshSecret")} className="span-3">
                                <input
                                  data-testid="nc-input"
                                  className="nc-input"
                                  type="password"
                                  value={pg.sshSecret}
                                  placeholder={editing ? "Unchanged" : undefined}
                                  autoComplete="new-password"
                                  onChange={(e) => setField("sshSecret", e.target.value)}
                                />
                              </Field>
                            )}
                          </div>
                          <label className="nc-check">
                            <input
                              type="checkbox"
                              checked={pg.sshTrust}
                              onChange={(e) => setField("sshTrust", e.target.checked)}
                            />
                            Trust the host key on first connect
                          </label>
                        </div>
                      )}
                    </div>
                    </>)}

                    <div className="nc-group">
                      <label className="nc-toggle-row">
                        <span className="nc-toggle-label">Prefetch on hover</span>
                        <input
                          type="checkbox"
                          className="nc-switch"
                          role="switch"
                          data-prefetch-switch
                          checked={prefetch}
                          onChange={(e) => setPrefetchOn(e.target.checked)}
                        />
                      </label>
                    </div>
                    <p className="nc-hint indent">
                      Reads a table's first 200 rows while the pointer rests on it, so a click shows them at once.
                    </p>
                  </div>
                )}
              </section>
              {labels}
            </>
          ) : (
            <>
              <section className="nc-section" data-section="identity">
                <Field label="File" name="path" error={err("path")}>
                  <span className="nc-input-row">
                    <input
                      autoFocus
                      data-testid="nc-input"
                      className="nc-input mono"
                      value={sqlitePath}
                      placeholder="~/Data/analytics.sqlite"
                      spellCheck={false}
                      autoComplete="off"
                      onChange={(e) => setPath(e.target.value)}
                    />
                    <button type="button" className="nc-btn" data-choose-file onClick={() => void choose("sqlite")}>
                      Choose file…
                    </button>
                  </span>
                </Field>
                <div className="nc-drop" data-drop-zone data-dragging={dragging ? "" : undefined}>
                  Drop a .sqlite or .db file here
                </div>
                <Field label="Name" name="name">
                  <input
                    data-testid="nc-input"
                    className="nc-input"
                    value={sqliteName}
                    placeholder={basename(sqlitePath.trim()) || "My database"}
                    spellCheck={false}
                    onChange={(e) => setSqliteName(e.target.value)}
                  />
                </Field>
                {probeLine}
              </section>
              {labels}
            </>
          )}
          {/* Lets Enter in any field submit. */}
          <button type="submit" hidden />
        </form>

        {confirmDelete && editing ? (
          <div className="insp-foot nc-foot" data-delete-confirm>
            <span className="nc-delete-ask">Delete {editing.name}?</span>
            <span className="insp-gap" />
            <button type="button" className="insp-btn ghost" autoFocus data-delete-keep disabled={saving} onClick={() => setConfirmDelete(false)}>
              Keep
            </button>
            <button type="button" className="insp-btn nc-delete-go" data-delete-go disabled={saving} onClick={() => void onDelete()}>
              Delete
            </button>
          </div>
        ) : (
        <div className="insp-foot nc-foot">
          {editing && (
            <button
              type="button"
              className="insp-btn ghost nc-delete"
              data-delete
              disabled={saving}
              onClick={() => setConfirmDelete(true)}
            >
              Delete…
            </button>
          )}
          <button
            type="button"
            className="insp-btn"
            data-test-connection
            title={commandTip("connection-test", undefined, mac)}
            disabled={probe.state === "testing"}
            onClick={() => void onTest()}
          >
            Test
          </button>
          <span className="insp-gap" />
          <button type="button" className="insp-btn ghost" data-cancel onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="insp-btn ink nc-save"
            data-save
            // Dim until the form can connect (Host, Database, User; the Name falls back to them).
            data-ready={valid ? "" : undefined}
            data-save-anyway={failedHere && blockedTuple === tuple ? "" : undefined}
            title={commandTip("connection-save", editing ? "Save" : "Save and connect", mac)}
            disabled={saving}
            onClick={() => void onSave()}
          >
            {saving
              ? "Saving…"
              : failedHere && blockedTuple === tuple
                ? "Save anyway"
                : editing
                  ? "Save"
                  : "Save and connect"}{" "}
            <kbd><Keys text={keysFor("connection-save", mac)} /></kbd>
          </button>
        </div>
        )}
      </Inspector>
    </div>
  );
}
