import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";

import { open } from "@tauri-apps/plugin-dialog";

import {
  commands,
  type DeviceInfo,
  type Density,
  type Preferences,
  type Theme,
  type TimeFormat,
  type UserState,
} from "./bindings";
import { Dashboard, type Tab } from "./app/Dashboard";
import {
  PreferencesProvider,
  type PreferencesContextValue,
} from "./app/PreferencesContext";
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
import { setTimeFormat as applyTimeFormat } from "./format";
import Onboarding from "./Onboarding";

import "./App.css";

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
    const root = document.documentElement;
    function apply(resolved: "light" | "dark") {
      // Swap the theme with transitions suppressed so theme-colored
      // properties recolor instantly. Without this, any element with a
      // color/background transition (there for hover/focus) animates the
      // recolor over its duration and visibly lags behind the rest of
      // the UI. Re-enable after the new colors paint so hover/focus
      // transitions still work — two frames to be sure the swap committed.
      root.classList.add("theme-instant");
      root.dataset.theme = resolved;
      requestAnimationFrame(() => {
        requestAnimationFrame(() => root.classList.remove("theme-instant"));
      });
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
  // preference can't clobber its siblings. Stable identity (no deps but
  // the always-stable `commands` import) so the preference setters and
  // the context value below stay memoizable.
  const persistPreferences = useCallback(async (patch: Partial<Preferences>) => {
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
  }, []);

  // Persists a theme change to app_state.json (canonical) and writes a
  // localStorage mirror so the pre-paint script in index.html can apply
  // the same value on the next launch without an IPC round-trip.
  const updateTheme = useCallback(
    (next: Theme) => {
      setTheme(next);
      try {
        localStorage.setItem("theme", next);
      } catch {
        // Storage can fail in locked-down contexts; the in-memory + Rust
        // copies still drive the active session.
      }
      void persistPreferences({ theme: next });
    },
    [persistPreferences],
  );

  // Applies a clock-format change immediately (the module mirror so
  // timestamps re-render in the new format) and persists it.
  const updateTimeFormat = useCallback(
    (next: TimeFormat) => {
      applyTimeFormat(next);
      setTimeFormatState(next);
      void persistPreferences({ timeFormat: next });
    },
    [persistPreferences],
  );

  const updateDensity = useCallback(
    (next: Density) => {
      setDensityState(next);
      void persistPreferences({ density: next });
    },
    [persistPreferences],
  );

  // Bundled for PreferencesContext. Memoized so a frequent App re-render
  // (e.g. typing in the Console search updates `consoleFilter` here)
  // doesn't hand consumers a fresh object and re-render them needlessly.
  const preferences = useMemo<PreferencesContextValue>(
    () => ({
      theme,
      timeFormat,
      density,
      setTheme: updateTheme,
      setTimeFormat: updateTimeFormat,
      setDensity: updateDensity,
    }),
    [theme, timeFormat, density, updateTheme, updateTimeFormat, updateDensity],
  );

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
      <PreferencesProvider value={preferences}>
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
        />
      </PreferencesProvider>
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

export default App;
