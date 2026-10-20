import { useEffect, useMemo, useState } from "react";
import { allTables, tableKey, type SidebarSchema, type SidebarTable } from "./schemaTree";
import type { ForeignKeyNode, TableIndexes } from "./types";
import { formatBytes } from "./types";
import { firstLine } from "./comments";
import { ArrowInIcon, ArrowOutIcon, IndexIcon } from "./icons";
import "./TableStructure.css";

interface TableStructureProps {
  table: SidebarTable;
  /** Whole catalog, for "Referenced by". */
  schemas: SidebarSchema[];
  onOpenTable: (key: string) => void;
  /** Index details the catalog left out (Postgres loads them per table). */
  loadIndexes: (schema: string, tables: string[]) => Promise<TableIndexes[]>;
}

interface Incoming {
  from: SidebarTable;
  fk: ForeignKeyNode;
}

function sum(values: (number | null | undefined)[]): number | null {
  const known = values.filter((v): v is number => typeof v === "number");
  return known.length ? known.reduce((a, b) => a + b, 0) : null;
}

function cols(list: string[]): string {
  return `(${list.join(", ")})`;
}

/** SQLite leaves the target column blank when it is the parent's primary key. */
function refCols(
  fk: ForeignKeyNode,
  target: SidebarTable | undefined,
): string[] {
  if (fk.ref_columns.every((c) => c)) return fk.ref_columns;
  return target?.table.primary_key?.length ? target.table.primary_key : [];
}

/** Postgres spells some types long-hand; show the names people type. */
function shortType(type: string): string {
  return type
    .replace(/^timestamp(\(\d+\))? with time zone/, "timestamptz$1")
    .replace(/^timestamp(\(\d+\))? without time zone/, "timestamp$1")
    .replace(/^time(\(\d+\))? with time zone/, "timetz$1")
    .replace(/^time(\(\d+\))? without time zone/, "time$1")
    .replace(/^character varying/, "varchar")
    .replace(/^character\b/, "char");
}

function onDeleteLabel(action: string): string | null {
  return action && action !== "NO ACTION"
    ? `on delete ${action.toLowerCase()}`
    : null;
}

