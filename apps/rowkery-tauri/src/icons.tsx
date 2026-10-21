/** Small stroke icons for chrome. They inherit `currentColor`. */

import type { ReactNode } from "react";

interface IconProps {
  size?: number;
  className?: string;
  "data-testid"?: string;
}

function Svg({
  size = 14,
  className,
  children,
  strokeWidth = 1.4,
  viewBox = "0 0 16 16",
  "data-testid": testid,
}: IconProps & { children: ReactNode; strokeWidth?: number; viewBox?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox={viewBox}
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      data-testid={testid}
      aria-hidden
    >
      {children}
    </svg>
  );
}

export function TableIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <rect x="2" y="2.5" width="12" height="11" rx="2" />
      <path d="M2 6.5h12M6 6.5v7" />
    </Svg>
  );
}

export function ViewIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <rect x="2" y="2.5" width="12" height="11" rx="2" />
      <path d="M5 6.5h6M5 9h6M5 11.2h3.5" />
    </Svg>
  );
}

export function PartitionedIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <rect x="2" y="2.5" width="12" height="11" rx="2" />
      <path d="M2 6.5h12M2 10h12" />
    </Svg>
  );
}

export function DatabaseIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <ellipse cx="8" cy="3.8" rx="5.2" ry="2" />
      <path d="M2.8 3.8v8.4c0 1.1 2.3 2 5.2 2s5.2-.9 5.2-2V3.8M2.8 8c0 1.1 2.3 2 5.2 2s5.2-.9 5.2-2" />
    </Svg>
  );
}

export function SearchIcon(p: IconProps) {
  return (
    <Svg {...p} strokeWidth={1.6}>
      <circle cx="7" cy="7" r="4.5" />
      <path d="M10.5 10.5L14 14" />
    </Svg>
  );
}

export function RefreshIcon(p: IconProps) {
  return (
    <Svg {...p} strokeWidth={1.6}>
      <path d="M13 8a5 5 0 1 1-1.5-3.55" />
      <path d="M13 2.5v3h-3" />
    </Svg>
  );
}

export function ChevronDownIcon(p: IconProps) {
  return (
    <Svg {...p} strokeWidth={1.8}>
      <path d="M4 6l4 4 4-4" />
    </Svg>
  );
}

export function ChevronUpIcon(p: IconProps) {
  return (
    <Svg {...p} strokeWidth={1.8}>
      <path d="M4 10l4-4 4 4" />
    </Svg>
  );
}

export function ChevronLeftIcon(p: IconProps) {
  return (
    <Svg {...p} strokeWidth={1.6}>
      <path d="M10 3.5 5.5 8l4.5 4.5" />
    </Svg>
  );
}

export function ChevronRightIcon(p: IconProps) {
  return (
    <Svg {...p} strokeWidth={1.6}>
      <path d="M6 3.5 10.5 8 6 12.5" />
    </Svg>
  );
}

export function PlusIcon(p: IconProps) {
  return (
    <Svg {...p} strokeWidth={1.6}>
      <path d="M8 3v10M3 8h10" />
    </Svg>
  );
}

export function PencilIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M10.5 3.5l2 2L6 12H4v-2z" />
    </Svg>
  );
}

export function PinIcon(p: IconProps & { filled?: boolean }) {
  return (
    <svg
      width={p.size ?? 12}
      height={p.size ?? 12}
      viewBox="0 0 16 16"
      fill={p.filled ? "currentColor" : "none"}
      stroke="currentColor"
      strokeWidth={1.4}
      strokeLinejoin="round"
      className={p.className}
      aria-hidden
    >
      <path d="M6 2h4l-.6 4 2.6 2.5v1H4v-1L6.6 6z" />
      <path d="M8 9.5V14" fill="none" strokeLinecap="round" />
    </svg>
  );
}

export function HistoryIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M2.8 8a5.2 5.2 0 1 0 1.5-3.7M2.8 2.8v2.4h2.4" />
      <path d="M8 5.2V8l2 1.4" />
    </Svg>
  );
}

export function CommandIcon(p: IconProps) {
  return (
    <Svg {...p} strokeWidth={1.6}>
      <path d="M5.5 4.5L9 8l-3.5 3.5" />
    </Svg>
  );
}

export function ColumnsIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <rect x="2" y="2.5" width="12" height="11" rx="2" />
      <path d="M6 2.5v11M10 2.5v11" />
    </Svg>
  );
}

/** One column: editor completions. */
export function ColumnIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <rect x="5" y="2.5" width="6" height="11" rx="1.5" />
      <path d="M5 6.5h6" />
    </Svg>
  );
}

/** A function call: editor completions. */
export function FunctionIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M9.5 2.5c-1.6 0-2.2.8-2.5 2.4L5.6 12c-.3 1.2-.8 1.5-1.9 1.5M4.5 6.5h5" />
      <path d="m10 8.5 3 4M13 8.5l-3 4" />
    </Svg>
  );
}

export function IndexIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M3 4h10M3 8h7M3 12h4" />
    </Svg>
  );
}

export function ArrowOutIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M3 8h9M9 5l3 3-3 3" />
    </Svg>
  );
}

