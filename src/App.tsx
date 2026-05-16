import {
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type KeyboardEvent as ReactKeyboardEvent,
  type SetStateAction,
} from "react";

import { Channel } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";

import {
  commands,
  type Baseline,
  type DeviceInfo,
  type ParserProgress,
  type Scan,
  type ScanContext,
  type ScanLoadErrors,
  type ScanRecord,
  type ScanResult,
  type BaselineSource,
  type Density,
  type Preferences,
  type Theme,
  type TimeFormat,
  type UserState,
} from "./bindings";
import Console from "./Console";
import {
  defaultConsoleColumns,
  type ConsoleColumns,
} from "./data/consoleColumns";
import {
  defaultConsoleFilter,
  type ConsoleFilter,
} from "./data/consoleFilter";
import ConfirmDialog from "./ConfirmDialog";
import {
  formatDate,
  formatTimestamp,
  setTimeFormat as applyTimeFormat,
} from "./format";
import Onboarding from "./Onboarding";
import Overview from "./Overview";
import SettingSegment from "./SettingSegment";
import ThemeSegment from "./ThemeSegment";

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
      /** One-shot signal: kick off a scan as soon as the dashboard
       * mounts. Set by the onboarding "Scan this device" button so the
       * user doesn't have to click again on the empty state. Dashboard
       * guards against repeated firing via a ref. */
      autoScan?: boolean;
    };

type Tab = "overview" | "console";

