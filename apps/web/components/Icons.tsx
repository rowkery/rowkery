const line = { fill: "none", stroke: "currentColor", strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": true } as const;

export const DownloadIcon = () => (
  <svg {...line} width={16} height={16} viewBox="0 0 24 24" strokeWidth={2.2}>
    <path d="M12 4v12M6 11l6 6 6-6M5 20h14" />
  </svg>
);

/** A terminal prompt: the agent, at the start of the checkpoint rail. */
export const PromptIcon = () => (
  <svg {...line} width={20} height={20} viewBox="0 0 24 24" strokeWidth={2}>
    <path d="M5 7l5 5-5 5M12 17h7" />
  </svg>
);

/** The database, at the far end of the checkpoint rail. */
export const DatabaseIcon = () => (
  <svg {...line} width={22} height={22} viewBox="0 0 24 24" strokeWidth={1.9}>
    <ellipse cx="12" cy="6" rx="7" ry="3" />
    <path d="M5 6v12c0 1.7 3.1 3 7 3s7-1.3 7-3V6M5 12c0 1.7 3.1 3 7 3s7-1.3 7-3" />
  </svg>
);

export const KeyIcon = () => (
  <svg {...line} width={18} height={18} viewBox="0 0 24 24" strokeWidth={2}>
    <circle cx="8" cy="15" r="4" />
    <path d="M11 12l9-9M16 7l3 3" />
  </svg>
);

export const LockIcon = () => (
  <svg {...line} width={18} height={18} viewBox="0 0 24 24" strokeWidth={2}>
    <rect x="5" y="11" width="14" height="10" rx="2" />
    <path d="M8 11V8a4 4 0 0 1 8 0v3" />
  </svg>
);

/** The GitHub mark, for the links to the repository. */
export const GitHubIcon = () => (
  <svg width={16} height={16} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
    <path d="M12 .5a11.5 11.5 0 0 0-3.64 22.41c.58.1.79-.25.79-.56v-2c-3.2.7-3.88-1.37-3.88-1.37-.53-1.33-1.28-1.69-1.28-1.69-1.05-.71.08-.7.08-.7 1.16.08 1.77 1.19 1.77 1.19 1.03 1.77 2.7 1.26 3.36.96.1-.75.4-1.26.73-1.55-2.55-.29-5.24-1.28-5.24-5.69 0-1.26.45-2.29 1.19-3.09-.12-.29-.52-1.46.11-3.05 0 0 .97-.31 3.17 1.18a11 11 0 0 1 5.77 0c2.2-1.49 3.17-1.18 3.17-1.18.63 1.59.23 2.76.11 3.05.74.8 1.19 1.83 1.19 3.09 0 4.42-2.7 5.4-5.26 5.68.41.36.78 1.06.78 2.14v3.17c0 .31.21.67.8.56A11.5 11.5 0 0 0 12 .5Z" />
  </svg>
);

export const CloudIcon = () => (
  <svg {...line} width={18} height={18} viewBox="0 0 24 24" strokeWidth={2}>
    <path d="M7 18h10a4 4 0 0 0 .6-7.96A6 6 0 0 0 6.2 9.1 4.5 4.5 0 0 0 7 18Z" />
  </svg>
);

export const BulbIcon = () => (
  <svg {...line} width={18} height={18} viewBox="0 0 24 24" strokeWidth={2}>
    <path d="M9 18h6M10 21h4M12 3a6 6 0 0 0-3.5 10.9c.6.5 1 1.2 1 2.1h5c0-.9.4-1.6 1-2.1A6 6 0 0 0 12 3Z" />
  </svg>
);

export const EnginesIcon = () => (
  <svg {...line} width={18} height={18} viewBox="0 0 24 24" strokeWidth={2}>
    <ellipse cx="12" cy="6" rx="7" ry="3" />
    <path d="M5 6v12c0 1.7 3.1 3 7 3s7-1.3 7-3V6" />
  </svg>
);

export const WindowIcon = () => (
  <svg {...line} width={18} height={18} viewBox="0 0 24 24" strokeWidth={2}>
    <rect x="3" y="4" width="18" height="16" rx="2" />
    <path d="M3 9h18" />
  </svg>
);

export const UserIcon = () => (
  <svg {...line} width={18} height={18} viewBox="0 0 24 24" strokeWidth={2}>
    <circle cx="12" cy="8" r="4" />
    <path d="M4 21c1.2-4 4.3-6 8-6s6.8 2 8 6" />
  </svg>
);

export const ChatIcon = () => (
  <svg {...line} width={18} height={18} viewBox="0 0 24 24" strokeWidth={2}>
    <path d="M5 5h14a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-7l-5 4v-4H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2Z" />
  </svg>
);

export const CopyIcon = () => (
  <svg {...line} width={14} height={14} viewBox="0 0 24 24" strokeWidth={2}>
    <rect x="9" y="9" width="11" height="11" rx="2" />
    <path d="M5 15V6a2 2 0 0 1 2-2h9" />
  </svg>
);

export const CheckIcon = () => (
  <svg {...line} width={14} height={14} viewBox="0 0 24 24" strokeWidth={2.4}>
    <path d="M5 12.5l4.5 4.5L19 7" />
  </svg>
);


/** A heart, for Sponsor. */
export const HeartIcon = () => (
  <svg {...line} width={16} height={16} viewBox="0 0 24 24" strokeWidth={2.1}>
    <path d="M12 20s-7.5-4.6-7.5-10.2A4.3 4.3 0 0 1 12 7.3a4.3 4.3 0 0 1 7.5 2.5C19.5 15.4 12 20 12 20Z" />
  </svg>
);
