import { Fragment, type ReactNode } from "react";
import * as runtime from "react/jsx-runtime";
import { evaluate } from "@mdx-js/mdx";
import remarkGfm from "remark-gfm";
import shortcuts from "@/lib/generated/shortcuts.json";
import mcp from "@/lib/generated/mcp-tools.json";
import releases from "@/lib/generated/releases.json";
import { CodeBlock } from "@/components/CodeBlock";
import { slug } from "@/lib/slug";

// Tables generated from the app's own code, so the docs can't drift from it:
// lib/generated/shortcuts.json and releases.json come from apps/rowkery-tauri's
// test/docs-generated.test.ts, mcp-tools.json from rowkery-mcp's docs_table test. Each test
// fails when its file is stale and says how to rewrite it.

/** A key column: chords as keycaps, words ("drag row numbers", "⇥ after *") as text. */
function Keys({ keys }: { keys: string }) {
  if (!keys) return null;
  const parts = keys.split(" · ");
  return (
    <>
      {parts.map((p, i) => (
        <Fragment key={p}>
          {i > 0 && " "}
          {/\s/.test(p) ? <span className="keys-words">{p}</span> : <kbd>{p}</kbd>}
        </Fragment>
      ))}
    </>
  );
}

function Table({ head, children }: { head: string[]; children: ReactNode }) {
  return (
    <div className="tbl">
      <table>
        <thead>
          <tr>
            {head.map((h) => (
              <th key={h}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}

/** Every row of the app's shortcut sheet, by section, as the Rowkery keymap has them on a Mac. */
export function ShortcutTable() {
  return (
    <>
      {shortcuts.sections.map((s) => (
        <Fragment key={s.name}>
          <h3 id={`shortcuts-${slug(s.name)}`}>
            <a className="anchor" href={`#shortcuts-${slug(s.name)}`}>
              {s.name}
            </a>
          </h3>
          <Table head={["Action", "Keys"]}>
            {s.rows.map((r) => (
              <tr key={r.title}>
                <td>{r.title}</td>
                <td>
                  <Keys keys={r.keys} />
                </td>
              </tr>
            ))}
          </Table>
        </Fragment>
      ))}
    </>
  );
}

/** The chords each keymap moves; everything else keeps Rowkery's. */
export function KeymapTable() {
  return (
    <Table head={["Keymap", "Action", "Rowkery", "This keymap"]}>
      {shortcuts.keymaps.flatMap((k) =>
        k.swaps.map((s, i) => (
          <tr key={`${k.label}-${s.title}`}>
            <td>{i === 0 ? k.label : ""}</td>
            <td>{s.title}</td>
            <td>
              <Keys keys={s.rowkery} />
            </td>
            <td>
              <Keys keys={s.keys} />
            </td>
          </tr>
        )),
      )}
    </Table>
  );
}

/** The app's own menus in the macOS menu bar (App and Edit are the system's). */
export function MenuTable() {
  return (
    <Table head={["Menu", "Items"]}>
      {shortcuts.menus.map((m) => (
        <tr key={m.menu}>
          <td>{m.menu}</td>
          <td>
            {m.items.map((i, n) => (
              <Fragment key={i.title}>
                {n > 0 && ", "}
                {i.title}
                {i.keys && (
                  <>
                    {" "}
                    <kbd>{i.keys}</kbd>
                  </>
                )}
              </Fragment>
            ))}
          </td>
        </tr>
      ))}
    </Table>
  );
}

/** Every command ⌘K can run (when it applies), in its empty-state order. */
export function CommandList() {
  return (
    <Table head={["Command", "Keys"]}>
      {shortcuts.palette.map((c) => (
        <tr key={c.title}>
          <td>{c.title}</td>
          <td>
            <Keys keys={c.keys} />
          </td>
        </tr>
      ))}
    </Table>
  );
}

/** The guard's limits on every agent query. */
export function McpLimits() {
  const l = mcp.limits;
  const n = (x: number) => x.toLocaleString("en-US");
  return (
    <Table head={["Limit", "Value"]}>
      <tr>
        <td>Rows when the agent doesn&apos;t ask</td>
        <td>{n(l.default_rows)}</td>
      </tr>
      <tr>
        <td>Most rows a query returns</td>
        <td>{n(l.max_rows)}</td>
      </tr>
      <tr>
        <td>Time limit per statement</td>
        <td>
          {l.timeout_s} s, or {l.timeout_choices_s.slice(1).map((s) => (s < 60 ? `${s} s` : `${s / 60} min`)).join(", ")} set per connection
        </td>
      </tr>
      <tr>
        <td>Biggest table a plan may read end to end</td>
        <td>{n(l.big_table_rows)} rows</td>
      </tr>
      <tr>
        <td>Longest text cell returned</td>
        <td>{n(l.cell_chars)} characters</td>
      </tr>
      <tr>
        <td>Largest response</td>
        <td>{l.payload_bytes / 1024} KB of JSON</td>
      </tr>
      <tr>
        <td>Largest Postgres plan checked</td>
        <td>{l.plan_bytes / 1024 / 1024} MB</td>
      </tr>
    </Table>
  );
}

/** Every tool the MCP server offers: what it does and its inputs. */
export function McpTools() {
  return (
    <>
      {mcp.tools.map((t) => (
        <Fragment key={t.name}>
          <h3 id={slug(t.name)}>
            <a className="anchor" href={`#${slug(t.name)}`}>
              <code>{t.name}</code>
            </a>
          </h3>
          <p>{t.description}</p>
          {t.inputs.length > 0 ? (
            <Table head={["Input", "Type", "Required", "What it is"]}>
              {t.inputs.map((i) => (
                <tr key={i.name}>
                  <td>
                    <code>{i.name}</code>
                  </td>
                  <td>
                    {i.type}
                    {i.minimum != null && i.maximum != null && ` (${i.minimum} to ${i.maximum.toLocaleString("en-US")})`}
                    {i.minimum != null && i.maximum == null && ` (${i.minimum} or more)`}
                  </td>
                  <td>{i.required ? "Yes" : "No"}</td>
                  <td>{i.description ?? ""}</td>
                </tr>
              ))}
            </Table>
          ) : (
            <p className="muted">No inputs.</p>
          )}
        </Fragment>
      ))}
    </>
  );
}

/** The instructions the server gives every client when it connects. */
export function McpInstructions() {
  return <blockquote className="quote">{mcp.instructions}</blockquote>;
}

/** Each release's notes (docs/releases/v*.md), newest first, its sections one level down. */
export async function ReleaseNotes() {
  const out = [];
  for (const r of releases) {
    let fence = false;
    const md = r.markdown
      .split("\n")
      .map((line) => {
        if (/^\s*```/.test(line)) fence = !fence;
        return !fence && /^#{2,5} /.test(line) ? `#${line}` : line;
      })
      .join("\n");
    const { default: Notes } = await evaluate(md, { ...runtime, format: "md", remarkPlugins: [remarkGfm] });
    out.push(
      <section key={r.version} className="release">
        <h2 id={slug(r.version)}>
          <a className="anchor" href={`#${slug(r.version)}`}>
            {r.version}
          </a>
        </h2>
        <Notes
          components={{
            h3: ({ children }) => <h3 id={`${slug(r.version)}-${slug(String(children))}`}>{children}</h3>,
            pre: (props) => <CodeBlock {...props} />,
            table: (props) => (
              <div className="tbl">
                <table {...props} />
              </div>
            ),
          }}
        />
      </section>,
    );
  }
  return <>{out}</>;
}