export function ArrowInIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M13 8H4M7 5L4 8l3 3" />
    </Svg>
  );
}

export function CloseIcon(p: IconProps) {
  return (
    <Svg {...p} viewBox="0 0 24 24" strokeWidth={2.4}>
      <path d="M7 7l10 10M17 7 7 17" />
    </Svg>
  );
}

export function PlayIcon({ size = 10, className }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" className={className} aria-hidden>
      <path
        d="M7 4.8v14.4c0 .8.9 1.3 1.6.9l11.4-7.2c.6-.4.6-1.4 0-1.8L8.6 3.9C7.9 3.5 7 4 7 4.8z"
        fill="currentColor"
      />
    </svg>
  );
}

/** Results as rows: the Data view. */
export function GridIcon(p: IconProps) {
  return (
    <Svg {...p} viewBox="0 0 24 24" strokeWidth={1.9}>
      <rect x="3.5" y="4.5" width="17" height="15" rx="2.5" />
      <path d="M3.5 9.5h17M3.5 14.5h17M9.5 4.5v15" />
    </Svg>
  );
}

/** Columns, indexes and keys: the Structure view. */
export function BlocksIcon(p: IconProps) {
  return (
    <Svg {...p} viewBox="0 0 24 24" strokeWidth={1.9}>
      <rect x="4" y="4" width="7" height="7" rx="2" />
      <rect x="13" y="4" width="7" height="7" rx="2" />
      <rect x="4" y="13" width="7" height="7" rx="2" />
      <rect x="13" y="13" width="7" height="7" rx="2" />
    </Svg>
  );
}

/** A table and its neighbours: the Map view. */
export function MapIcon(p: IconProps) {
  return (
    <Svg {...p} viewBox="0 0 24 24" strokeWidth={1.9}>
      <rect x="8.5" y="9" width="7" height="6" rx="1.8" />
      <rect x="2.5" y="3.5" width="5" height="4.5" rx="1.5" />
      <rect x="16.5" y="16" width="5" height="4.5" rx="1.5" />
      <path d="M7.5 5.8c2.5 0 2.5 3.2 2.5 3.2M14 15s0 3.3 2.5 3.3" />
    </Svg>
  );
}

export function KeyIcon(p: IconProps) {
  return (
    <Svg {...p} viewBox="0 0 24 24" strokeWidth={2.2}>
      <circle cx="8" cy="15" r="4" />
      <path d="m11 12 8-8M16 7l2.5 2.5M13.5 9.5 15.5 11.5" />
    </Svg>
  );
}

export function LinkIcon(p: IconProps) {
  return (
    <Svg {...p} viewBox="0 0 24 24" strokeWidth={2.2}>
      <path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1" />
      <path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1" />
    </Svg>
  );
}

export function CopyIcon(p: IconProps) {
  return (
    <Svg {...p} viewBox="0 0 24 24" strokeWidth={2}>
      <rect x="9" y="9" width="11" height="11" rx="3" />
      <path d="M15 9V7a3 3 0 0 0-3-3H7a3 3 0 0 0-3 3v5a3 3 0 0 0 3 3h2" />
    </Svg>
  );
}

export function SidebarIcon(p: IconProps) {
  return (
    <Svg {...p} viewBox="0 0 24 24" strokeWidth={1.8}>
      <rect x="3.5" y="4.5" width="17" height="15" rx="3" />
      <path d="M9.5 4.5v15" />
    </Svg>
  );
}

/** Three dots: a zone's `…` menu. */
export function MoreIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M4 8h.01M8 8h.01M12 8h.01" strokeWidth="2.2" />
    </Svg>
  );
}

/** A keyboard: the key strip's residue once it has retired. */
export function KeyboardIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <rect x="1.5" y="4" width="13" height="8.5" rx="2" />
      <path d="M4.5 7h.01M7 7h.01M9.5 7h.01M12 7h.01M4.5 9.75h.01M12 9.75h.01M6.5 9.75h3" />
    </Svg>
  );
}

/** An agent: the schema column's Agents button. */
export function AgentIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <rect x="2.5" y="5.5" width="11" height="8" rx="2.5" />
      <path d="M8 5.5V3M6.25 3h3.5" />
      <path d="M5.75 9.5h.01M10.25 9.5h.01" strokeWidth="2.2" />
    </Svg>
  );
}


export function WarningIcon(p: IconProps) {
  return (
    <Svg {...p} viewBox="0 0 24 24" strokeWidth={2.2}>
      <path d="M10.3 4.3 2.9 17.2A2 2 0 0 0 4.6 20h14.8a2 2 0 0 0 1.7-2.8L13.7 4.3a2 2 0 0 0-3.4 0z" />
      <path d="M12 9.5v4.2M12 16.8v.1" />
    </Svg>
  );
}

/** Safe mode: Confirm writes. */
export function ShieldIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M8 1.8 13 3.6v4.1c0 3-2.1 5.4-5 6.5-2.9-1.1-5-3.5-5-6.5V3.6z" />
    </Svg>
  );
}