function App() {
  // Start in "loading" until the cache restore finishes — without this
  // initial state we'd flash the welcome screen on every cold launch.
  const [appState, setAppState] = useState<AppState>({ kind: "loading" });
  const [tab, setTab] = useState<Tab>("overview");
  // Theme is seeded from the synchronous localStorage mirror so initial
  // render matches what the pre-paint script in index.html already applied
  // to <html>. The canonical value is loaded from app_state.json below
  // and overwrites this if it differs.
  const [theme, setTheme] = useState<Theme>(readStoredTheme);
  // Clock format for rendered timestamps. Unlike theme it needs no
  // pre-paint localStorage mirror (no CSS hook, and the dashboard isn't
  // shown until the cache restore that loads the real value completes).
  // Mirrored into the format module so `formatTimestamp` reads it
  // without every caller having to thread it through.
  const [timeFormat, setTimeFormatState] = useState<TimeFormat>("24h");
  // Console table row spacing. Pure CSS concern (applied as a
  // data-density attribute), so no module mirror like time format.
  const [density, setDensityState] = useState<Density>("comfortable");
  const [consoleFilter, setConsoleFilter] = useState<ConsoleFilter>(
    defaultConsoleFilter,
  );
  const [consoleColumns, setConsoleColumns] = useState<ConsoleColumns>(
    defaultConsoleColumns,
  );
  // Whether the Console's Views/Categories rail is collapsed. Lives at
  // the App level so the user's choice survives tab switches.
  const [consoleRailCollapsed, setConsoleRailCollapsed] = useState(false);
  // Device identity (hostname, OS, management state) for the onboarding
  // "Will scan" strip and the partial-scan placeholder. Loaded async on
  // mount; falls back to empty fields while in-flight so the strip
  // layout stays stable instead of popping when data arrives.
  const [deviceInfo, setDeviceInfo] = useState<DeviceInfo | null>(null);

  useEffect(() => {
    void restoreFromCache(
      setAppState,
      setTheme,
      setTimeFormatState,
      setDensityState,
    );
    void (async () => {
      const result = await commands.getDeviceInfo();
      if (result.status === "ok") setDeviceInfo(result.data);
      else console.error("Failed to read device info:", result.error);
    })();
  }, []);

  // Applies the active theme to <html data-theme="..."> and follows the
  // OS preference when set to "system". Runs on every theme change and
  // re-subscribes the matchMedia listener accordingly.
  useEffect(() => {
    function apply(resolved: "light" | "dark") {
      document.documentElement.dataset.theme = resolved;
    }
    if (theme === "system") {
      const query = window.matchMedia("(prefers-color-scheme: dark)");
      apply(query.matches ? "dark" : "light");
      const listener = (event: MediaQueryListEvent) => {
        apply(event.matches ? "dark" : "light");
      };
      query.addEventListener("change", listener);
      return () => query.removeEventListener("change", listener);
    }
    apply(theme);
  }, [theme]);

  // Merges a preference patch into app_state.json. Loads the current
  // state first and spreads the existing preferences so writing one
  // preference can't clobber its siblings.
  async function persistPreferences(patch: Partial<Preferences>) {
    const current = await commands.loadAppState();
    const base = current.status === "ok" && current.data
      ? current.data
      : { activeBaselineSha: null };
    const result = await commands.saveAppState({
      ...base,
      preferences: { ...base.preferences, ...patch },
    });
    if (result.status !== "ok") {
      console.error("Failed to save preferences:", result.error);
    }
  }

  // Persists a theme change to app_state.json (canonical) and writes a
  // localStorage mirror so the pre-paint script in index.html can apply
  // the same value on the next launch without an IPC round-trip.
  function updateTheme(next: Theme) {
    setTheme(next);
    try {
      localStorage.setItem("theme", next);
    } catch {
      // Storage can fail in locked-down contexts; the in-memory + Rust
      // copies still drive the active session.
    }
    void persistPreferences({ theme: next });
  }

  // Applies a clock-format change immediately (the module mirror so
  // timestamps re-render in the new format) and persists it.
  function updateTimeFormat(next: TimeFormat) {
    applyTimeFormat(next);
    setTimeFormatState(next);
    void persistPreferences({ timeFormat: next });
  }

  function updateDensity(next: Density) {
    setDensityState(next);
    void persistPreferences({ density: next });
  }

  // Applies a UserState change locally and persists it. The optimistic
  // update keeps the UI snappy; the returned boolean lets the caller
  // (the drawer) show a real outcome instead of a blanket "Saved" —
  // a false return means the in-memory state is ahead of disk.
  async function updateUserState(next: UserState): Promise<boolean> {
    setAppState((prev) =>
      prev.kind === "loaded" ? { ...prev, userState: next } : prev,
    );
    const result = await commands.saveUserState(next);
    if (result.status !== "ok") {
      console.error("Failed to save user state:", result.error);
      return false;
    }
    return true;
  }

  // Clears scans + history + annotations for the active baseline but
  // leaves it loaded. The user_state file is gone afterward, so reload
  // it (now empty) and sync into appState; the caller refreshes the
  // scan context for the rest.
  async function clearActiveBaselineData(): Promise<void> {
    if (appState.kind !== "loaded") return;
    const sha = appState.baseline.source.pdfSha256;
    const result = await commands.clearBaselineData(sha);
    if (result.status !== "ok") {
      console.error("Failed to clear baseline data:", result.error);
      return;
    }
    const fresh = await loadOrInitUserState(sha);
    setAppState((prev) =>
      prev.kind === "loaded" ? { ...prev, userState: fresh } : prev,
    );
  }

  // Removes the active baseline wholesale and drops back to onboarding.
  async function removeActiveBaseline(): Promise<void> {
    if (appState.kind !== "loaded") return;
    const sha = appState.baseline.source.pdfSha256;
    const result = await commands.removeBaseline(sha);
    if (result.status !== "ok") {
      console.error("Failed to remove baseline:", result.error);
      return;
    }
    setAppState({ kind: "onboarding" });
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
        autoScan={appState.autoScan ?? false}
        deviceInfo={deviceInfo}
        tab={tab}
        onTabChange={setTab}
        onReparse={() => void selectAndParse(setAppState)}
        onClearBaselineData={clearActiveBaselineData}
        onRemoveBaseline={removeActiveBaseline}
        onUpdateUserState={updateUserState}
        consoleFilter={consoleFilter}
        onConsoleFilterChange={setConsoleFilter}
        consoleColumns={consoleColumns}
        onConsoleColumnsChange={setConsoleColumns}
        consoleRailCollapsed={consoleRailCollapsed}
        onConsoleRailCollapsedChange={setConsoleRailCollapsed}
        onJumpToConsole={jumpToConsole}
        theme={theme}
        onThemeChange={updateTheme}
        timeFormat={timeFormat}
        onTimeFormatChange={updateTimeFormat}
        density={density}
        onDensityChange={updateDensity}
      />
    );
  }
  return (
    <Onboarding
      state={appState}
      deviceInfo={deviceInfo}
      theme={theme}
      onThemeChange={(next) => void updateTheme(next)}
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
          autoScan: true,
        });
      }}
      onCancel={() => setAppState({ kind: "onboarding" })}
    />
  );
}