export function TableStructure({
  table,
  schemas,
  onOpenTable,
  loadIndexes,
}: TableStructureProps) {
  const node = table.table;
  const columns = node.columns ?? [];
  const pk = node.primary_key ?? [];
  const fks = node.foreign_keys ?? [];

  // Postgres catalogs defer index details: fetch this table's (and its
  // partitions', for their sizes) when Structure opens.
  const deferred = node.indexes_deferred || table.partitions.some((p) => p.table.indexes_deferred);
  const [loaded, setLoaded] = useState<Map<string, TableIndexes> | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  useEffect(() => {
    if (!deferred) return;
    let live = true;
    loadIndexes(table.schema, [table.name, ...table.partitions.map((p) => p.name)])
      .then((list) => live && setLoaded(new Map(list.map((t) => [t.table, t]))))
      .catch((e) => live && setLoadError(String(e)));
    return () => {
      live = false;
    };
  }, [deferred, loadIndexes, table.schema, table.name, table.partitions]);
  const loadingIndexes = deferred && !loaded && !loadError;
  const ownIndexes = deferred ? loaded?.get(table.name)?.indexes : node.indexes;
  const bytesOf = (t: SidebarTable) =>
    t.table.indexes_deferred ? loaded?.get(t.name)?.index_bytes : t.table.index_bytes;

  const indexes = useMemo(
    () =>
      [...(ownIndexes ?? [])].sort(
        (a, b) =>
          Number(b.primary ?? false) - Number(a.primary ?? false) ||
          a.name.localeCompare(b.name),
      ),
    [ownIndexes],
  );

  const byKey = useMemo(() => {
    const map = new Map<string, SidebarTable>();
    for (const t of allTables(schemas)) map.set(t.key, t);
    return map;
  }, [schemas]);

  const incoming = useMemo(() => {
    const out: Incoming[] = [];
    for (const t of allTables(schemas)) {
      for (const fk of t.table.foreign_keys ?? []) {
        if (fk.ref_schema === table.schema && fk.ref_table === table.name) {
          out.push({ from: t, fk });
        }
      }
    }
    return out;
  }, [schemas, table.schema, table.name]);

  // A partitioned parent owns no storage; its size is its partitions'.
  const isParent = table.partitions.length > 0;
  const dataBytes = isParent
    ? sum(table.partitions.map((p) => p.table.table_bytes))
    : (node.table_bytes ?? null);
  const indexBytes = isParent
    ? sum(table.partitions.map(bytesOf))
    : (bytesOf(table) ?? null);

  // SQLite has no access method, sizes or scan counts; drop those columns.
  const richIndexes = indexes.some((i) => i.method);

  const tableLink = (schema: string, name: string, columnList: string[]) => {
    const key = tableKey(table.database, schema, name);
    const exists = byKey.has(key);
    const label = `${schema}.${name}${columnList.length ? cols(columnList) : ""}`;
    return exists ? (
      <button
        type="button"
        className="ts-link"
        onClick={() => onOpenTable(key)}
      >
        {label}
      </button>
    ) : (
      <span className="ts-link-missing">{label}</span>
    );
  };

  const isPlainView = node.kind === "view";
  const viewKind =
    node.kind === "view"
      ? "View"
      : node.kind === "materialized_view"
        ? "Materialized view"
        : null;

  let stats: { label: string; value: string }[] = [
    {
      label: "Rows",
      value: table.rows === null ? "—" : `≈ ${table.rows.toLocaleString()}`,
    },
    { label: "Data", value: dataBytes === null ? "—" : formatBytes(dataBytes) },
    {
      label: "Indexes",
      value: loadingIndexes ? "…" : indexBytes === null ? "—" : formatBytes(indexBytes),
    },
    { label: "Columns", value: String(columns.length) },
  ];
  if (isParent) {
    stats.push({ label: "Partitions", value: String(table.partitions.length) });
  }
  // A plain view has no rows estimate or storage; skip the empty tiles.
  if (viewKind) stats = stats.filter((st) => st.value !== "—");

  return (
    <div data-testid="ts-root" className="ts-root">
      <header className="ts-header">
        <h1 className="ts-title">
          <span className="ts-title-schema">{table.schema}.</span>
          {table.name}
        </h1>
        {firstLine(node.comment) && (
          <p className="ts-comment" data-table-comment title={node.comment ?? undefined}>
            {firstLine(node.comment)}
          </p>
        )}
        {viewKind && <div data-testid="ts-partition-of" className="ts-partition-of">{viewKind}</div>}
        {node.partition_of && (
          <div data-testid="ts-partition-of" className="ts-partition-of">
            Partition of{" "}
            <button
              type="button"
              className="ts-link"
              onClick={() =>
                onOpenTable(
                  tableKey(table.database, table.schema, node.partition_of!),
                )
              }
            >
              {node.partition_of}
            </button>
          </div>
        )}
      </header>

      <div className="ts-stats">
        {stats.map((st) => (
          <div className="ts-stat" key={st.label}>
            <span data-testid="ts-stat-label" className="ts-stat-label">{st.label}</span>
            <span className="ts-stat-value">{st.value}</span>
          </div>
        ))}
      </div>

      <section data-testid="ts-card" className="ts-card ts-columns" aria-label="Columns">
        {columns.length === 0 ? (
          <div className="ts-empty">No columns</div>
        ) : (
          <div className="ts-table" role="table">
            <div className="ts-row ts-head" role="row">
              <span role="columnheader">Column</span>
              <span role="columnheader">Type</span>
              <span role="columnheader">Nullable</span>
              <span role="columnheader">Key</span>
            </div>
            {columns.map((c) => {
              const isPk = pk.includes(c.name);
              const outgoing = fks.filter((fk) => fk.columns.includes(c.name));
              const unique = indexes.some((i) => i.unique && !i.primary && i.columns.length === 1 && i.columns[0] === c.name);
              const indexed =
                !isPk &&
                !unique &&
                !outgoing.length &&
                indexes.some((i) => i.columns.some((x) => x === c.name || x.startsWith(`${c.name} `)));
              return (
                <div className="ts-row" role="row" key={c.name} data-column={c.name}>
                  <span className="ts-name-cell" role="cell">
                    <span className="ts-name" title={c.name}>
                      {c.name}
                    </span>
                    {firstLine(c.comment) && (
                      <span className="ts-col-comment" data-column-comment={c.name} title={c.comment ?? undefined}>
                        {firstLine(c.comment)}
                      </span>
                    )}
                  </span>
                  <span className="ts-type-cell" role="cell">
                    <span className="ts-type" title={c.type_name}>
                      {shortType(c.type_name)}
                    </span>
                    {c.default && (
                      <span className="ts-default" title={c.default}>
                        = {c.default}
                      </span>
                    )}
                  </span>
                  <span className="ts-nullable" role="cell">
                    {c.nullable && !isPk ? "yes" : "no"}
                  </span>
                  <span className="ts-badges" role="cell">
                    {isPk && <span className="ts-badge pk">PRIMARY</span>}
                    {unique && <span className="ts-badge unique">UNIQUE</span>}
                    {outgoing.map((fk) => {
                      const key = tableKey(table.database, fk.ref_schema, fk.ref_table);
                      return byKey.has(key) ? (
                        <button
                          type="button"
                          key={fk.name}
                          className="ts-badge fk"
                          data-fk={fk.ref_table}
                          title={`Open ${fk.ref_schema}.${fk.ref_table}`}
                          onClick={() => onOpenTable(key)}
                        >
                          → {fk.ref_table}
                        </button>
                      ) : (
                        <span key={fk.name} className="ts-badge fk">
                          → {fk.ref_table}
                        </span>
                      );
                    })}
                    {indexed && <span className="ts-badge indexed">INDEXED</span>}
                  </span>
                </div>
              );
            })}
          </div>
        )}
        <p className="ts-note">
          {columns.length} {columns.length === 1 ? "column" : "columns"}
          {pk.length ? ` · primary key ${pk.join(", ")}` : " · no primary key"}
          {` · ${fks.length} foreign ${fks.length === 1 ? "key" : "keys"}`}
          {!isPlainView && !loadingIndexes && ` · ${indexes.length} ${indexes.length === 1 ? "index" : "indexes"}`}
        </p>
      </section>

      {/* A plain view can't have indexes or foreign keys; skip the empty cards. */}
      {!isPlainView && (
        <>
          <section data-testid="ts-card" className="ts-card" aria-label="Indexes">
            <h2 className="ts-card-title">
              <IndexIcon size={14} />
              Indexes{" "}
              {!loadingIndexes && <span className="ts-count">{indexes.length}</span>}
            </h2>
            {loadingIndexes ? (
              <div className="ts-empty">Loading…</div>
            ) : loadError ? (
              <div className="ts-empty">Couldn't load indexes: {loadError}</div>
            ) : indexes.length === 0 ? (
              <div className="ts-empty">No indexes</div>
            ) : (
              <div className="ts-list">
                {indexes.map((ix) => {
                  // Unique and primary indexes enforce constraints even when never scanned.
                  const unused = ix.scans === 0 && !ix.primary && !ix.unique;
                  const facts = richIndexes
                    ? [
                        ix.method,
                        ix.size_bytes != null
                          ? formatBytes(ix.size_bytes)
                          : null,
                        ix.scans != null
                          ? `${ix.scans.toLocaleString()} ${ix.scans === 1 ? "scan" : "scans"}`
                          : null,
                      ].filter(Boolean)
                    : [];
                  return (
                    <div data-testid="ts-index" className="ts-item ts-index" key={ix.name}>
                      <span className="ts-index-name">
                        <span className="ts-mono ts-strong" title={ix.name}>
                          {ix.name}
                        </span>
                        {ix.primary ? (
                          <span className="ts-badge pk">PK</span>
                        ) : ix.unique ? (
                          <span className="ts-badge unique">UNIQUE</span>
                        ) : null}
                        {unused && (
                          <span className="ts-badge unused">Unused</span>
                        )}
                      </span>
                      <span className="ts-chips">
                        {ix.columns.map((c) => (
                          <span className="ts-chip" key={c}>
                            {c}
                          </span>
                        ))}
                      </span>
                      <span
                        className="ts-facts"
                        title={
                          richIndexes
                            ? "Scans since stats were last reset"
                            : undefined
                        }
                      >
                        {facts.join(" · ")}
                      </span>
                    </div>
                  );
                })}
              </div>
            )}
          </section>

          <div className="ts-relations">
            <section data-testid="ts-card" className="ts-card" aria-label="References">
              <h2 className="ts-card-title">
                <ArrowOutIcon size={14} />
                References <span className="ts-count">{fks.length}</span>
              </h2>
              {fks.length === 0 ? (
                <div className="ts-empty">No foreign keys</div>
              ) : (
                <div className="ts-list">
                  {fks.map((fk) => {
                    const target = byKey.get(
                      tableKey(table.database, fk.ref_schema, fk.ref_table),
                    );
                    const del = onDeleteLabel(fk.on_delete);
                    return (
                      <div
                        data-testid="ts-relation"
                        className="ts-item ts-relation"
                        key={fk.name}
                        title={fk.name}
                      >
                        <span className="ts-chip">{fk.columns.join(", ")}</span>
                        <span className="ts-arrow">→</span>
                        {tableLink(
                          fk.ref_schema,
                          fk.ref_table,
                          refCols(fk, target),
                        )}
                        {del && <span className="ts-rule">{del}</span>}
                      </div>
                    );
                  })}
                </div>
              )}
            </section>
            <section data-testid="ts-card" className="ts-card" aria-label="Referenced by">
              <h2 className="ts-card-title">
                <ArrowInIcon size={14} />
                Referenced by{" "}
                <span className="ts-count">{incoming.length}</span>
              </h2>
              {incoming.length === 0 ? (
                <div className="ts-empty">No tables point here</div>
              ) : (
                <div className="ts-list">
                  {incoming.map(({ from, fk }) => {
                    const del = onDeleteLabel(fk.on_delete);
                    return (
                      <div
                        data-testid="ts-relation"
                        className="ts-item ts-relation"
                        key={`${from.key}:${fk.name}`}
                        title={fk.name}
                      >
                        {tableLink(from.schema, from.name, fk.columns)}
                        <span className="ts-arrow">→</span>
                        <span className="ts-chip">
                          {refCols(fk, table).join(", ")}
                        </span>
                        {del && <span className="ts-rule">{del}</span>}
                      </div>
                    );
                  })}
                </div>
              )}
            </section>
          </div>
        </>
      )}
    </div>
  );
}
