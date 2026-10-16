/** A row as an agent reads it once two of its columns are marked sensitive. */
const ROW: [column: string, value: string, masked: boolean][] = [
  ["id", "84204", false],
  ["email", "masked:3f9a0c71be", true],
  ["phone", "masked:a41d72c09e", true],
  ["total", "129.00", false],
];

/**
 * An agent trying to read a row (CSS only, an 8 s loop): the robot goes down the row, a column
 * every 2 s. Plain columns come back as they are; at a sensitive one it gets a stand-in, shakes
 * its head and a lock shows. Every loop moves only transform and opacity.
 */
export function MaskDemo() {
  return (
    <div className="mask" role="img" aria-label="An agent reads order 84204 column by column. id and total come back; email and phone are marked sensitive, so it only gets a stand-in such as masked:3f9a0c71be.">
      <div className="rows">
        {ROW.map(([column, value, masked]) => (
          <div className={`row${masked ? " hid" : ""}`} key={column}>
            <span>
              {masked && (
                <svg className="lk" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" aria-hidden="true">
                  <rect x="5" y="11" width="14" height="10" rx="2" />
                  <path d="M8 11V8a4 4 0 0 1 8 0v3" />
                </svg>
              )}
              {column}
            </span>
            <span className={masked ? "masked" : undefined}>{value}</span>
          </div>
        ))}
        <i className="beam" aria-hidden="true" />
      </div>
      <div className="bot" aria-hidden="true">
        <svg className="head" width="34" height="34" viewBox="0 0 34 34" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
          <path d="M17 3v5" />
          <circle cx="17" cy="3" r="1.6" fill="currentColor" stroke="none" />
          <rect x="5" y="8" width="24" height="20" rx="6" />
          <circle cx="12.5" cy="17" r="2" fill="currentColor" stroke="none" />
          <circle cx="21.5" cy="17" r="2" fill="currentColor" stroke="none" />
          <path d="M13 23h8" />
          <path d="M2 16v4M32 16v4" />
        </svg>
      </div>
    </div>
  );
}
