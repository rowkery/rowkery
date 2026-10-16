import { Mark } from "./Mark";

/**
 * The coming-soon page (app/soon.css): the mark, the name and the headline over a table seen
 * in perspective, whose rows roll toward the viewer without end. Twenty rows make one period,
 * drawn twice so the roll is seamless; two of them are orange, a row you asked for passing
 * through. The cells' widths come from a fixed seed, so the markup is the same on every
 * build. CSS only; Reduce Motion holds the table still.
 *
 * `?key=<ROWKERY_PREVIEW_KEY>` goes to /<key>/, where the coming-soon build also holds the
 * real site (app/(site)/[key]); any other key lands on the 404, this page again. The key is
 * never in this page: only its shape is checked, so the address can't leave the site.
 */
const KEY_DOOR = "(function(){var k=new URLSearchParams(location.search).get('key');if(k&&/^[A-Za-z0-9_-]{16,}$/.test(k))location.replace('/'+k+'/')})()";

const COLS = [54, 150, 96, 224, 128, 88, 176, 118];
const GAP = 12;
const ROWS = 20;
const HOT = new Set([4, 13]);
const WIDTH = COLS.reduce((a, b) => a + b, 0) + GAP * (COLS.length - 1) + 20;

function rows() {
  let seed = 7;
  const rnd = () => {
    seed = (seed * 16807) % 2147483647;
    return (seed - 1) / 2147483646;
  };
  const out: { hot: boolean; cells: { p: number; b: boolean }[] }[] = [];
  for (let r = 0; r < ROWS; r++) {
    const cells = [];
    for (let c = 0; c < COLS.length; c++) {
      const v = rnd();
      if (c > 0 && v < 0.14) {
        cells.push({ p: 0, b: false });
        continue;
      }
      cells.push({ p: c === 0 ? 100 : Math.round(38 + v * 62), b: rnd() < 0.3 });
    }
    out.push({ hot: HOT.has(r), cells });
  }
  return out;
}

export function ComingSoon() {
  const period = rows();
  return (
    <main className="soon" data-coming-soon>
      <script dangerouslySetInnerHTML={{ __html: KEY_DOOR }} />
      <div className="soon-copy">
        <div className="soon-brand">
          <Mark />
          Rowkery
        </div>
        <h1>Coming soon</h1>
        <p>A fast database app for the Mac, on its way.</p>
      </div>
      <div className="floor" aria-hidden="true">
        <div className="plane" style={{ "--w": `${WIDTH}px`, "--cols": COLS.map((c) => `${c}px`).join(" ") } as React.CSSProperties}>
          <div className="rows">
            {[0, 1].map((copy) =>
              period.map((row, r) => (
                <div key={`${copy}-${r}`} className={row.hot ? "row hot" : "row"}>
                  {row.cells.map((cell, c) => (
                    <i key={c} className={cell.b ? "b" : undefined} style={{ width: `${cell.p}%` }} />
                  ))}
                </div>
              )),
            )}
          </div>
        </div>
      </div>
    </main>
  );
}