/** Safe mode: Read-only. */
export function LockIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <rect x="3.2" y="7" width="9.6" height="7" rx="1.8" />
      <path d="M5.3 7V5.2a2.7 2.7 0 0 1 5.4 0V7" />
    </Svg>
  );
}

/**
 * The safe-mode shield beside the schema panel head: bare when Off, a dot
 * inside for Confirm writes, a bar for Read-only.
 */
export function ShieldModeIcon({ mode, ...p }: IconProps & { mode?: string }) {
  return (
    <Svg {...p}>
      <path d="M8 1.8 13 3.6v4.1c0 3-2.1 5.4-5 6.5-2.9-1.1-5-3.5-5-6.5V3.6z" />
      {mode === "confirm" && <circle cx="8" cy="7.6" r="1.4" fill="currentColor" stroke="none" />}
      {mode === "read_only" && <path d="M5.6 7.6h4.8" />}
    </Svg>
  );
}

/** The mark for a connection's safe mode; nothing when it is off. */
export function SafeModeIcon({ mode, ...p }: IconProps & { mode?: string }) {
  if (mode === "confirm") return <ShieldIcon {...p} />;
  if (mode === "read_only") return <LockIcon {...p} />;
  return null;
}

export function FilterIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M2.5 3.5h11L9.5 8.5v4l-3 1.5v-5.5z" />
    </Svg>
  );
}

/** Report type: Bug. */
export function BugIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <rect x="5" y="5.5" width="6" height="8" rx="3" />
      <path d="M6.2 4.4a1.8 1.8 0 0 1 3.6 0M2.5 8h2.5M11 8h2.5M3.2 4.2 5.2 6M12.8 4.2 10.8 6M3.2 12l2-1.4M12.8 12l-2-1.4M8 7.5v6" />
    </Svg>
  );
}

/** Report type: Feature (a sparkle). */
export function SparkleIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M7 2.5c.4 2.7 1.8 4.1 4.5 4.5-2.7.4-4.1 1.8-4.5 4.5-.4-2.7-1.8-4.1-4.5-4.5C5.2 6.6 6.6 5.2 7 2.5ZM12 10.5c.2 1.2.8 1.8 2 2-1.2.2-1.8.8-2 2-.2-1.2-.8-1.8-2-2 1.2-.2 1.8-.8 2-2Z" />
    </Svg>
  );
}

/** Report type: Feedback (a speech bubble). */
export function FeedbackIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M3.5 3h9A1.5 1.5 0 0 1 14 4.5v5a1.5 1.5 0 0 1-1.5 1.5H8l-3 2.5V11h-1.5A1.5 1.5 0 0 1 2 9.5v-5A1.5 1.5 0 0 1 3.5 3Z" />
    </Svg>
  );
}

/** Light appearance (the Appearance button), Paper's sun. */
export function SunIcon(p: IconProps) {
  return (
    <Svg {...p} viewBox="0 0 24 24" strokeWidth={1.8}>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.3 5.3l1.4 1.4M17.3 17.3l1.4 1.4M5.3 18.7l1.4-1.4M17.3 6.7l1.4-1.4" />
    </Svg>
  );
}

/** Dark appearance, Paper's moon. */
export function MoonIcon(p: IconProps) {
  return (
    <Svg {...p} viewBox="0 0 24 24" strokeWidth={1.8}>
      <path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z" />
    </Svg>
  );
}

/** Presenting is off: sensitive columns show. */
export function EyeIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M1.5 8s2.5-4 6.5-4 6.5 4 6.5 4-2.5 4-6.5 4-6.5-4-6.5-4z" />
      <circle cx="8" cy="8" r="2" />
    </Svg>
  );
}

/** A sensitive column, and Presenting while it is on. */
export function EyeOffIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M1.5 8s2.5-4 6.5-4 6.5 4 6.5 4-2.5 4-6.5 4-6.5-4-6.5-4z" />
      <circle cx="8" cy="8" r="2" />
      <path d="M3 13L13 3" />
    </Svg>
  );
}

/** A cog: the schema column's Settings button. */
export function SettingsIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M12.78 6.52 L14.5 6.88 L14.5 9.12 L12.78 9.48 L12.42 10.33 L13.39 11.81 L11.81 13.39 L10.33 12.42 L9.48 12.78 L9.12 14.5 L6.88 14.5 L6.52 12.78 L5.67 12.42 L4.19 13.39 L2.61 11.81 L3.58 10.33 L3.22 9.48 L1.5 9.12 L1.5 6.88 L3.22 6.52 L3.58 5.67 L2.61 4.19 L4.19 2.61 L5.67 3.58 L6.52 3.22 L6.88 1.5 L9.12 1.5 L9.48 3.22 L10.33 3.58 L11.81 2.61 L13.39 4.19 L12.42 5.67Z" />
      <circle cx="8" cy="8" r="2" />
    </Svg>
  );
}

/** An arrow into a tray: a newer Rowkery waits (the foot's update button, Settings > Updates). */
export function DownloadIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M8 2.5v8M4.75 7.25 8 10.5l3.25-3.25M3 13.5h10" />
    </Svg>
  );
}
