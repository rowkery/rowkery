import { Pg } from "./Pg";

/** What's in the app, scrolling past (twice over, so the loop has no seam), with a penguin walking along it. */
const FEATURES = [
  "⌘K palette",
  "Quick Look",
  "Query plans",
  "Safe mode",
  "Sessions",
  "Environments",
  "Schema-aware autocomplete",
  "SSH tunnels",
  "Keychain",
  "Sensitive columns",
  "Presenting mode",
  "Review SQL",
  "Agent log",
  "Agent proposals",
  "Multi-statement run",
  "Foreign-key jumps",
  "Tabs that come back",
];

export function Ticker() {
  return (
    <>
      <Walkway />
      <div className="ticker" aria-label="What’s in the app">
        <div className="ticker-in">
          {[...FEATURES, ...FEATURES].map((f, i) => (
            <span key={i} aria-hidden={i >= FEATURES.length || undefined}>
              {f}
            </span>
          ))}
        </div>
      </div>
    </>
  );
}

/** A penguin waddling to the end of the line and back. */
export function Walkway({ className }: { className?: string }) {
  return (
    <div className={`walkway${className ? ` ${className}` : ""}`} aria-hidden="true">
      <div className="walker">
        <Pg />
      </div>
    </div>
  );
}
