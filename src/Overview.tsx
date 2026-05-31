import { useMemo } from "react";

import { openUrl } from "@tauri-apps/plugin-opener";

import type {
  Baseline,
  ChangeEvent,
  Scan,
  ScanLoadErrors,
  ScanSummary,
  UserState,
} from "./bindings";
import type { ConsoleFilter } from "./data/consoleFilter";
import { categoryScores, scoresByLevel, weakestCategories } from "./data/score";
import { formatDate } from "./format";
import { CategoryRow } from "./overview/CategoryRow";
import { DocSection } from "./overview/DocSection";
import { HeadlineFacts, HeadlineH1 } from "./overview/Headline";
import { LevelCard } from "./overview/LevelCard";
import { RecentlyChangedColumn } from "./overview/RecentlyChangedColumn";
import { TrendChart } from "./overview/TrendChart";
import {
  buildHeadline,
  type Headline,
  levelName,
  passPctOf,
  recentChanges,
  type TrendPoint,
} from "./overview/util";

const TREND_CHART_POINTS = 6;
const WEAK_CATEGORY_THRESHOLD = 0.5;
const ISSUES_URL = "https://github.com/RogerCibrian/baselinelens/issues";

export default function Overview({
  baseline,
  scan,
  scanning,
  changes,
  summaries,
  loadErrors,
  userState,
  appVersion,
  onJumpToConsole,
  onResetSummaries,
  onResetChanges,
}: {
  baseline: Baseline;
  scan: Scan;
  /** True while a scan is in flight. Lets the headline treat an empty
   * `summaries` mid-scan as the first-scan state while the run finishes. */
  scanning: boolean;
  /** App version for the report footer's product line. */
  appVersion: string;
  /** Per-rec scan-time status flips, oldest first. */
  changes: ChangeEvent[];
  /** Per-scan summary records (counts + timestamp + versions). */
  summaries: ScanSummary[];
  /** Per-sub-file load failures keyed by sub-file. */
  loadErrors: ScanLoadErrors;
  userState: UserState;
  onJumpToConsole: (filter: Partial<ConsoleFilter>) => void;
  /** Deletes the trend-chart summary file and reloads. Invoked from the
   * inline recovery action when `loadErrors.summaries` is set. */
  onResetSummaries: () => void;
  /** Deletes the per-rec change log and reloads. Invoked from the
   * inline recovery action when `loadErrors.changes` is set. */
  onResetChanges: () => void;
}) {
  const levels = useMemo(
    () => scoresByLevel(baseline, scan, userState),
    [baseline, scan, userState],
  );
  const weakest = useMemo(
    () => weakestCategories(baseline, scan, userState, 6),
    [baseline, scan, userState],
  );

  const errorCount = levels.reduce((n, s) => n + s.error, 0);
  const evaluatedCount = levels.reduce((n, s) => n + s.pass + s.fail, 0);
  // "Severe" means more controls failed to evaluate than were
  // evaluated, so the rate reflects too thin a slice to assert a
  // direction: the headline is neutralized and the trend fact hidden.
  const errorsSevere = errorCount > 0 && errorCount > evaluatedCount;

  const { improved, regressed, improvedTotal, regressedTotal } = useMemo(
    () => recentChanges(baseline, scan, userState, changes),
    [baseline, scan, userState, changes],
  );

  const weakCategoryCount = useMemo(
    () =>
      categoryScores(baseline, scan, userState).filter(
        (c) => c.inScopePct < WEAK_CATEGORY_THRESHOLD,
      ).length,
    [baseline, scan, userState],
  );

  const headline = useMemo<Headline>(() => {
    const built = buildHeadline(
      summaries,
      improved.length,
      regressed.length,
      weakCategoryCount,
    );
    // During a scan, `summaries` reloads only after the run persists, so
    // an in-flight first scan has a live `latest` but still-empty
    // `summaries`. Treat that window as the first-scan state so the
    // headline holds steady while the scan finishes and the first summary
    // lands.
    return scanning && built.kind === "empty" ? { kind: "first" } : built;
  }, [summaries, improved.length, regressed.length, weakCategoryCount, scanning]);

  const trendPoints = useMemo<TrendPoint[]>(() => {
    // Collapse consecutive scans with the exact same result into one
    // point so a "just checking" scan that changed nothing doesn't
    // plant a permanent flat point. Consecutive-only: an equal value
    // that returns after a change (9 → 12 → 9) is real movement and
    // stays its own point. Display-side only — every scan is still
    // recorded; the run's timestamps ride along for the tooltip.
    const runs: { passPct: number; scans: string[] }[] = [];
    let lastSig: string | null = null;
    for (const s of summaries) {
      const sig = `${s.pass}|${s.fail}|${s.manual}|${s.error}|${s.exception}`;
      if (sig === lastSig) {
        runs[runs.length - 1].scans.push(s.startedAt);
      } else {
        runs.push({ passPct: passPctOf(s), scans: [s.startedAt] });
        lastSig = sig;
      }
    }
    return runs.slice(-TREND_CHART_POINTS).map((run) => ({
      startedAt: run.scans[run.scans.length - 1],
      passPct: run.passPct,
      scans: run.scans,
    }));
  }, [summaries]);
  return (
    <article className="overview">
      <header className="overview-header">
        <button
          type="button"
          className="overview-print"
          onClick={() => window.print()}
        >
          Print report
        </button>
        <p className="eyebrow">
          Compliance report ·{" "}
          <span className="mono">{formatDate(scan.startedAt)}</span>
        </p>
        <HeadlineH1 headline={headline} errorsSevere={errorsSevere} />
        <HeadlineFacts headline={headline} errorsSevere={errorsSevere} />
        <p className="meta">
          <span className="mono">{scan.device.hostname}</span> ·{" "}
          {scan.device.osName} {scan.device.osVersion} ·{" "}
          <span className="meta-benchmark">
            {baseline.source.benchmarkName} {baseline.source.benchmarkVersion}
          </span>
        </p>
      </header>

      {errorCount > 0 && (
        <p className="surface-notice surface-notice-warn overview-eval-notice">
          <span>
            <strong>
              {errorCount} control{errorCount === 1 ? "" : "s"} could not be
              evaluated
            </strong>{" "}
            — the audit couldn't complete these checks, so they're excluded
            from the compliance rate. If the same controls keep erroring
            across scans,{" "}
            <a
              href={ISSUES_URL}
              onClick={(e) => {
                e.preventDefault();
                void openUrl(ISSUES_URL);
              }}
            >
              report it on GitHub
            </a>
            .
          </span>
        </p>
      )}

      <section className="overview-section">
        <h2 className="doc-section-heading serif">Score by level</h2>
        <div className="level-cards">
          {levels.map((score) => (
            <LevelCard
              key={score.level}
              score={score}
              onJump={() => onJumpToConsole({ level: score.level })}
            />
          ))}
        </div>
        <p className="strict-line">
          <strong className="strict-line-label">Strict compliance</strong>
          {" — every recommendation counted, including manual and accepted exceptions: "}
          <span className="strict-line-values mono">
            {levels
              .map(
                (s) => `${levelName(s.level)} ${Math.round(s.fullPct * 100)}%`,
              )
              .join("  ·  ")}
          </span>
        </p>
      </section>

      <DocSection num={1} title="Trend">
        <p className="section-lead">
          In-scope pass rate across recent scans. Each point is one full
          benchmark run; the rightmost is the most recent.
        </p>
        {loadErrors.summaries ? (
          <p className="surface-notice">
            <span>Trend history can't be read.</span>
            <button
              type="button"
              className="surface-notice-action"
              onClick={onResetSummaries}
            >
              Clear trend history
            </button>
          </p>
        ) : trendPoints.length < 2 ? (
          <p className="muted trend-empty">
            {summaries.length > 1
              ? `No change across ${summaries.length} scans — the trend appears once a result differs.`
              : "One scan recorded — the trend appears once a second scan completes."}
          </p>
        ) : (
          <figure className="trend-chart-figure">
            <TrendChart points={trendPoints} />
            <figcaption className="trend-chart-caption">
              Fig. 1 — In-scope pass rate across recommendations with a
              settled verdict.
            </figcaption>
          </figure>
        )}
      </DocSection>

      <DocSection num={2} title="Weakest categories">
        <p className="section-lead">
          Up to six categories with the lowest in-scope pass rates.
        </p>
        {weakest.length === 0 ? (
          <p className="muted">
            No categories with at least three in-scope recommendations.
          </p>
        ) : (
          <ul className="category-list">
            {weakest.map((cat) => (
              <CategoryRow
                key={cat.number}
                score={cat}
                onJump={() => onJumpToConsole({ category: cat.number })}
              />
            ))}
          </ul>
        )}
      </DocSection>

      <DocSection num={3} title="Recently changed">
        <p className="section-lead">
          Recommendations whose status recently flipped.
        </p>
        {loadErrors.changes ? (
          <p className="surface-notice">
            <span>Change history can't be read.</span>
            <button
              type="button"
              className="surface-notice-action"
              onClick={onResetChanges}
            >
              Clear change history
            </button>
          </p>
        ) : (
          <div className="recently-changed">
            <RecentlyChangedColumn
              title="Remediated"
              tone="pass"
              symbol="▲"
              items={improved}
              total={improvedTotal}
              onJump={(recId) => onJumpToConsole({ search: recId })}
              onViewAll={() => onJumpToConsole({ delta: "improved" })}
            />
            <RecentlyChangedColumn
              title="Regressed"
              tone="fail"
              symbol="▼"
              items={regressed}
              total={regressedTotal}
              onJump={(recId) => onJumpToConsole({ search: recId })}
              onViewAll={() => onJumpToConsole({ delta: "regressed" })}
            />
          </div>
        )}
      </DocSection>

      <footer className="overview-footer">
        <span className="mono">BaselineLens v{appVersion || "—"}</span>
        <span className="mono">
          {baseline.source.benchmarkName}{" "}
          {baseline.source.benchmarkVersion}
        </span>
      </footer>

      {/* Print-only running footer. display:none on screen; in print
          it's position:fixed so Chromium repeats it on every page,
          standing in for the browser's stripped header/footer. */}
      <div className="print-footer" aria-hidden="true">
        <span>
          {baseline.source.benchmarkName}{" "}
          {baseline.source.benchmarkVersion}
        </span>
        <span>
          {scan.device.hostname} · {formatDate(scan.startedAt)}
        </span>
      </div>
    </article>
  );
}
