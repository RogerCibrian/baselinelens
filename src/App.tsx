import {
  useEffect,
  useMemo,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";

import { Channel } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";

import {
  commands,
  type Baseline,
  type Level,
  type ParserProgress,
  type Scan,
  type UserState,
} from "./bindings";
import {
  scoresByLevel,
  weakestCategories,
  type CategoryScore,
  type LevelScore,
} from "./data/score";
import { mockScan } from "./fixtures/mockScan";

import "./App.css";

type AppState =
  | { kind: "loading" }
  | { kind: "noBaseline" }
  | { kind: "parsing"; path: string; progress: ParserProgress | null }
  | { kind: "error"; message: string }
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

  useEffect(() => {
    void restoreFromCache(setAppState);
  }, []);

  if (appState.kind === "loaded") {
    return (
      <Dashboard
        baseline={appState.baseline}
        userState={appState.userState}
        isStale={appState.isStale}
        tab={tab}
        onTabChange={setTab}
        onReparse={() => void reparse(appState.baseline, setAppState)}
      />
    );
  }
  return <Welcome state={appState} setAppState={setAppState} />;
}

/**
 * Reads `app_state.json` on mount and rehydrates the dashboard from the
 * cached `Baseline` and its `UserState`. Falls back to the file picker
 * when nothing is cached or the cached entry can't be loaded.
 */
async function restoreFromCache(setAppState: Dispatch<SetStateAction<AppState>>) {
  const persisted = await commands.loadAppState();
  if (persisted.status !== "ok") {
    setAppState({ kind: "error", message: persisted.error });
    return;
  }
  const sha = persisted.data?.activeBaselineSha;
  if (!sha) {
    setAppState({ kind: "noBaseline" });
    return;
  }
  const baselineResult = await commands.loadCachedBaseline(sha);
  if (baselineResult.status !== "ok") {
    setAppState({ kind: "error", message: baselineResult.error });
    return;
  }
  if (!baselineResult.data) {
    // app_state points at a SHA whose cache file is gone (manual deletion,
    // disk full at write time). Treat as "first launch" and show the picker.
    setAppState({ kind: "noBaseline" });
    return;
  }
  const { baseline, isStale } = baselineResult.data;
  const userState = await loadOrInitUserState(sha);
  setAppState({ kind: "loaded", baseline, userState, isStale });
}

/**
 * Re-parses the active baseline. Prefers the absolute path captured at
 * original parse time; falls back to the file picker when that path is
 * missing (older caches) — and the parse_baseline command itself surfaces
 * any error if the saved file has since been moved or deleted.
 */
async function reparse(
  baseline: Baseline,
  setAppState: Dispatch<SetStateAction<AppState>>,
) {
  const savedPath = baseline.source.pdfPath;
  if (savedPath) {
    await parseAtPath(savedPath, setAppState);
    return;
  }
  await selectAndParse(setAppState);
}

async function selectAndParse(setAppState: Dispatch<SetStateAction<AppState>>) {
  const path = await open({
    multiple: false,
    directory: false,
    filters: [{ name: "PDF", extensions: ["pdf"] }],
  });
  if (typeof path !== "string") return;
  await parseAtPath(path, setAppState);
}

