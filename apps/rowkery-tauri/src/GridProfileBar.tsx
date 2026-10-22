import { useState } from "react";
import { profileCaption, type ColumnProfile } from "./columnProfile";

/** A drag that ends in the header must not also sort: swallow the click it makes. */
function swallowNextClick() {
  const stop = (e: MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
  };
  window.addEventListener("click", stop, { capture: true, once: true });
  window.setTimeout(() => window.removeEventListener("click", stop, { capture: true }), 0);
}

/**
 * The column's shape under its name; see `columnProfile.ts`. With `onSeg`, a
 * click on a segment filters on its value; with `onRange`, a drag across
 * histogram bars filters BETWEEN their edges.
 */
export function ProfileBar({
  profile,
  onSeg,
  onRange,
}: {
  profile: ColumnProfile | null;
  onSeg?: (value: string | null) => void;
  onRange?: (lo: number, hi: number) => void;
}) {
  const [drag, setDrag] = useState<[number, number] | null>(null);
  if (!profile) return <span className="rg-profile" />;
  if (profile.kind === "hist") {
    const n = profile.bars.length;
    const lo = drag ? Math.min(drag[0], drag[1]) : -1;
    const hi = drag ? Math.max(drag[0], drag[1]) : -1;
    return (
      <span
        className={`rg-profile rg-hist${onRange ? " rg-pickable" : ""}`}
        aria-hidden
        data-hist
        onMouseDown={
          onRange
            ? (e) => {
                if (e.button !== 0) return;
                e.preventDefault();
                e.stopPropagation();
                const box = e.currentTarget.getBoundingClientRect();
                const binAt = (x: number) => Math.max(0, Math.min(n - 1, Math.floor(((x - box.left) / box.width) * n)));
                const start = binAt(e.clientX);
                let range: [number, number] = [start, start];
                setDrag(range);
                const move = (ev: MouseEvent) => {
                  range = [start, binAt(ev.clientX)];
                  setDrag(range);
                };
                const up = () => {
                  window.removeEventListener("mousemove", move);
                  window.removeEventListener("mouseup", up);
                  swallowNextClick();
                  setDrag(null);
                  onRange(Math.min(...range), Math.max(...range));
                };
                window.addEventListener("mousemove", move);
                window.addEventListener("mouseup", up);
              }
            : undefined
        }
        onClick={onRange ? (e) => e.stopPropagation() : undefined}
      >
        {profile.bars.map((h, j) => (
          <i
            key={j}
            data-bin={j}
            className={j >= lo && j <= hi ? "rg-bin-picked" : undefined}
            style={{ height: `${Math.round(h * 100)}%`, ["--j" as string]: j }}
          />
        ))}
      </span>
    );
  }
  return (
    <span className="rg-profile rg-split" aria-hidden>
      {profile.kind === "split" && (
        <span data-testid="rg-segs" className="rg-segs">
          {profile.segs.map((seg, j) => {
            const pick = onSeg && seg.value !== undefined ? seg.value : undefined;
            return (
              <i
                key={j}
                data-tone={seg.tone}
                data-seg={pick === undefined ? undefined : (pick ?? "NULL")}
                className={pick !== undefined ? "rg-pickable" : undefined}
                title={pick === undefined ? undefined : pick === null ? "Rows where it is NULL" : `Only rows where it is ${pick}`}
                onClick={
                  pick !== undefined
                    ? (e) => {
                        e.stopPropagation();
                        onSeg?.(pick);
                      }
                    : undefined
                }
                style={{
                  flexGrow: seg.share,
                  ["--j" as string]: j,
                  ["--a" as string]: Math.max(0.12, 0.5 - j * 0.14),
                }}
              />
            );
          })}
        </span>
      )}
      <span data-testid="rg-cap" className="rg-cap">{profileCaption(profile)}</span>
    </span>
  );
}
