import {
  useEffect,
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
  type Scan,
  type ScanContext,
  type ScanLoadErrors,
  type ScanRecord,
  type ScanResult,
  type UserState,
} from "./bindings";
import Console from "./Console";
import {
  defaultConsoleFilter,
  type ConsoleFilter,
} from "./data/consoleFilter";
import { TARGET_MACHINE } from "./data/host";
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
 * Owns the Scan history — loaded from disk on mount, appended on
 * rescan. `latest` drives the dashboard rendering; `prior` (if any) is
 * the comparison point for delta computation. The baseline and
 * userState come from the parent so persistence stays the source of
 * truth.
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
  const [context, setContext] = useState<ScanContext>(emptyScanContext);
  const [loadErrors, setLoadErrors] = useState<ScanLoadErrors>(emptyLoadErrors);
  const [scanning, setScanning] = useState(false);
  const [scanError, setScanError] = useState<string | null>(null);

  const latest = context.latest;

  // Load scan context for this baseline on mount and whenever the
  // baseline switches. Each sub-file's load status lands in `loadErrors`
  // so failures degrade per-surface (empty state for a broken `latest`,
  // inline notice on the trend chart for broken `summaries`, etc.) — no
  // dashboard-wide banner.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const result = await commands.loadScanContext(baseline.source.pdfSha256);
      if (cancelled) return;
      if (result.status === "ok") {
        setContext(result.data.context);
        setLoadErrors(result.data.errors);
      } else {
        setContext(emptyScanContext);
        setLoadErrors({
          latest: result.error,
          changes: result.error,
          summaries: result.error,
        });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [baseline]);

  async function refreshContext() {
    const result = await commands.loadScanContext(baseline.source.pdfSha256);
    if (result.status === "ok") {
      setContext(result.data.context);
      setLoadErrors(result.data.errors);
    } else {
      setLoadErrors({
        latest: result.error,
        changes: result.error,
        summaries: result.error,
      });
    }
  }

  // Deletes one of the regenerable scan-history files for the active
  // baseline and reloads the surface. The scan-aborted banner is
  // cleared on the way out — taking a recovery action implies the user
  // wants to move past the error message that prompted it.
  async function resetScanFile(target: "latest" | "summaries" | "changes") {
    const sha = baseline.source.pdfSha256;
    const result =
      target === "latest"
        ? await commands.resetLatestScan(sha)
        : target === "summaries"
          ? await commands.resetSummaries(sha)
          : await commands.resetChanges(sha);
    if (result.status !== "ok") {
      console.error(`Reset ${target} failed:`, result.error);
    }
    setScanError(null);
    await refreshContext();
  }

  async function rescan() {
    if (scanning) return;
    setScanning(true);
    setScanError(null);
    // Capture the current latest so a failed run can restore it. The
    // backend doesn't write anything until the scan succeeds, so the
    // pre-rescan `latest` is still the source of truth on disk; we just
    // need to mirror that in memory if the run aborts.
    const previousLatest = context.latest;
    // Drop into a partial Scan immediately so the dashboard switches
    // out of the empty state; channel messages fill `results`
    // row-by-row. Once the scan completes we re-fetch the whole context
    // for a clean sync.
    setContext((prev) => ({ ...prev, latest: makePartialScan(baseline) }));
    const channel = new Channel<ScanRecord>();
    channel.onmessage = (record) => {
      setContext((prev) => {
        if (!prev.latest) return prev;
        return {
          ...prev,
          latest: {
            ...prev.latest,
            results: {
              ...prev.latest.results,
              [record.id]: scanRecordToResult(record),
            },
          },
        };
      });
    };
    const result = await commands.startScan(baseline, channel);
    if (result.status === "ok") {
      // Re-fetch context so latest, changes, and summaries are all in
      // sync with what the backend just persisted. Cheap on a
      // single-device app; saves us reproducing the diff logic
      // client-side.
      const refreshed = await commands.loadScanContext(baseline.source.pdfSha256);
      if (refreshed.status === "ok") {
        setContext(refreshed.data.context);
        setLoadErrors(refreshed.data.errors);
      } else {
        // Backend wrote successfully but reload failed — leave the
        // partial in place so the user still sees their just-completed
        // scan, and surface the reload error so they know history
        // didn't refresh.
        setLoadErrors((prev) => ({ ...prev, latest: refreshed.error }));
      }
    } else {
      console.error("Scan failed:", result.error);
      // Restore the prior latest — backend never wrote, so on-disk
      // truth is unchanged and the user shouldn't lose visibility on
      // their last successful scan just because this attempt failed.
      setContext((prev) => ({ ...prev, latest: previousLatest }));
      setScanError(result.error);
    }
    setScanning(false);
  }

  const completed = latest ? Object.keys(latest.results).length : 0;
  const total = baseline.recommendations.length;
  const buttonLabel = scanning
    ? `Scanning ${completed}/${total}`
    : "Rescan";

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
        {latest && (
          <>
            <span className="host-pill mono">{latest.device.hostname}</span>
            <time
              className="last-scan-timestamp mono"
              dateTime={latest.startedAt}
            >
              {formatTimestamp(latest.startedAt)}
            </time>
          </>
        )}
        <button
          type="button"
          className="button-primary top-bar-action"
          onClick={() => void rescan()}
          disabled={scanning}
        >
          {buttonLabel}
        </button>
        <SettingsMenu
          onChangeBaseline={onReparse}
          onResetLatest={() => void resetScanFile("latest")}
          onResetSummaries={() => void resetScanFile("summaries")}
          onResetChanges={() => void resetScanFile("changes")}
        />
      </header>

      {isStale && <StaleBanner onReparse={onReparse} />}
      {scanError && (
        <ScanErrorBanner
          message={scanError}
          onResetSummaries={() => void resetScanFile("summaries")}
          onDismiss={() => setScanError(null)}
        />
      )}

      <main className="tab-content">
        {!latest ? (
          <EmptyScanState
            onScan={() => void rescan()}
            disabled={scanning}
            loadError={loadErrors.latest}
            onResetLatest={() => void resetScanFile("latest")}
          />
        ) : tab === "overview" ? (
          <Overview
            baseline={baseline}
            scan={latest}
            changes={context.changes}
            summaries={context.summaries}
            loadErrors={loadErrors}
            userState={userState}
            onJumpToConsole={onJumpToConsole}
            onResetSummaries={() => void resetScanFile("summaries")}
            onResetChanges={() => void resetScanFile("changes")}
          />
        ) : (
          <Console
            baseline={baseline}
            scan={latest}
            changes={context.changes}
            loadErrors={loadErrors}
            userState={userState}
            filter={consoleFilter}
            onFilterChange={onConsoleFilterChange}
            onUpdateUserState={onUpdateUserState}
            onResetChanges={() => void resetScanFile("changes")}
          />
        )}
      </main>
    </div>
  );
}

