import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { DownloadIcon, KeyboardIcon } from "./icons";
import { KEYMAPS, KEYMAP_CHORDS, setKeymap, useKeymap } from "./keymaps";
import { useGlideHover } from "./motion";
import { isMacPlatform } from "./platform";
import { loadAppInfo } from "./report";
import { THEME_SETTINGS, setThemeSetting, useTheme } from "./theme";
import {
  UPDATE_PREFS,
  downloadUpdate,
  lookForUpdate,
  restartToUpdate,
  setUpdatePref,
  updateWaiting,
  useUpdatePref,
  useUpdateState,
  type UpdateState,
} from "./updates";
import "./SettingsPage.css";

export type SettingsSection = "updates" | "appearance" | "keyboard";

/**
 * Settings (2026-10-17): a page in place of the window, as Agents is (the
 * schema column hides under it). Categories down the left, the picked one's
 * settings on the right. Each choice is a card; picking it applies at once
 * and saves to config.json. Esc or ⌘W goes back to the window.
 */
export function SettingsPage({
  section,
  onSection,
  onShortcuts,
  runningQueries,
  onClose,
}: {
  section: SettingsSection;
  onSection: (s: SettingsSection) => void;
  /** The shortcut sheet, over the page. */
  onShortcuts: () => void;
  /** Queries running in every window: Check now's Restart waits for them. */
  runningQueries: () => number;
  onClose: () => void;
}) {
  const rootRef = useRef<HTMLElement>(null);
  const navRef = useRef<HTMLElement>(null);
  useGlideHover(navRef, ".st-nav-row");
  const update = useUpdateState();
  const pref = useUpdatePref();

  useEffect(() => {
    rootRef.current?.focus();
  }, []);

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key !== "Escape") return;
    e.preventDefault();
    e.stopPropagation();
    onClose();
  };

  const sections: { id: SettingsSection; label: string; icon: ReactNode; dot?: boolean }[] = [
    { id: "updates", label: "Updates", icon: <DownloadIcon size={14} />, dot: updateWaiting(update, pref) },
    { id: "appearance", label: "Appearance", icon: <AutoIcon /> },
    { id: "keyboard", label: "Keyboard", icon: <KeyboardIcon size={14} /> },
  ];

  return (
    <section
      ref={rootRef}
      className="settings-page"
      data-testid="settings-page"
      data-section={section}
      aria-label="Settings"
      tabIndex={-1}
      onKeyDown={onKeyDown}
    >
      <header className="ag-head">
        <h1 className="ag-title">Settings</h1>
        <span className="mcp-grow" />
        <button type="button" className="mcp-esc" data-st-close title="Back to the window  esc" onClick={onClose}>
          esc
        </button>
      </header>
      <div className="st-body">
        <nav ref={navRef} className="st-nav" aria-label="Settings">
          {sections.map((s) => (
            <button
              key={s.id}
              type="button"
              className="st-nav-row"
              data-st-section={s.id}
              aria-current={section === s.id ? "page" : undefined}
              onClick={() => onSection(s.id)}
            >
              {s.icon}
              <span>{s.label}</span>
              {s.dot && <span className="st-dot" data-testid="st-update-dot" aria-label="An update waits" />}
            </button>
          ))}
        </nav>
        <div className="st-main">
          {section === "updates" && <UpdatesSection update={update} pref={pref} runningQueries={runningQueries} />}
          {section === "appearance" && <AppearanceSection />}
          {section === "keyboard" && <KeyboardSection onShortcuts={onShortcuts} />}
        </div>
      </div>
    </section>
  );
}

