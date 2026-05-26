import { useEffect, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";

import { Channel } from "@tauri-apps/api/core";

import {
  commands,
  type Baseline,
  type DeviceInfo,
  type Scan,
  type ScanContext,
  type ScanLoadErrors,
  type ScanRecord,
  type ScanResult,
  type UserState,
} from "../bindings";
import { type ConsoleColumns } from "../data/consoleColumns";
import { type ConsoleFilter } from "../data/consoleFilter";
import { formatTimestamp } from "../format";
import Console from "../Console";
import Overview from "../Overview";
import { EmptyScanState } from "./EmptyScanState";
import { SettingsMenu } from "./SettingsMenu";
import { ScanErrorBanner, StaleBanner } from "./banners";

export type Tab = "overview" | "console";

// Display string of `AuditError::Cancelled` in
// src-tauri/src/audit/error.rs. A cancelled run is the only failed
// outcome that shouldn't raise an error banner; the backend resolves
// the true reason (so e.g. a denied elevation wins over a pending
// cancel), so the decision keys off what it returned, not whether the
// user happened to click Cancel.
const SCAN_CANCELLED_MESSAGE = "Scan cancelled.";

/**
 * Post-load shell: top bar with tabs and the currently-active panel.
 * Owns the scan context — latest scan, change history, and trend
 * summaries — loaded from disk on mount and refreshed after each
 * rescan. `latest` drives what's rendered; the change history feeds the
 * delta indicators downstream. The baseline and userState come from the
 * parent so persistence stays the source of truth.
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

  // Session-only Console table column widths, keyed by column id. Held
  // here rather than in Console so a width survives switching to Overview
  // and back (Console unmounts on tab switch). Not persisted: a relaunch
  // or a new baseline returns columns to their defaults.
  const [columnWidths, setColumnWidths] = useState<Record<string, number>>({});

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
      // A genuine cancel isn't a failure — no banner, the dashboard just
      // returns to the prior scan. Any other error (e.g. elevation
      // denied) still surfaces even when the user also clicked Cancel,
      // since the cancel didn't cause it.
      if (result.error !== SCAN_CANCELLED_MESSAGE) {
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
  // All records are in, but the scan promise is still finishing (collecting,
  // persisting, IPC return). Show an indeterminate bar for that tail rather
  // than a determinate bar pinned at 100%.
  const finalizing = total > 0 && completed >= total;
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
          scanning={scanning}
          baselineSource={baseline.source}
          appVersion={appVersion}
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
          className={finalizing ? "scan-progress scan-progress--finalizing" : "scan-progress"}
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={total}
          aria-valuenow={finalizing ? undefined : completed}
          aria-label={finalizing ? "Finalizing scan" : "Scan progress"}
        >
          <div
            className="scan-progress-fill"
            style={finalizing ? undefined : { width: `${total ? (completed / total) * 100 : 0}%` }}
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
            columnWidths={columnWidths}
            onColumnWidthsChange={setColumnWidths}
            railCollapsed={consoleRailCollapsed}
            onRailCollapsedChange={onConsoleRailCollapsedChange}
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
 * 0 until the backend's final Scan replaces this partial — the
 * partial isn't persisted, and any cross-scan UI (deltas, trend) gates
 * on `finishedAt` so the placeholder is never visible to derived
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
    auditScriptVersion: 0,
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

export { Dashboard };
