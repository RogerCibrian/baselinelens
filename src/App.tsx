import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";

import { Channel } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";

import {
  commands,
  type Baseline,
  type ParserProgress,
  type UserState,
} from "./bindings";
import Console from "./Console";
import {
  defaultConsoleFilter,
  type ConsoleFilter,
} from "./data/consoleFilter";
import { mockScan } from "./fixtures/mockScan";
import Onboarding from "./Onboarding";
import Overview from "./Overview";

import "./App.css";

type AppState =
  | { kind: "loading" }
  | { kind: "onboarding" }
  | { kind: "parsing"; fileName: string; progress: ParserProgress | null }
  | {
      kind: "pendingConfirm";
      fileName: string;
      baseline: Baseline;
      userState: UserState;
    }
  | {
      kind: "error";
      message: string;
      /** Filename of the rejected/failed file, if any. Carried through
       * from parsing → error so the drop zone keeps showing the file
       * instead of snapping back to its idle "Drop benchmark PDF here"
       * label between drop and error message. Null for errors not tied
       * to a specific file (e.g. cache restore failures). */
      fileName: string | null;
    }
  | {
      kind: "loaded";
      baseline: Baseline;
      userState: UserState;
      /** True when the cached baseline's parser_version doesn't match the
       * running parser's PARSER_VERSION — surfaces a re-parse prompt. */
      isStale: boolean;
    };

type Tab = "overview" | "console";

function App() {
  // Start in "loading" until the cache restore finishes — without this
  // initial state we'd flash the welcome screen on every cold launch.
  const [appState, setAppState] = useState<AppState>({ kind: "loading" });
  const [tab, setTab] = useState<Tab>("overview");
  const [consoleFilter, setConsoleFilter] = useState<ConsoleFilter>(
    defaultConsoleFilter,
  );

  useEffect(() => {
    void restoreFromCache(setAppState);
  }, []);

  // Applies a UserState change locally and persists it. The optimistic
  // update keeps the UI snappy; a save failure logs to the console and
  // leaves the in-memory state ahead of disk until the next save retry.
  async function updateUserState(next: UserState) {
    setAppState((prev) =>
      prev.kind === "loaded" ? { ...prev, userState: next } : prev,
    );
    const result = await commands.saveUserState(next);
    if (result.status !== "ok") {
      console.error("Failed to save user state:", result.error);
    }
  }

  // Overview click-through: replace the current Console filter with a
  // fresh filter that has only the requested fields set, then switch
  // tabs. Clearing other fields keeps the navigation predictable —
  // clicking a level card always lands on "just that level".
  function jumpToConsole(filter: Partial<ConsoleFilter>) {
    setConsoleFilter({ ...defaultConsoleFilter, ...filter });
    setTab("console");
  }

  // Render nothing during the cache-restore window so a cold launch with
  // an existing baseline doesn't flash the onboarding before landing on
  // the dashboard.
  if (appState.kind === "loading") return null;

  if (appState.kind === "loaded") {
    return (
      <Dashboard
        baseline={appState.baseline}
        userState={appState.userState}
        isStale={appState.isStale}
        tab={tab}
        onTabChange={setTab}
        onReparse={() => void selectAndParse(setAppState)}
        onUpdateUserState={(next) => void updateUserState(next)}
        consoleFilter={consoleFilter}
        onConsoleFilterChange={setConsoleFilter}
        onJumpToConsole={jumpToConsole}
      />
    );
  }
  return (
    <Onboarding
      state={appState}
      onPickPath={(path) => void parseAtPath(path, setAppState)}
      onError={(message, fileName) =>
        setAppState({ kind: "error", message, fileName: fileName ?? null })
      }
      onConfirm={() => {
        if (appState.kind !== "pendingConfirm") return;
        setAppState({
          kind: "loaded",
          baseline: appState.baseline,
          userState: appState.userState,
          isStale: false,
        });
      }}
      onCancel={() => setAppState({ kind: "onboarding" })}
    />
  );
}

