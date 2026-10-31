import { useEffect, useRef, useState, type CSSProperties, type KeyboardEvent } from "react";
import { ENGINES, EngineLogo, engineLook, type EngineKind } from "./engines";
import { Floating } from "./Floating";

/** The menu's order and names: MySQL's row covers MariaDB, which the server names. */
const CHOICES: { kind: EngineKind; label: string }[] = [
  { kind: "postgres", label: ENGINES.postgres.label },
  { kind: "mysql", label: "MySQL · MariaDB" },
  { kind: "sqlite", label: ENGINES.sqlite.label },
];

/**
 * New connection's engine: a chip with the engine's logo that opens a menu
 * (Mock A, 2026-10-31). A MySQL server that said it is MariaDB shows the
 * seal and name on the chip.
 */
export function EnginePicker({
  value,
  mariadb,
  onChange,
}: {
  value: EngineKind;
  mariadb: boolean;
  onChange: (kind: EngineKind) => void;
}) {
  const [open, setOpen] = useState(false);
  const [at, setAt] = useState(0);
  const chip = useRef<HTMLButtonElement>(null);
  const layer = useRef<HTMLDivElement>(null);
  const shown = engineLook(value, mariadb);

  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => {
      const t = e.target as Node;
      if (!chip.current?.contains(t) && !layer.current?.contains(t)) setOpen(false);
    };
    document.addEventListener("pointerdown", away, true);
    return () => document.removeEventListener("pointerdown", away, true);
  }, [open]);

  const show = () => {
    setAt(Math.max(0, CHOICES.findIndex((c) => c.kind === value)));
    setOpen(true);
  };
  const pick = (kind: EngineKind) => {
    setOpen(false);
    chip.current?.focus();
    if (kind !== value) onChange(kind);
  };
  const onKeyDown = (e: KeyboardEvent) => {
    if (!open) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        show();
      }
      return;
    }
    if (e.key === "Escape") {
      // Closes the menu, not the sheet.
      e.preventDefault();
      e.stopPropagation();
      setOpen(false);
    } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const step = e.key === "ArrowDown" ? 1 : -1;
      setAt((i) => (i + step + CHOICES.length) % CHOICES.length);
    } else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      e.stopPropagation();
      pick(CHOICES[at].kind);
    } else if (e.key === "Tab") {
      setOpen(false);
    }
  };

  return (
    <>
      <button
        ref={chip}
        type="button"
        className="nc-engine-pick"
        data-engine-pick={value}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={`Engine: ${shown.label}`}
        onClick={() => (open ? setOpen(false) : show())}
        onKeyDown={onKeyDown}
      >
        <span className="nc-engine-tile" style={{ "--engine": shown.color } as CSSProperties}>
          <EngineLogo engine={shown} size={13} />
        </span>
        {shown.label}
        <svg className="nc-engine-chev" width="9" height="9" viewBox="0 0 10 10" aria-hidden>
          <path d="M2 3.5 5 6.5 8 3.5" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {open && (
        <Floating anchor={chip} layerRef={layer}>
          <ul className="nc-engine-menu" role="listbox" aria-label="Engine">
            {CHOICES.map((c, i) => {
              const look = ENGINES[c.kind];
              return (
                <li
                  key={c.kind}
                  role="option"
                  data-engine-option={c.kind}
                  aria-selected={c.kind === value}
                  data-at={i === at ? "" : undefined}
                  onPointerEnter={() => setAt(i)}
                  onClick={() => pick(c.kind)}
                >
                  <span className="nc-engine-tile" style={{ "--engine": look.color } as CSSProperties}>
                    <EngineLogo engine={look} size={13} />
                  </span>
                  {c.label}
                  {c.kind === value && (
                    <svg className="nc-engine-check" width="11" height="11" viewBox="0 0 12 12" aria-hidden>
                      <path d="M2.5 6.5 5 9l4.5-6" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  )}
                </li>
              );
            })}
          </ul>
        </Floating>
      )}
    </>
  );
}