const emptyScanContext: ScanContext = {
  latest: null,
  changes: [],
  summaries: [],
};

const emptyLoadErrors: ScanLoadErrors = {
  latest: null,
  changes: null,
  summaries: null,
};

/**
 * Renders an empty Scan with placeholder device info — used as the
 * starting point for a live-filled scan. The top-bar host pill shows
 * the local mock hostname during the run until the backend's real
 * device info lands on completion.
 *
 * `parserVersion` mirrors the loaded baseline; `auditScriptVersion` is
 * empty until the backend's final Scan replaces this partial — the
 * partial isn't persisted, and any cross-scan UI (deltas, trend) gates
 * on `finishedAt` so the empty placeholder is never visible to derived
 * logic.
 */
function makePartialScan(baseline: Baseline): Scan {
  return {
    baselineSha256: baseline.source.pdfSha256,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    device: {
      hostname: TARGET_MACHINE.hostname,
      osName: TARGET_MACHINE.osName,
      osVersion: TARGET_MACHINE.osVersion,
      osBuild: TARGET_MACHINE.osBuild,
      managedBy: { intune: false, groupPolicy: false },
    },
    results: {},
    error: null,
    parserVersion: baseline.source.parserVersion,
    auditScriptVersion: "",
  };
}

function scanRecordToResult(record: ScanRecord): ScanResult {
  return {
    status: record.status,
    currentValue: record.currentValue,
    expected: record.expected,
    checks: record.checks,
    error: record.error,
    measuredAt: record.measuredAt,
  };
}