function UpdatesSection({
  update,
  pref,
  runningQueries,
}: {
  update: UpdateState;
  pref: ReturnType<typeof useUpdatePref>;
  runningQueries: () => number;
}) {
  const [version, setVersion] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    void loadAppInfo().then((info) => live && setVersion(info.version === "unknown" ? null : info.version));
    return () => {
      live = false;
    };
  }, []);
  const mine = version ? `Rowkery ${version}` : "Rowkery";
  const check = (
    <button type="button" className="mcp-btn" data-st-check onClick={() => void lookForUpdate(true, runningQueries)}>
      Check now
    </button>
  );
  let status: ReactNode;
  switch (update.phase) {
    case "available":
      status = (
        <>
          <b>Rowkery {update.version} is out</b>
          {version && <span className="st-sub">you have {version}</span>}
          <span className="mcp-grow" />
          <button type="button" className="mcp-btn ink" data-st-download onClick={() => void downloadUpdate()}>
            Download
          </button>
        </>
      );
      break;
    case "downloading":
      status = (
        <>
          <b>Downloading Rowkery {update.version}…</b>
          <span className="mcp-grow" />
        </>
      );
      break;
    case "ready":
      status = (
        <>
          <b>Rowkery {update.version} is ready</b>
          <span className="st-sub">or it installs when you quit</span>
          <span className="mcp-grow" />
          <button type="button" className="mcp-btn ink" data-st-restart onClick={restartToUpdate}>
            Restart
          </button>
        </>
      );
      break;
    default:
      status = (
        <>
          <b>{mine}</b>
          <span className="st-sub">
            {update.phase === "checking"
              ? "checking…"
              : update.phase === "up-to-date"
                ? "up to date"
                : update.phase === "off"
                  ? "this build doesn't update itself"
                  : update.phase === "error"
                    ? "couldn't check"
                    : ""}
          </span>
          <span className="mcp-grow" />
          {check}
        </>
      );
  }
  const notes = (update.phase === "available" || update.phase === "downloading" || update.phase === "ready") && update.notes;
  return (
    <>
      <h2 className="st-h2">Updates</h2>
      <div className="st-status" data-testid="st-update-status" data-phase={update.phase}>
        {status}
      </div>
      {notes && <pre className="st-notes" data-testid="st-notes">{notes}</pre>}
      <Cards
        label="When a new version is out"
        name="update-pref"
        value={pref}
        options={UPDATE_PREFS.map((p) => ({ value: p.value, label: p.label, detail: p.detail }))}
        onPick={setUpdatePref}
      />
    </>
  );
}

function AppearanceSection() {
  const { setting } = useTheme();
  const mac = isMacPlatform();
  return (
    <>
      <h2 className="st-h2">Appearance</h2>
      <Cards
        label="Theme"
        name="theme"
        value={setting}
        options={THEME_SETTINGS.map((t) => ({
          value: t.value,
          label: t.value === "auto" ? "Auto" : t.label,
          detail: t.value === "auto" ? (mac ? "Follows macOS" : "Follows the system") : undefined,
        }))}
        onPick={setThemeSetting}
      />
    </>
  );
}

function KeyboardSection({ onShortcuts }: { onShortcuts: () => void }) {
  const keymap = useKeymap();
  return (
    <>
      <h2 className="st-h2">Keyboard</h2>
      <Cards
        label="Keys"
        name="keymap"
        value={keymap}
        options={KEYMAPS.map((k) => ({
          value: k.id,
          label: k.label,
          detail: k.id === "rowkery" ? undefined : `${Object.keys(KEYMAP_CHORDS[k.id]).length} keys as in ${k.label}`,
        }))}
        onPick={setKeymap}
      />
      <div className="st-row">
        <button type="button" className="mcp-btn quiet" data-st-shortcuts onClick={onShortcuts}>
          All keyboard shortcuts
        </button>
      </div>
    </>
  );
}

/** One choice of several: radio cards, the picked one orange-ringed. */
function Cards<T extends string>({
  label,
  name,
  value,
  options,
  onPick,
}: {
  label: string;
  name: string;
  value: T;
  options: { value: T; label: string; detail?: string }[];
  onPick: (v: T) => void;
}) {
  return (
    <div className="st-group" role="radiogroup" aria-label={label} data-st-group={name}>
      <h3 className="st-h3">{label}</h3>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          className="st-card"
          data-st-option={o.value}
          aria-checked={o.value === value}
          onClick={() => onPick(o.value)}
        >
          <span className="st-radio" aria-hidden />
          <span className="st-card-label">{o.label}</span>
          {o.detail && <span className="st-card-detail">{o.detail}</span>}
        </button>
      ))}
    </div>
  );
}

/** Appearance's mark: the half disc the foot shows for Auto. */
function AutoIcon() {
  return (
    <svg width={14} height={14} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.5} aria-hidden>
      <circle cx="8" cy="8" r="5.5" />
      <path d="M8 2.5a5.5 5.5 0 0 1 0 11z" fill="currentColor" stroke="none" />
    </svg>
  );
}