/**
 * Reads the synchronous localStorage mirror of the theme preference.
 * Validates the stored string against the `Theme` union so a stray edit
 * to localStorage can't push an unknown value into state. Defaults to
 * `"system"` when no entry is set yet.
 */
function readStoredTheme(): Theme {
  try {
    const raw = localStorage.getItem("theme");
    if (raw === "light" || raw === "dark" || raw === "system") return raw;
  } catch {
    // Inaccessible storage falls through to the default.
  }
  return "system";
}

/**
 * Reads `app_state.json` on mount and rehydrates the dashboard from the
 * cached `Baseline` and its `UserState`. Falls back to the onboarding
 * screen when nothing is cached or the cached entry can't be loaded.
 * Also syncs the theme, time-format, and density preferences from the
 * canonical store into the in-memory state (and, for theme, the
 * localStorage mirror).
 */
async function restoreFromCache(
  setAppState: Dispatch<SetStateAction<AppState>>,
  setTheme: Dispatch<SetStateAction<Theme>>,
  setTimeFormatState: Dispatch<SetStateAction<TimeFormat>>,
  setDensityState: Dispatch<SetStateAction<Density>>,
) {
  const persisted = await commands.loadAppState();
  if (persisted.status !== "ok") {
    setAppState({ kind: "error", message: persisted.error, fileName: null });
    return;
  }
  const storedTheme = persisted.data?.preferences?.theme;
  if (storedTheme) {
    setTheme(storedTheme);
    try {
      localStorage.setItem("theme", storedTheme);
    } catch {
      // Same fallthrough as above — locked-down storage just skips the
      // mirror; the in-memory copy still drives the active session.
    }
  }
  const storedTimeFormat = persisted.data?.preferences?.timeFormat;
  if (storedTimeFormat) {
    setTimeFormatState(storedTimeFormat);
    applyTimeFormat(storedTimeFormat);
  }
  const storedDensity = persisted.data?.preferences?.density;
  if (storedDensity) {
    setDensityState(storedDensity);
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
  autoScan,
  deviceInfo,
  tab,
  onTabChange,
  onReparse,
  onClearBaselineData,
  onRemoveBaseline,
  onUpdateUserState,
  consoleFilter,
  onConsoleFilterChange,
  consoleColumns,
  onConsoleColumnsChange,
  consoleRailCollapsed,
  onConsoleRailCollapsedChange,
  onJumpToConsole,
  theme,
  onThemeChange,
  timeFormat,
  onTimeFormatChange,
  density,
  onDensityChange,
}: {
  baseline: Baseline;
  userState: UserState;
  isStale: boolean;
  /** When true, kicks off a scan as soon as the dashboard mounts — set
   * by the onboarding confirm so the user doesn't see the empty state
   * before their first scan. Guarded by a ref so it only fires once. */
  autoScan: boolean;
  /** Real device identity for the partial-scan placeholder. Null while
   * the initial fetch is in-flight; in practice the fetch finishes long
   * before the user can trigger a scan, so the fallback values are
   * almost never seen. */
  deviceInfo: DeviceInfo | null;
  tab: Tab;
  onTabChange: (tab: Tab) => void;
  onReparse: () => void;
  /** Clears the active baseline's scans/history/annotations; it stays
   * loaded. App reloads userState; Dashboard refreshes scan context. */
  onClearBaselineData: () => Promise<void>;
  /** Removes the active baseline entirely; App routes to onboarding. */
  onRemoveBaseline: () => Promise<void>;
  onUpdateUserState: (next: UserState) => Promise<boolean>;
  consoleFilter: ConsoleFilter;
  onConsoleFilterChange: (next: ConsoleFilter) => void;
  consoleColumns: ConsoleColumns;
  onConsoleColumnsChange: (next: ConsoleColumns) => void;
  consoleRailCollapsed: boolean;
  onConsoleRailCollapsedChange: (next: boolean) => void;
  onJumpToConsole: (filter: Partial<ConsoleFilter>) => void;
  theme: Theme;
  onThemeChange: (next: Theme) => void;
  timeFormat: TimeFormat;
  onTimeFormatChange: (next: TimeFormat) => void;
  density: Density;
  onDensityChange: (next: Density) => void;
}) {
  const [context, setContext] = useState<ScanContext>(emptyScanContext);
  // App version for the settings readout. Fetched once; the command is
  // a constant so there's no need to refetch.
  const [appVersion, setAppVersion] = useState("");
  useEffect(() => {
    void commands.appVersion().then(setAppVersion);
  }, []);
  const [loadErrors, setLoadErrors] = useState<ScanLoadErrors>(emptyLoadErrors);
  const [scanning, setScanning] = useState(false);
  const [scanError, setScanError] = useState<string | null>(null);
  // Set when the user clicks Cancel so the scan's error return is read
  // as an intentional stop (no error banner) rather than a failure.
  const cancelRequested = useRef(false);
  const [cancelling, setCancelling] = useState(false);
  // Records processed in the current run. Tracked independently of
  // `latest.results` because `latest` stays the prior completed scan
  // until the first new record swaps in the partial — reading its
  // result count would show the bar full before the run produces
  // anything.
  const [scanProgress, setScanProgress] = useState(0);

  const latest = context.latest;

  // One-shot guard so `autoScan` only fires the kick-off rescan once
  // per loaded session, even if `autoScan` stays true across re-renders.
  const autoScanFired = useRef(false);

  // Roving-tabindex targets so ArrowLeft/Right between tabs also moves
  // focus, per the WAI-ARIA tabs pattern.
  const tabRefs = useRef<Record<Tab, HTMLButtonElement | null>>({
    overview: null,
    console: null,
  });

  // Load scan context for this baseline on mount and whenever the
  // baseline switches. Each sub-file's load status lands in `loadErrors`
  // so failures degrade per-surface (empty state for a broken `latest`,
  // inline notice on the trend chart for broken `summaries`, etc.) — no
  // dashboard-wide banner. When `autoScan` is set (onboarding's "Scan
  // this device" confirm — an explicit request to scan now), the same
  // effect kicks off a scan once the load completes, even if the chosen
  // baseline already has a cached scan: the button says "Scan this
  // device", so changing to a previously-scanned baseline must still
  // scan rather than land on the stale result.
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
      if (autoScan && !autoScanFired.current) {
        autoScanFired.current = true;
        void rescan();
      }
    })();
    return () => {
      cancelled = true;
    };
  // rescan is declared in the same function body via `function` and
  // captures current state via closure; we intentionally fire it only
  // when baseline or autoScan changes.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [baseline, autoScan]);

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

  // "Clear all results & notes": App drops the annotations + persisted
  // data, then we refresh the scan context so the surface empties
  // without a relaunch. The baseline stays loaded.
  async function clearAllData() {
    await onClearBaselineData();
    setScanError(null);
    await refreshContext();
  }

  // Asks the backend to stop the in-flight scan. The script halts at
  // its next recommendation boundary; `rescan` then sees a cancelled
  // result and restores the prior scan without flagging an error.
  async function requestCancel() {
    if (!scanning || cancelRequested.current) return;
    cancelRequested.current = true;
    setCancelling(true);
    const result = await commands.cancelScan();
    if (result.status !== "ok") {
      console.error("Failed to signal scan cancellation:", result.error);
    }
  }

  async function rescan() {
    if (scanning) return;
    setScanning(true);
    setScanError(null);
    setScanProgress(0);
    cancelRequested.current = false;
    setCancelling(false);
    // Capture the current latest so a failed run can restore it. The
    // backend doesn't write anything until the scan succeeds, so the
    // pre-rescan `latest` is still the source of truth on disk; we just
    // need to mirror that in memory if the run aborts.
    const previousLatest = context.latest;
    // The partial Scan is built up front but only committed once the
    // first result arrives — see the channel handler. A run that fails
    // before emitting anything (UAC denied, script error) then never
    // flips the dashboard out of its current view, so there's no flash
    // of empty L1/L2/BL cards before falling back.
    const partial = makePartialScan(baseline, deviceInfo);
    const channel = new Channel<ScanRecord>();
    channel.onmessage = (record) => {
      setScanProgress((done) => done + 1);
      setContext((prev) => {
        // First record: swap whatever's showing for the fresh partial
        // so stale results from a prior scan don't bleed into the new
        // run; `prev.latest === previousLatest` only holds until that
        // first swap, after which records merge into the partial.
        const live =
          !prev.latest || prev.latest === previousLatest
            ? partial
            : prev.latest;
        return {
          ...prev,
          latest: {
            ...live,
            results: {
              ...live.results,
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
      // Restore the prior latest — backend never wrote, so on-disk
      // truth is unchanged and the user shouldn't lose visibility on
      // their last successful scan just because this attempt failed.
      setContext((prev) => ({ ...prev, latest: previousLatest }));
      if (cancelRequested.current) {
        // User-initiated stop: not a failure, so no error banner —
        // the dashboard just returns to the prior scan.
        console.info("Scan cancelled by user.");
      } else {
        console.error("Scan failed:", result.error);
        setScanError(result.error);
      }
    }
    cancelRequested.current = false;
    setCancelling(false);
    setScanning(false);
  }

  const completed = scanProgress;
  const total = baseline.recommendations.length;
  const tabOrder: Tab[] = ["overview", "console"];
  const activePanelId = tab === "overview" ? "panel-overview" : "panel-console";
  const activeTabId = tab === "overview" ? "tab-overview" : "tab-console";

  function onTablistKeyDown(e: ReactKeyboardEvent) {
    if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
    e.preventDefault();
    const index = tabOrder.indexOf(tab);
    const step = e.key === "ArrowRight" ? 1 : -1;
    const next =
      tabOrder[(index + step + tabOrder.length) % tabOrder.length];
    onTabChange(next);
    tabRefs.current[next]?.focus();
  }

  return (
    <div className="app">
      <header className="top-bar">
        <span className="brand">BaselineLens</span>
        <div
          className="tabs"
          role="tablist"
          aria-label="Dashboard views"
          onKeyDown={onTablistKeyDown}
        >
          <button
            id="tab-overview"
            ref={(el) => {
              tabRefs.current.overview = el;
            }}
            className="tab"
            role="tab"
            aria-selected={tab === "overview"}
            aria-controls="panel-overview"
            tabIndex={tab === "overview" ? 0 : -1}
            onClick={() => onTabChange("overview")}
          >
            Overview
          </button>
          <button
            id="tab-console"
            ref={(el) => {
              tabRefs.current.console = el;
            }}
            className="tab"
            role="tab"
            aria-selected={tab === "console"}
            aria-controls="panel-console"
            tabIndex={tab === "console" ? 0 : -1}
            onClick={() => onTabChange("console")}
          >
            Console
          </button>
        </div>
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
        {scanning ? (
          <>
            <span
              className="top-bar-scan-status mono"
              aria-live="polite"
            >
              {cancelling ? "Cancelling…" : `Scanning ${completed}/${total}`}
            </span>
            <button
              type="button"
              className="button-secondary top-bar-action"
              onClick={() => void requestCancel()}
              disabled={cancelling}
            >
              Cancel
            </button>
          </>
        ) : (
          <button
            type="button"
            className="button-primary top-bar-action"
            onClick={() => void rescan()}
          >
            Rescan
          </button>
        )}
        <SettingsMenu
          theme={theme}
          timeFormat={timeFormat}
          density={density}
          scanning={scanning}
          baselineSource={baseline.source}
          appVersion={appVersion}
          onThemeChange={onThemeChange}
          onTimeFormatChange={onTimeFormatChange}
          onDensityChange={onDensityChange}
          onChangeBaseline={onReparse}
          onResetLatest={() => void resetScanFile("latest")}
          onResetSummaries={() => void resetScanFile("summaries")}
          onResetChanges={() => void resetScanFile("changes")}
          onClearAll={() => void clearAllData()}
          onRemoveBaseline={() => void onRemoveBaseline()}
        />
      </header>

      {scanning && (
        <div
          className="scan-progress"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={total}
          aria-valuenow={completed}
          aria-label="Scan progress"
        >
          <div
            className="scan-progress-fill"
            style={{ width: `${total ? (completed / total) * 100 : 0}%` }}
          />
        </div>
      )}

      {isStale && <StaleBanner onReparse={onReparse} />}
      {scanError && (
        <ScanErrorBanner
          message={scanError}
          onResetSummaries={() => void resetScanFile("summaries")}
          onDismiss={() => setScanError(null)}
        />
      )}

      <main
        className="tab-content"
        role="tabpanel"
        id={activePanelId}
        aria-labelledby={activeTabId}
        tabIndex={0}
      >
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
            appVersion={appVersion}
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
            columns={consoleColumns}
            onColumnsChange={onConsoleColumnsChange}
            railCollapsed={consoleRailCollapsed}
            onRailCollapsedChange={onConsoleRailCollapsedChange}
            density={density}
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
 * Renders an empty Scan as the starting point for a live-filled scan.
 * Uses `deviceInfo` (from the app's initial `get_device_info` fetch) so
 * the top-bar host pill shows the real hostname during the run. Falls
 * back to empty fields if the device-info fetch hasn't landed yet — in
 * practice it has, since the fetch starts on app mount.
 *
 * `parserVersion` mirrors the loaded baseline; `auditScriptVersion` is
 * empty until the backend's final Scan replaces this partial — the
 * partial isn't persisted, and any cross-scan UI (deltas, trend) gates
 * on `finishedAt` so the empty placeholder is never visible to derived
 * logic.
 */
function makePartialScan(baseline: Baseline, deviceInfo: DeviceInfo | null): Scan {
  return {
    baselineSha256: baseline.source.pdfSha256,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    device: deviceInfo ?? {
      hostname: "",
      osName: "",
      osVersion: "",
      osBuild: "",
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
      <span className="empty-scan-icon" aria-hidden="true">
        <ScanIcon />
      </span>
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
 * Settings popover anchored to the gear button in the top bar.
 * Grouped into Preferences (theme, time format, density), Baseline (a
 * read-only source readout + switch), and Data (open folder + the
 * destructive resets behind a disclosure). Closes on click-outside,
 * Esc, or selecting an item; arrow keys rove the action items. Reset
 * items prompt for confirmation since the user reaches them outside an
 * error context.
 */
type PendingConfirm = {
  title: string;
  message: string;
  confirmLabel: string;
  onConfirm: () => void;
};

const TIME_FORMAT_OPTIONS = ["24h", "12h"] as const;
const TIME_FORMAT_LABELS: Record<TimeFormat, string> = {
  "24h": "24-hour",
  "12h": "12-hour",
};

const DENSITY_OPTIONS = ["comfortable", "compact"] as const;
const DENSITY_LABELS: Record<Density, string> = {
  comfortable: "Comfortable",
  compact: "Compact",
};

function SettingsMenu({
  theme,
  timeFormat,
  density,
  scanning,
  baselineSource,
  appVersion,
  onThemeChange,
  onTimeFormatChange,
  onDensityChange,
  onChangeBaseline,
  onResetLatest,
  onResetSummaries,
  onResetChanges,
  onClearAll,
  onRemoveBaseline,
}: {
  theme: Theme;
  timeFormat: TimeFormat;
  density: Density;
  /** While a scan runs, baseline-switch and the destructive resets are
   * disabled — they'd race the in-flight run (re-parse swaps the
   * baseline out from under it; a reset clears files it's about to
   * rewrite). */
  scanning: boolean;
  /** Source metadata for the loaded baseline — surfaced read-only so
   * the user can see what they're being measured against. */
  baselineSource: BaselineSource;
  appVersion: string;
  onThemeChange: (next: Theme) => void;
  onTimeFormatChange: (next: TimeFormat) => void;
  onDensityChange: (next: Density) => void;
  onChangeBaseline: () => void;
  onResetLatest: () => void;
  onResetSummaries: () => void;
  onResetChanges: () => void;
  /** Clears scans + history + annotations; baseline stays loaded. */
  onClearAll: () => void;
  /** Removes the baseline entirely; app returns to onboarding. */
  onRemoveBaseline: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [confirm, setConfirm] = useState<PendingConfirm | null>(null);
  // The three destructive resets sit behind a disclosure so a stray
  // click near the gear can't wipe scan history.
  const [resetsOpen, setResetsOpen] = useState(false);
  const [dataError, setDataError] = useState<string | null>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

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

  function askConfirm(pending: PendingConfirm) {
    setOpen(false);
    setConfirm(pending);
  }

  async function openFolder() {
    setDataError(null);
    const result = await commands.openDataDir();
    if (result.status === "ok") setOpen(false);
    else setDataError(result.error);
  }

  // Roving focus across the action items (the menuitem buttons). The
  // segmented controls keep their own radiogroup behavior; arrows only
  // hop between the actionable rows so keyboard users aren't stuck
  // tabbing through everything.
  function onMenuKeyDown(e: ReactKeyboardEvent<HTMLDivElement>) {
    if (
      e.key !== "ArrowDown" &&
      e.key !== "ArrowUp" &&
      e.key !== "Home" &&
      e.key !== "End"
    ) {
      return;
    }
    const menu = menuRef.current;
    if (!menu) return;
    const items = Array.from(
      menu.querySelectorAll<HTMLButtonElement>(
        'button[role="menuitem"]:not(:disabled)',
      ),
    );
    if (items.length === 0) return;
    e.preventDefault();
    const current = items.indexOf(document.activeElement as HTMLButtonElement);
    let next: number;
    if (e.key === "Home") next = 0;
    else if (e.key === "End") next = items.length - 1;
    else if (e.key === "ArrowDown") {
      next = current < 0 ? 0 : Math.min(current + 1, items.length - 1);
    } else {
      next = current < 0 ? items.length - 1 : Math.max(current - 1, 0);
    }
    items[next]?.focus();
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
        <div
          className="settings-menu"
          role="menu"
          ref={menuRef}
          onKeyDown={onMenuKeyDown}
        >
          <span className="settings-group-label">Preferences</span>
          <div className="settings-section">
            <span className="settings-section-label">Appearance</span>
            <ThemeSegment theme={theme} onThemeChange={onThemeChange} />
          </div>
          <div className="settings-section">
            <span className="settings-section-label">Time format</span>
            <SettingSegment
              options={TIME_FORMAT_OPTIONS}
              labels={TIME_FORMAT_LABELS}
              value={timeFormat}
              ariaLabel="Time format"
              onChange={onTimeFormatChange}
            />
          </div>
          <div className="settings-section">
            <span className="settings-section-label">Density</span>
            <SettingSegment
              options={DENSITY_OPTIONS}
              labels={DENSITY_LABELS}
              value={density}
              ariaLabel="Table density"
              onChange={onDensityChange}
            />
          </div>

          <div className="settings-divider" role="separator" />

          <span className="settings-group-label">Baseline</span>
          <dl className="settings-meta">
            <dt>Benchmark</dt>
            <dd title={`Parsed from ${baselineSource.pdfFilename}`}>
              {baselineSource.benchmarkName} {baselineSource.benchmarkVersion}
            </dd>
          </dl>
          <button
            type="button"
            role="menuitem"
            className="settings-item settings-item-action"
            disabled={scanning}
            onClick={() => {
              setOpen(false);
              onChangeBaseline();
            }}
          >
            Change baseline
          </button>

          <div className="settings-divider" role="separator" />

          <span className="settings-group-label">Data</span>
          <button
            type="button"
            role="menuitem"
            className="settings-item"
            onClick={() => void openFolder()}
          >
            Open data folder
          </button>
          {dataError && (
            <p className="settings-error" role="alert">
              {dataError}
            </p>
          )}

          <button
            type="button"
            role="menuitem"
            className="settings-item settings-item-disclosure"
            aria-expanded={resetsOpen}
            onClick={() => setResetsOpen((current) => !current)}
          >
            Reset data{resetsOpen ? "" : "…"}
          </button>
          {resetsOpen && (
            <div className="settings-resets">
              {[
                {
                  title: "Clear last scan",
                  sub: "Removes the latest results; the next scan replaces them.",
                  confirm: {
                    title: "Clear last scan",
                    message:
                      "Deletes this baseline's most recent scan. The Overview and Console show no results until you run a new scan.",
                    confirmLabel: "Clear last scan",
                    onConfirm: onResetLatest,
                  },
                },
                {
                  title: "Clear trend history",
                  sub: "Empties the Trend chart; it rebuilds from your next scan.",
                  confirm: {
                    title: "Clear trend history",
                    message:
                      "Deletes this baseline's saved scan summaries. The Trend chart empties and rebuilds from your next scan.",
                    confirmLabel: "Clear trend history",
                    onConfirm: onResetSummaries,
                  },
                },
                {
                  title: "Clear change history",
                  sub: "Clears the Recently-changed list and the Console's change markers.",
                  confirm: {
                    title: "Clear change history",
                    message:
                      "Deletes this baseline's change history. The 'Recently changed' section and the Console's improved/regressed markers clear until a future scan flips a recommendation.",
                    confirmLabel: "Clear change history",
                    onConfirm: onResetChanges,
                  },
                },
                {
                  title: "Clear all results & notes",
                  sub: "Deletes scans, history, exceptions, and notes for this baseline. The baseline stays loaded.",
                  confirm: {
                    title: "Clear all results & notes",
                    message:
                      "Permanently deletes this baseline's scans, trend history, change history, exceptions, and notes. The baseline stays loaded; the next scan starts fresh.",
                    confirmLabel: "Clear all",
                    onConfirm: onClearAll,
                  },
                },
                {
                  title: "Remove this baseline",
                  sub: "Deletes everything above and unloads the baseline — returns to onboarding.",
                  confirm: {
                    title: "Remove this baseline",
                    message:
                      "Returns you to onboarding and permanently deletes this baseline's scans, trend history, change history, exceptions, and notes, plus its parsed copy. Other baselines you've loaded are unaffected.",
                    confirmLabel: "Remove baseline",
                    onConfirm: onRemoveBaseline,
                  },
                },
              ].map((item) => (
                <button
                  key={item.title}
                  type="button"
                  role="menuitem"
                  className="settings-item settings-item-destructive settings-reset-item"
                  disabled={scanning}
                  onClick={() => askConfirm(item.confirm)}
                >
                  <span className="settings-reset-title">{item.title}</span>
                  <span className="settings-reset-sub">{item.sub}</span>
                </button>
              ))}
            </div>
          )}

          <p className="settings-about mono">
            Parsed {formatDate(baselineSource.parsedAt)} · App v
            {appVersion || "—"}
          </p>
        </div>
      )}
      {confirm && (
        <ConfirmDialog
          title={confirm.title}
          message={confirm.message}
          confirmLabel={confirm.confirmLabel}
          onConfirm={() => {
            confirm.onConfirm();
            setConfirm(null);
          }}
          onCancel={() => setConfirm(null)}
        />
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

/** Display with an inline scan-pulse — the empty-state mark for "no
 * scan yet / run a scan". Lucide-style 1.5px stroke to match the
 * other inline icons. */
function ScanIcon() {
  return (
    <svg
      width="44"
      height="44"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="2.5" y="4" width="19" height="13" rx="2" />
      <path d="M9 21h6" />
      <path d="M12 17v4" />
      <path d="M6 11h3l1.5-3 2 5 1.5-3H18" />
    </svg>
  );
}

export default App;