async function parseAtPath(
  path: string,
  setAppState: Dispatch<SetStateAction<AppState>>,
) {
  const channel = new Channel<ParserProgress>();
  channel.onmessage = (progress) => {
    // Guard against late progress events: if the parse already resolved
    // (or errored) we've moved past "parsing" and shouldn't reopen it.
    setAppState((prev) =>
      prev.kind === "parsing" ? { ...prev, progress } : prev,
    );
  };
  setAppState({ kind: "parsing", path, progress: null });
  const result = await commands.parseBaseline(path, channel);
  if (result.status !== "ok") {
    setAppState({ kind: "error", message: result.error });
    return;
  }
  const baseline = result.data;
  const userState = await loadOrInitUserState(baseline.source.pdfSha256);
  // A fresh parse always produces output at the current PARSER_VERSION.
  setAppState({ kind: "loaded", baseline, userState, isStale: false });
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
 * Pre-load shell: shows the file picker, parse progress, and any
 * parse-error message. The post-load shell (`Dashboard`) takes over once
 * a baseline is in `loaded` state.
 */
function Welcome({
  state,
  setAppState,
}: {
  state: Exclude<AppState, { kind: "loaded" }>;
  setAppState: Dispatch<SetStateAction<AppState>>;
}) {
  return (
    <main className="welcome">
      <h1 className="serif">BaselineLens</h1>
      <p className="muted">
        Parse a CIS Microsoft Intune for Windows 11 Benchmark PDF and audit
        this device against it.
      </p>

      <button
        className="button-primary"
        onClick={() => void selectAndParse(setAppState)}
        disabled={state.kind === "parsing" || state.kind === "loading"}
      >
        {state.kind === "parsing" ? "Parsing…" : "Select PDF"}
      </button>

      {state.kind === "parsing" && (
        <ParseProgress path={state.path} progress={state.progress} />
      )}
      {state.kind === "error" && (
        <p className="error">Failed to parse: {state.message}</p>
      )}
    </main>
  );
}

function ParseProgress({
  path,
  progress,
}: {
  path: string;
  progress: ParserProgress | null;
}) {
  const fraction =
    progress?.stage === "classifying" && progress.total > 0
      ? progress.done / progress.total
      : null;

  return (
    <div className="progress">
      <p className="muted mono">{path}</p>
      <p>{stageLabel(progress)}</p>
      {fraction !== null ? (
        <div
          className="progress-bar"
          role="progressbar"
          aria-valuenow={Math.round(fraction * 100)}
          aria-valuemin={0}
          aria-valuemax={100}
        >
          <div
            className="progress-bar-fill"
            style={{ width: `${fraction * 100}%` }}
          />
        </div>
      ) : (
        <div className="progress-bar progress-bar-indeterminate">
          <div className="progress-bar-fill" />
        </div>
      )}
    </div>
  );
}

function stageLabel(progress: ParserProgress | null): string {
  if (progress === null) return "Starting…";
  switch (progress.stage) {
    case "readingFile":
      return "Reading file…";
    case "computingChecksum":
      return "Computing checksum…";
    case "extractingText":
      return "Extracting text from PDF…";
    case "slicingRecommendations":
      return "Slicing recommendations…";
    case "classifying":
      return `Classifying audit procedures (${progress.done} / ${progress.total})…`;
    case "complete":
      return "Done.";
  }
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
}: {
  baseline: Baseline;
  userState: UserState;
  isStale: boolean;
  tab: Tab;
  onTabChange: (tab: Tab) => void;
  onReparse: () => void;
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
      </header>

      {isStale && <StaleBanner onReparse={onReparse} />}

      <main className="tab-content">
        {tab === "overview" ? (
          <Overview baseline={baseline} scan={scan} userState={userState} />
        ) : (
          <Console baseline={baseline} scan={scan} />
        )}
      </main>
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

function Overview({
  baseline,
  scan,
  userState,
}: {
  baseline: Baseline;
  scan: Scan;
  userState: UserState;
}) {
  const levels = scoresByLevel(baseline, scan, userState);
  const weakest = weakestCategories(baseline, scan, userState, 6);
  return (
    <article className="overview">
      <header className="overview-header">
        <p className="eyebrow">
          Compliance report · <span className="mono">{formatDate(scan.startedAt)}</span>
        </p>
        <h1 className="serif overview-title">{baseline.source.benchmarkName}</h1>
        <p className="meta">
          <span className="mono">{scan.device.hostname}</span> ·{" "}
          {scan.device.osName} {scan.device.osVersion} ·{" "}
          {baseline.source.benchmarkVersion}
        </p>
      </header>

      <section className="overview-section">
        <h2 className="section-eyebrow">Score by level</h2>
        <div className="level-cards">
          {levels.map((score) => (
            <LevelCard key={score.level} score={score} />
          ))}
        </div>
      </section>

      <section className="overview-section">
        <h2 className="section-eyebrow">Weakest categories</h2>
        {weakest.length === 0 ? (
          <p className="muted">
            No categories with at least three in-scope recommendations.
          </p>
        ) : (
          <ul className="category-list">
            {weakest.map((cat) => (
              <CategoryRow key={cat.number} score={cat} />
            ))}
          </ul>
        )}
      </section>
    </article>
  );
}

function LevelCard({ score }: { score: LevelScore }) {
  const tone = toneFor(score.inScopePct);
  const inScopeText =
    score.inScopePct === null ? "—" : `${Math.round(score.inScopePct * 100)}%`;
  const inScopeDenom = score.total - score.manual;
  return (
    <div className="level-card">
      <div className="level-card-head">
        <span className={`level-chip level-${score.level.toLowerCase()}`}>
          {score.level}
        </span>
        <span className="level-card-name">{levelName(score.level)}</span>
      </div>
      <div className="level-card-numbers">
        <div>
          <span className="caption">In-scope</span>
          <span className={`level-pct serif tone-${tone}`}>{inScopeText}</span>
        </div>
        <div>
          <span className="caption">Full</span>
          <span className="level-full mono">
            {Math.round(score.fullPct * 100)}%
          </span>
        </div>
      </div>
      <p className="level-card-note muted mono">
        {score.pass + score.exception} of {inScopeDenom} in scope
      </p>
      <div className={`threshold-bar tone-${tone}`}>
        <div
          className="threshold-bar-fill"
          style={{ width: `${(score.inScopePct ?? 0) * 100}%` }}
        />
      </div>
    </div>
  );
}

function CategoryRow({ score }: { score: CategoryScore }) {
  const tone = toneFor(score.inScopePct);
  // Until the parser extracts category names, `name` is empty and we fall
  // back to the number — same render path either way.
  const label = score.name || score.number;
  return (
    <li>
      <span className="category-label">{label}</span>
      <span className="category-pct mono">
        {score.pass} / {score.inScope}
      </span>
      <div className={`category-bar tone-${tone}`}>
        <div
          className="category-bar-fill"
          style={{ width: `${score.inScopePct * 100}%` }}
        />
      </div>
    </li>
  );
}

function toneFor(pct: number | null): "pass" | "warn" | "fail" | "neutral" {
  if (pct === null) return "neutral";
  if (pct >= 0.8) return "pass";
  if (pct >= 0.5) return "warn";
  return "fail";
}

function levelName(level: Level): string {
  switch (level) {
    case "L1":
      return "Level 1";
    case "L2":
      return "Level 2";
    case "BL":
      return "BitLocker";
  }
}

function formatDate(iso: string): string {
  return iso.slice(0, 10);
}

function Console({ baseline, scan }: { baseline: Baseline; scan: Scan }) {
  const previewLimit = 50;
  const recs = baseline.recommendations.slice(0, previewLimit);
  return (
    <section>
      <h2 className="serif">Console</h2>
      <table className="rec-table">
        <thead>
          <tr>
            <th>ID</th>
            <th>Status</th>
            <th>Level</th>
            <th>Title</th>
          </tr>
        </thead>
        <tbody>
          {recs.map((rec) => (
            <tr key={rec.id}>
              <td className="mono">{rec.id}</td>
              <td>{scan.results[rec.id]?.status ?? "—"}</td>
              <td>{rec.level}</td>
              <td>{rec.title}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="muted">
        Showing first {previewLimit} of {baseline.recommendations.length}.
      </p>
    </section>
  );
}


export default App;
