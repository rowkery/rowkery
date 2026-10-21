import type { ReactNode } from "react";

/** A line icon on the 24 px grid, in the text colour. */
function Line({ size, width = 2, children }: { size: number; width?: number; children: ReactNode }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={width} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {children}
    </svg>
  );
}

/** The Apple logo, on Download for Mac. */
export const AppleIcon = () => (
  <svg width={16} height={16} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
    <path d="M16.4 12.6c0-2.6 2.1-3.8 2.2-3.9-1.2-1.8-3.1-2-3.7-2-1.6-.2-3.1.9-3.9.9-.8 0-2-.9-3.4-.9-1.7 0-3.3 1-4.2 2.6-1.8 3.1-.5 7.7 1.3 10.2.9 1.2 1.9 2.6 3.2 2.6 1.3-.1 1.8-.8 3.3-.8 1.6 0 2 .8 3.4.8 1.4 0 2.3-1.3 3.1-2.5 1-1.4 1.4-2.8 1.4-2.9 0 0-2.7-1-2.7-4.1ZM13.9 4.9c.7-.9 1.2-2 1.1-3.2-1 0-2.2.7-3 1.6-.6.7-1.2 1.9-1.1 3.1 1.2.1 2.3-.6 3-1.5Z" />
  </svg>
);

/** The GitHub mark, for the links to the repository. */
export const GitHubIcon = () => (
  <svg width={16} height={16} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
    <path d="M12 .5a11.5 11.5 0 0 0-3.64 22.41c.58.1.79-.25.79-.56v-2c-3.2.7-3.88-1.37-3.88-1.37-.53-1.33-1.28-1.69-1.28-1.69-1.05-.71.08-.7.08-.7 1.16.08 1.77 1.19 1.77 1.19 1.03 1.77 2.7 1.26 3.36.96.1-.75.4-1.26.73-1.55-2.55-.29-5.24-1.28-5.24-5.69 0-1.26.45-2.29 1.19-3.09-.12-.29-.52-1.46.11-3.05 0 0 .97-.31 3.17 1.18a11 11 0 0 1 5.77 0c2.2-1.49 3.17-1.18 3.17-1.18.63 1.59.23 2.76.11 3.05.74.8 1.19 1.83 1.19 3.09 0 4.42-2.7 5.4-5.26 5.68.41.36.78 1.06.78 2.14v3.17c0 .31.21.67.8.56A11.5 11.5 0 0 0 12 .5Z" />
  </svg>
);

/** A magnifying glass: the ⌘K search field. */
export const SearchIcon = ({ size = 15 }: { size?: number }) => (
  <Line size={size}>
    <circle cx="11" cy="11" r="6.5" />
    <path d="m20 20-4.2-4.2" />
  </Line>
);

/** A database: a connection's tab in the little app windows. */
export const DatabaseIcon = () => (
  <Line size={14}>
    <ellipse cx="12" cy="6" rx="7" ry="3" />
    <path d="M5 6v12c0 1.7 3.1 3 7 3s7-1.3 7-3V6M5 12c0 1.7 3.1 3 7 3s7-1.3 7-3" />
  </Line>
);

/** A table, in the little windows' table lists. */
export const TableIcon = () => (
  <Line size={14} width={1.8}>
    <rect x="4" y="5" width="16" height="14" rx="2.5" />
    <path d="M4 10h16M10 10v9" />
  </Line>
);

/** A speech bubble: the agent. */
export const ChatIcon = () => (
  <Line size={15}>
    <path d="M5 5h14a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-7l-5 4v-4H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2Z" />
  </Line>
);

/** A padlock: the Keychain. */
export const LockIcon = () => (
  <Line size={16}>
    <rect x="5" y="11" width="14" height="9" rx="2.5" />
    <path d="M8 11V8a4 4 0 0 1 8 0v3" />
  </Line>
);

/** Orange shades: a column marked sensitive. */
export const ShadesIcon = () => (
  <svg width={22} height={22} viewBox="0 0 24 24" aria-hidden="true">
    <rect x="2.5" y="8" width="8" height="6.5" rx="3" fill="var(--acc)" />
    <rect x="13.5" y="8" width="8" height="6.5" rx="3" fill="var(--acc)" />
    <path d="M10.5 10.5h3" stroke="var(--acc)" strokeWidth="1.8" strokeLinecap="round" />
  </svg>
);

/** A heart: free, and Sponsor. */
export const HeartIcon = () => (
  <Line size={18} width={2.1}>
    <path d="M12 20s-7.5-4.6-7.5-10.2A4.3 4.3 0 0 1 12 7.3a4.3 4.3 0 0 1 7.5 2.5C19.5 15.4 12 20 12 20Z" />
  </Line>
);

/** Angle brackets: open source. */
export const CodeIcon = () => (
  <Line size={18} width={2.1}>
    <path d="m8.5 7-5 5 5 5M15.5 7l5 5-5 5" />
  </Line>
);

/** A person struck through: no account. */
export const NoUserIcon = () => (
  <Line size={18}>
    <circle cx="12" cy="8.5" r="3.5" />
    <path d="M5 20c.8-3.6 3.6-5.5 7-5.5s6.2 1.9 7 5.5M4 4l16 16" />
  </Line>
);
