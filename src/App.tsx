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
  type Scan,
  type ScanContext,
  type ScanLoadErrors,
  type ScanRecord,
  type ScanResult,
  type Density,
  type Preferences,
  type Theme,
  type TimeFormat,
  type UserState,
} from "./bindings";
import Console from "./Console";
import { EmptyScanState } from "./app/EmptyScanState";
import { SettingsMenu } from "./app/SettingsMenu";
import { ScanErrorBanner, StaleBanner } from "./app/banners";
import {
  loadOrInitUserState,
  parseAtPath,
  restoreFromCache,
  type AppState,
} from "./data/appState";
import {
  defaultConsoleColumns,
  type ConsoleColumns,
} from "./data/consoleColumns";
import {
  defaultConsoleFilter,
  type ConsoleFilter,
} from "./data/consoleFilter";
import {
  formatTimestamp,
  setTimeFormat as applyTimeFormat,
} from "./format";
import Onboarding from "./Onboarding";
import Overview from "./Overview";

import "./App.css";

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

// Display string of `AuditError::Cancelled` in
// src-tauri/src/audit/error.rs. A cancelled run is the only failed
// outcome that shouldn't raise an error banner; the backend resolves
// the true reason (so e.g. a denied elevation wins over a pending
// cancel), so the decision keys off what it returned, not whether the
// user happened to click Cancel.
const SCAN_CANCELLED_MESSAGE = "Scan cancelled.";

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
  // Synchronous re-entry guard: blocks a second rescan() fired before
  // React re-renders the button out of its "Rescan" state, so a fast
  // double-click starts exactly one scan.
  const rescanInFlight = useRef(false);
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
    if (scanning || rescanInFlight.current) return;
    rescanInFlight.current = true;
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
      if (result.error === SCAN_CANCELLED_MESSAGE) {
        // Backend resolved this as a genuine cancel: not a failure, so
        // no error banner — the dashboard just returns to the prior
        // scan. Any other error (e.g. elevation denied) still surfaces
        // even when the user also clicked Cancel, since the cancel
        // didn't cause it.
        console.info("Scan cancelled by user.");
      } else {
        console.error("Scan failed:", result.error);
        setScanError(result.error);
      }
    }
    cancelRequested.current = false;
    setCancelling(false);
    setScanning(false);
    rescanInFlight.current = false;
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
        {!scanning ? (
          <button
            type="button"
            className="button-primary top-bar-action"
            onClick={() => void rescan()}
          >
            Rescan
          </button>
        ) : completed === 0 ? (
          // Scan kicked off but not yet running (waiting on the UAC
          // prompt / script startup). No Cancel is armed: there's
          // nothing to cancel, and it stops a fast double-click on
          // Rescan from firing an unintended cancel.
          <span className="top-bar-scan-status mono" aria-live="polite">
            Starting…
          </span>
        ) : (
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

export default App;