function EmptyScanState({
  onScan,
  disabled,
  loadError,
  onResetLatest,
}: {
  onScan: () => void;
  disabled: boolean;
  /** When the most-recent scan file failed to load, surface the error
   * inline so the user knows running a scan will overwrite it rather
   * than letting the failure stay invisible. */
  loadError?: string | null;
  /** Removes the unreadable scan file so the user doesn't have to open
   * the data folder to recover. Triggered from the inline action when
   * `loadError` is set. */
  onResetLatest: () => void;
}) {
  const title = loadError ? "Last scan couldn't be loaded" : "No scan yet";
  const body = loadError
    ? "The most-recent scan file for this baseline can't be read. Reset it (or run a new scan, which overwrites it) to continue."
    : "Run a scan to evaluate this device against the loaded baseline. Results stay on the device and are saved between launches.";
  return (
    <div className="empty-scan">
      <h2 className="empty-scan-title">{title}</h2>
      <p className="empty-scan-body">{body}</p>
      {loadError && <p className="empty-scan-error mono">{loadError}</p>}
      <div className="empty-scan-actions">
        <button
          type="button"
          className="button-primary"
          onClick={onScan}
          disabled={disabled}
        >
          Run scan
        </button>
        {loadError && (
          <button
            type="button"
            className="button-secondary"
            onClick={onResetLatest}
          >
            Reset last scan
          </button>
        )}
      </div>
    </div>
  );
}

/**
 * Settings popover anchored to the gear button in the top bar. Hosts
 * baseline-switching and the destructive reset actions for the active
 * baseline's scan-history files. Closes on click-outside, Esc, or
 * selecting an item. Reset items prompt for confirmation since the
 * user reaches them outside of an error context — without the prompt
 * a stray click could clear a working trend history.
 */
function SettingsMenu({
  onChangeBaseline,
  onResetLatest,
  onResetSummaries,
  onResetChanges,
}: {
  onChangeBaseline: () => void;
  onResetLatest: () => void;
  onResetSummaries: () => void;
  onResetChanges: () => void;
}) {
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

  function confirmAndRun(message: string, action: () => void) {
    setOpen(false);
    if (window.confirm(message)) {
      action();
    }
  }

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
          <div className="settings-divider" role="separator" />
          <button
            type="button"
            role="menuitem"
            className="settings-item settings-item-destructive"
            onClick={() =>
              confirmAndRun(
                "Delete the most-recent scan for this baseline? The next scan will replace it.",
                onResetLatest,
              )
            }
          >
            Reset last scan
          </button>
          <button
            type="button"
            role="menuitem"
            className="settings-item settings-item-destructive"
            onClick={() =>
              confirmAndRun(
                "Delete the trend history for this baseline? Past summary points will be lost; the next scan starts a fresh history.",
                onResetSummaries,
              )
            }
          >
            Reset trend history
          </button>
          <button
            type="button"
            role="menuitem"
            className="settings-item settings-item-destructive"
            onClick={() =>
              confirmAndRun(
                "Delete the change log for this baseline? Δ indicators clear until a future scan flips a rec again.",
                onResetChanges,
              )
            }
          >
            Reset change history
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

function ScanErrorBanner({
  message,
  onResetSummaries,
  onDismiss,
}: {
  message: string;
  onResetSummaries: () => void;
  onDismiss: () => void;
}) {
  // Today, summaries is the only file in the save path that's read
  // before being rewritten — so a save-time abort that names it is the
  // schema-drift case where "Reset trend history" recovers. Any other
  // cause (UAC denial, disk full, script failure, etc.) gets a plain
  // banner with no misleading recovery action. If more read-then-write
  // paths land later, extend this detection rather than asserting a
  // cause in the header.
  const isSummariesError = message.includes("summaries.json");
  return (
    <div className="stale-banner" role="alert">
      <WarnIcon />
      <div className="stale-banner-message">
        <span>Scan aborted.</span>
        <span className="stale-banner-detail mono">{message}</span>
      </div>
      {isSummariesError && (
        <button className="stale-banner-action" onClick={onResetSummaries}>
          Reset trend history
        </button>
      )}
      <button className="stale-banner-action-secondary" onClick={onDismiss}>
        Dismiss
      </button>
    </div>
  );
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