/**
 * Reads `app_state.json` on mount and rehydrates the dashboard from the
 * cached `Baseline` and its `UserState`. Falls back to the onboarding
 * screen when nothing is cached or the cached entry can't be loaded.
 */
async function restoreFromCache(setAppState: Dispatch<SetStateAction<AppState>>) {
  const persisted = await commands.loadAppState();
  if (persisted.status !== "ok") {
    setAppState({ kind: "error", message: persisted.error, fileName: null });
    return;
  }
  const sha = persisted.data?.activeBaselineSha;
  if (!sha) {
    setAppState({ kind: "onboarding" });
    return;
  }
  const baselineResult = await commands.loadCachedBaseline(sha);
  if (baselineResult.status !== "ok") {
    setAppState({
      kind: "error",
      message: baselineResult.error,
      fileName: null,
    });
    return;
  }
  if (!baselineResult.data) {
    // app_state points at a SHA whose cache file is gone (manual deletion,
    // disk full at write time). Treat as "first launch" and show onboarding.
    setAppState({ kind: "onboarding" });
    return;
  }
  const { baseline, isStale } = baselineResult.data;
  const userState = await loadOrInitUserState(sha);
  setAppState({ kind: "loaded", baseline, userState, isStale });
}

/**
 * Opens the file picker, then hands off to `parseAtPath`. Used by the
 * "Re-parse" affordances (settings menu, stale-cache banner). The
 * onboarding drop zone bypasses this and calls `parseAtPath` directly
 * with the dropped file's path.
 */
async function selectAndParse(setAppState: Dispatch<SetStateAction<AppState>>) {
  const path = await open({
    multiple: false,
    directory: false,
    filters: [{ name: "PDF", extensions: ["pdf"] }],
  });
  if (typeof path !== "string") return;
  await parseAtPath(path, setAppState);
}

/**
 * Drives the parse pipeline from a known path. Transitions through
 * `parsing` (with progress events streamed in) to `pendingConfirm` so
 * the onboarding flow can show the confirmation modal before committing
 * to the new baseline.
 */
async function parseAtPath(
  path: string,
  setAppState: Dispatch<SetStateAction<AppState>>,
) {
  const fileName = extractFileName(path);
  const channel = new Channel<ParserProgress>();
  channel.onmessage = (progress) => {
    // Guard against late progress events: if the parse already resolved
    // (or errored) we've moved past "parsing" and shouldn't reopen it.
    setAppState((prev) =>
      prev.kind === "parsing" ? { ...prev, progress } : prev,
    );
  };

  setAppState({ kind: "parsing", fileName, progress: null });
  const result = await commands.parseBaseline(path, channel);
  if (result.status !== "ok") {
    setAppState({ kind: "error", message: result.error, fileName });
    return;
  }
  const baseline = result.data;
  const userState = await loadOrInitUserState(baseline.source.pdfSha256);
  setAppState({ kind: "pendingConfirm", fileName, baseline, userState });
}

function extractFileName(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

/**
 * Returns the persisted `UserState` for `sha`, or an empty one when no
 * file exists yet (a freshly-parsed baseline with no annotations).
 */
async function loadOrInitUserState(sha: string): Promise<UserState> {
  const result = await commands.loadUserState(sha);
  if (result.status === "ok" && result.data) {
    return result.data;
  }
  return { baselineSha256: sha, exceptions: {}, notes: {} };
}

/**
 * Post-load shell: top bar with tabs and the currently-active panel.
 * Owns the tab state and the (currently-mocked) Scan; the baseline and
 * userState come from the parent so persistence stays the source of truth.
 */
function Dashboard({
  baseline,
  userState,
  isStale,
  tab,
  onTabChange,
  onReparse,
  onUpdateUserState,
  consoleFilter,
  onConsoleFilterChange,
  onJumpToConsole,
}: {
  baseline: Baseline;
  userState: UserState;
  isStale: boolean;
  tab: Tab;
  onTabChange: (tab: Tab) => void;
  onReparse: () => void;
  onUpdateUserState: (next: UserState) => void;
  consoleFilter: ConsoleFilter;
  onConsoleFilterChange: (next: ConsoleFilter) => void;
  onJumpToConsole: (filter: Partial<ConsoleFilter>) => void;
}) {
  // The mock is deterministic per baseline, but it still walks all 457
  // recs — memoize so re-renders don't regenerate the result map.
  const scan = useMemo(() => mockScan(baseline), [baseline]);

  return (
    <div className="app">
      <header className="top-bar">
        <span className="brand">BaselineLens</span>
        <nav className="tabs" role="tablist">
          <button
            className="tab"
            role="tab"
            aria-selected={tab === "overview"}
            onClick={() => onTabChange("overview")}
          >
            Overview
          </button>
          <button
            className="tab"
            role="tab"
            aria-selected={tab === "console"}
            onClick={() => onTabChange("console")}
          >
            Console
          </button>
        </nav>
        <span className="top-bar-spacer" />
        <span className="host-pill mono">{scan.device.hostname}</span>
        <time className="last-scan-timestamp mono" dateTime={scan.startedAt}>
          {formatTimestamp(scan.startedAt)}
        </time>
        <button
          type="button"
          className="button-primary top-bar-action"
          disabled
        >
          Rescan
        </button>
        <SettingsMenu onChangeBaseline={onReparse} />
      </header>

      {isStale && <StaleBanner onReparse={onReparse} />}

      <main className="tab-content">
        {tab === "overview" ? (
          <Overview
            baseline={baseline}
            scan={scan}
            userState={userState}
            onJumpToConsole={onJumpToConsole}
          />
        ) : (
          <Console
            baseline={baseline}
            scan={scan}
            userState={userState}
            filter={consoleFilter}
            onFilterChange={onConsoleFilterChange}
            onUpdateUserState={onUpdateUserState}
          />
        )}
      </main>
    </div>
  );
}

/**
 * Settings popover anchored to the gear button in the top bar. For now
 * the only item is "Change baseline"; future preferences (theme, etc.)
 * will land here too. Closes on click-outside, Esc, or selecting an item.
 */
function SettingsMenu({ onChangeBaseline }: { onChangeBaseline: () => void }) {
  const [open, setOpen] = useState(false);
  const wrapperRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onMouseDown(e: MouseEvent) {
      if (!wrapperRef.current?.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onMouseDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onMouseDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  return (
    <div className="settings-wrapper" ref={wrapperRef}>
      <button
        type="button"
        className="icon-button"
        onClick={() => setOpen((current) => !current)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Settings"
      >
        <GearIcon />
      </button>
      {open && (
        <div className="settings-menu" role="menu">
          <button
            type="button"
            role="menuitem"
            className="settings-item"
            onClick={() => {
              setOpen(false);
              onChangeBaseline();
            }}
          >
            Change baseline
          </button>
        </div>
      )}
    </div>
  );
}

function GearIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  );
}

function formatTimestamp(iso: string): string {
  // YYYY-MM-DD HH:MM — terse, mono, sortable.
  return iso.slice(0, 16).replace("T", " ");
}

function StaleBanner({ onReparse }: { onReparse: () => void }) {
  return (
    <div className="stale-banner" role="status">
      <WarnIcon />
      <span className="stale-banner-message">
        Parser updated since this baseline was cached. Re-parse to pick up
        the new fields.
      </span>
      <button className="stale-banner-action" onClick={onReparse}>
        Re-parse
      </button>
    </div>
  );
}

function WarnIcon() {
  return (
    <svg
      className="stale-banner-icon"
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      aria-hidden="true"
    >
      <path
        d="M8 1.5 L14.5 13.5 L1.5 13.5 Z"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
      <line
        x1="8"
        y1="6"
        x2="8"
        y2="9.5"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
      <circle cx="8" cy="11.5" r="0.85" fill="currentColor" />
    </svg>
  );
}

export default App;
