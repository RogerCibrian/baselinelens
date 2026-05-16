import { useMemo, type ReactNode } from "react";

import type {
  Baseline,
  ChangeEvent,
  Level,
  Recommendation,
  Scan,
  ScanLoadErrors,
  ScanSummary,
  UserState,
} from "./bindings";
import {
  computeDelta,
  indexLatestChanges,
  type Delta,
} from "./data/changes";
import type { ConsoleFilter } from "./data/consoleFilter";
import {
  categoryScores,
  scoresByLevel,
  weakestCategories,
  type CategoryScore,
  type LevelScore,
} from "./data/score";

const RECENTLY_CHANGED_LIMIT = 6;
const TREND_WINDOW_DAYS = 30;
const TREND_CHART_POINTS = 6;
const STABLE_THRESHOLD_PTS = 0.5;
const WEAK_CATEGORY_THRESHOLD = 0.5;

type RecentChange = {
  rec: Recommendation;
  observedAt: string;
};

export default function Overview({
  baseline,
  scan,
  changes,
  summaries,
  loadErrors,
  userState,
  onJumpToConsole,
  onResetSummaries,
  onResetChanges,
}: {
  baseline: Baseline;
  scan: Scan;
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
  const levels = scoresByLevel(baseline, scan, userState);
  const weakest = weakestCategories(baseline, scan, userState, 6);

  const { improved, regressed } = useMemo(
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

  const headline = useMemo(
    () => buildHeadline(summaries, improved.length, regressed.length, weakCategoryCount),
    [summaries, improved.length, regressed.length, weakCategoryCount],
  );

  const trendPoints = useMemo(() => {
    const tail = summaries.slice(-TREND_CHART_POINTS);
    return tail.map((s) => ({
      startedAt: s.startedAt,
      passPct: passPctOf(s),
    }));
  }, [summaries]);
  return (
    <article className="overview">
      <header className="overview-header">
        <p className="eyebrow">
          Compliance report ·{" "}
          <span className="mono">{formatDate(scan.startedAt)}</span>
        </p>
        <HeadlineH1
          headline={headline}
          fallback={baseline.source.benchmarkName}
        />
        <HeadlineFacts headline={headline} />
        <p className="meta">
          <span className="mono">{scan.device.hostname}</span> ·{" "}
          {scan.device.osName} {scan.device.osVersion} ·{" "}
          {baseline.source.benchmarkName} {baseline.source.benchmarkVersion}
        </p>
      </header>

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
          {" — every control counted, no exception credit: "}
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
              Reset trend history
            </button>
          </p>
        ) : trendPoints.length < 2 ? (
          <p className="muted trend-empty">
            One scan recorded — trend appears once a second scan completes.
          </p>
        ) : (
          <figure className="trend-chart-figure">
            <TrendChart points={trendPoints} />
            <figcaption className="trend-chart-caption">
              Fig. 1 — In-scope pass rate, unweighted across recommendations
              with a settled verdict.
            </figcaption>
          </figure>
        )}
      </DocSection>

      <DocSection num={2} title="Weakest categories">
        <p className="section-lead">
          Up to six categories with the lowest in-scope pass rates. These
          are where remediation work is most concentrated.
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
          Recommendations whose status flipped against the prior scan.
        </p>
        {loadErrors.changes ? (
          <p className="surface-notice">
            <span>Change history can't be read.</span>
            <button
              type="button"
              className="surface-notice-action"
              onClick={onResetChanges}
            >
              Reset change history
            </button>
          </p>
        ) : (
          <div className="recently-changed">
            <RecentlyChangedColumn
              title="Improved"
              tone="pass"
              symbol="▲"
              items={improved}
              onJump={(recId) => onJumpToConsole({ search: recId })}
            />
            <RecentlyChangedColumn
              title="Regressed"
              tone="fail"
              symbol="▼"
              items={regressed}
              onJump={(recId) => onJumpToConsole({ search: recId })}
            />
          </div>
        )}
      </DocSection>

      <footer className="overview-footer">
        <span className="mono">{baseline.source.benchmarkVersion}</span>
        <span className="mono">
          {baseline.recommendations.length} recommendations
        </span>
      </footer>
    </article>
  );
}

function LevelCard({
  score,
  onJump,
}: {
  score: LevelScore;
  onJump: () => void;
}) {
  const tone = toneFor(score.inScopePct);
  // In-scope excludes both Manual recs (no automated check) and Pending
  // ones (haven't been scanned yet) so the % reflects only settled
  // verdicts. Pending count surfaces separately in the note when > 0.
  const inScopeDenom = score.total - score.manual - score.pending;
  const inScopePct =
    score.inScopePct === null ? null : Math.round(score.inScopePct * 100);
  return (
    <button type="button" className="level-card" onClick={onJump}>
      <div className="level-card-head">
        <span className={`level-chip level-${score.level.toLowerCase()}`}>
          {score.level}
        </span>
        <span className="level-card-name">{levelName(score.level)}</span>
      </div>
      <div className="level-card-numbers">
        <div>
          <span className="caption">In-scope</span>
          <span className={`level-pct serif tone-${tone}`}>
            {inScopePct === null ? (
              "—"
            ) : (
              <>
                {inScopePct}
                <span className="level-pct-unit">%</span>
              </>
            )}
          </span>
        </div>
      </div>
      <p className="level-card-note muted mono">
        {score.pass + score.exception} of {inScopeDenom} in scope
        {score.pending > 0 && ` · ${score.pending} pending`}
      </p>
      <div className={`threshold-bar tone-${tone}`}>
        <div
          className="threshold-bar-fill"
          style={{ width: `${(score.inScopePct ?? 0) * 100}%` }}
        />
      </div>
    </button>
  );
}

function CategoryRow({
  score,
  onJump,
}: {
  score: CategoryScore;
  onJump: () => void;
}) {
  const tone = toneFor(score.inScopePct);
  // The parser's `name` is a full hierarchical path joined with " - "
  // (e.g. "Account Policies - Account Lockout Policy - Account lockout
  // duration"). Show only the leaf in the row label — full path stays
  // available as the tooltip.
  const localName = score.name ? score.name.split(" - ").pop() : null;
  return (
    <li>
      <button
        type="button"
        className="category-row"
        onClick={onJump}
        title={score.name || score.number}
      >
        <span className="category-row-head">
          <span className="category-label">
            <span className="category-number mono">{score.number}</span>
            {localName && <span className="category-name">{localName}</span>}
          </span>
          <span className={`category-pct mono tone-${tone}`}>
            {Math.round(score.inScopePct * 100)}%
          </span>
        </span>
        <span className={`category-bar tone-${tone}`}>
          <span
            className="category-bar-fill"
            style={{ width: `${score.inScopePct * 100}%` }}
          />
        </span>
        <span className="category-row-breakdown muted">
          <span>{score.fail} failing</span>
          <span aria-hidden="true">·</span>
          <span>{score.pass} passing</span>
          {score.exception > 0 && (
            <>
              <span aria-hidden="true">·</span>
              <span>
                {score.exception} exception
                {score.exception === 1 ? "" : "s"}
              </span>
            </>
          )}
        </span>
      </button>
    </li>
  );
}

function DocSection({
  num,
  title,
  children,
}: {
  num: number;
  title: string;
  children: ReactNode;
}) {
  return (
    <section className="doc-section">
      <h2 className="doc-section-heading serif">
        <span className="doc-section-num mono">§ {num}</span>
        {title}
      </h2>
      {children}
    </section>
  );
}

type Trend = "improving" | "declining" | "stable";

type Headline =
  | { kind: "empty" }
  | { kind: "first" }
  | {
      kind: "trend";
      trend: Trend;
      pointsDelta: number;
      windowDays: number;
      improved: number;
      regressed: number;
      weakCategoryCount: number;
    };

/**
 * Composes the deterministic single-line summary above the score
 * cards. Returns `first` while only one summary exists (no comparison
 * yet) and `empty` when there are none. The trend variant carries the
 * direction (`improving`/`declining`/`stable`), the magnitude in
 * percentage points, the window in days the comparison spans, and
 * counts for the "remediated · regressed · K below 50%" tail.
 */
function buildHeadline(
  summaries: ScanSummary[],
  improved: number,
  regressed: number,
  weakCategoryCount: number,
): Headline {
  if (summaries.length === 0) return { kind: "empty" };
  if (summaries.length < 2) return { kind: "first" };

  const latest = summaries[summaries.length - 1];
  const cutoff = Date.parse(latest.startedAt) - TREND_WINDOW_DAYS * 86_400_000;
  // Walk backwards to find the oldest summary that still falls inside
  // the window; that's the comparison anchor. If none does, fall back
  // to the very first summary so we still produce a trend over
  // whatever range we have.
  let anchor: ScanSummary = summaries[0];
  let windowDays = TREND_WINDOW_DAYS;
  for (let i = summaries.length - 2; i >= 0; i--) {
    const ts = Date.parse(summaries[i].startedAt);
    if (ts >= cutoff) {
      anchor = summaries[i];
      break;
    }
  }
  if (Date.parse(anchor.startedAt) < cutoff) {
    windowDays = Math.max(
      1,
      Math.round(
        (Date.parse(latest.startedAt) - Date.parse(anchor.startedAt)) /
          86_400_000,
      ),
    );
  }
  const pointsDelta = (passPctOf(latest) - passPctOf(anchor)) * 100;
  const trend: Trend =
    pointsDelta > STABLE_THRESHOLD_PTS
      ? "improving"
      : pointsDelta < -STABLE_THRESHOLD_PTS
        ? "declining"
        : "stable";
  return {
    kind: "trend",
    trend,
    pointsDelta,
    windowDays,
    improved,
    regressed,
    weakCategoryCount,
  };
}

/**
 * In-scope compliance rate for a `ScanSummary`. Matches the level
 * cards' methodology so the headline strip and trend chart move in
 * lockstep with what the per-level breakdown shows: passes and
 * exceptions both count as closed work; fail and error count against;
 * manual and pending are out of scope.
 */
function passPctOf(summary: ScanSummary): number {
  const denom = summary.pass + summary.fail + summary.error + summary.exception;
  return denom === 0 ? 0 : (summary.pass + summary.exception) / denom;
}

function HeadlineH1({
  headline,
  fallback,
}: {
  headline: Headline;
  /** Used when no summaries exist yet (e.g. trend history was reset
   * after a scan). Falls back to the benchmark name so the report
   * always has a substantive H1. */
  fallback: string;
}) {
  if (headline.kind === "empty") {
    return <h1 className="serif overview-headline">{fallback}</h1>;
  }
  if (headline.kind === "first") {
    return <h1 className="serif overview-headline">First scan recorded.</h1>;
  }
  return (
    <h1 className="serif overview-headline">
      Compliance is{" "}
      <em className={`headline-trend headline-trend-${headline.trend}`}>
        {headline.trend}
      </em>
      .
    </h1>
  );
}

function HeadlineFacts({ headline }: { headline: Headline }) {
  if (headline.kind === "empty") return null;
  if (headline.kind === "first") {
    return (
      <p className="headline-facts headline-facts-first">
        Trend metrics appear after the next scan.
      </p>
    );
  }
  const { pointsDelta, windowDays, improved, regressed, weakCategoryCount } =
    headline;
  const arrow = pointsDelta >= 0 ? "↑" : "↓";
  return (
    <p className="headline-facts">
      <span className="headline-fact mono">
        {arrow} {Math.abs(pointsDelta).toFixed(1)} pts in {windowDays} day
        {windowDays === 1 ? "" : "s"}
      </span>
      <span className="headline-divider" aria-hidden="true" />
      <span className="headline-fact mono">
        {improved} remediated · {regressed} regressed
      </span>
      {weakCategoryCount > 0 && (
        <>
          <span className="headline-divider" aria-hidden="true" />
          <span className="headline-fact mono">
            {weakCategoryCount} categor
            {weakCategoryCount === 1 ? "y" : "ies"} below 50%
          </span>
        </>
      )}
    </p>
  );
}

/**
 * Buckets recs whose most-recent change-event is currently active into
 * `improved` and `regressed` lists, sorted by `observedAt` descending
 * and capped at `RECENTLY_CHANGED_LIMIT` per bucket. "Active" means
 * `computeDelta` against the current effective status still produces
 * the same direction — a rec that flipped fail→pass and then back to
 * fail wouldn't appear in `improved`.
 */
function recentChanges(
  baseline: Baseline,
  scan: Scan,
  userState: UserState,
  changes: ChangeEvent[],
): { improved: RecentChange[]; regressed: RecentChange[] } {
  const index = indexLatestChanges(changes);
  const buckets: Record<Delta, RecentChange[]> = {
    improved: [],
    regressed: [],
    unchanged: [],
  };
  for (const rec of baseline.recommendations) {
    const event = index.get(rec.id);
    if (!event) continue;
    const delta = computeDelta(rec, index, scan, userState);
    if (delta === "unchanged") continue;
    buckets[delta].push({ rec, observedAt: event.observedAt });
  }
  const byRecency = (a: RecentChange, b: RecentChange) =>
    b.observedAt.localeCompare(a.observedAt);
  return {
    improved: buckets.improved.sort(byRecency).slice(0, RECENTLY_CHANGED_LIMIT),
    regressed: buckets.regressed
      .sort(byRecency)
      .slice(0, RECENTLY_CHANGED_LIMIT),
  };
}

type TrendPoint = { startedAt: string; passPct: number };

/**
 * SVG line chart of pass-rate over the last N scans. Renders the line
 * with an area fill below it, dots at each scan point, and Y-axis
 * percentage ticks. Range is derived from the data with a small pad
 * so the line never touches the chart edges.
 */
function TrendChart({ points }: { points: TrendPoint[] }) {
  const width = 720;
  const height = 200;
  const padL = 40;
  const padR = 12;
  const padT = 12;
  const padB = 24;
  const innerW = width - padL - padR;
  const innerH = height - padT - padB;

  const values = points.map((p) => p.passPct * 100);
  const rawMin = Math.min(...values);
  const rawMax = Math.max(...values);
  const padPct = Math.max(2, (rawMax - rawMin) * 0.15);
  const yMin = Math.max(0, rawMin - padPct);
  const yMax = Math.min(100, rawMax + padPct);
  const yRange = Math.max(1, yMax - yMin);

  const x = (i: number) =>
    points.length === 1
      ? padL + innerW / 2
      : padL + (i / (points.length - 1)) * innerW;
  const y = (v: number) => padT + innerH - ((v - yMin) / yRange) * innerH;

  const linePath = values
    .map((v, i) => `${i === 0 ? "M" : "L"} ${x(i).toFixed(1)} ${y(v).toFixed(1)}`)
    .join(" ");
  const areaPath =
    linePath +
    ` L ${x(points.length - 1).toFixed(1)} ${(padT + innerH).toFixed(1)}` +
    ` L ${x(0).toFixed(1)} ${(padT + innerH).toFixed(1)} Z`;

  const ticks = 4;
  const yTicks = Array.from({ length: ticks + 1 }, (_, i) => yMin + (yRange * i) / ticks);

  return (
    <svg
      className="trend-chart"
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      role="img"
      aria-label={`Pass rate across ${points.length} recent scans`}
    >
      <defs>
        <linearGradient id="trend-grad" x1="0" x2="0" y1="0" y2="1">
          <stop offset="0%" stopColor="var(--v-accent)" stopOpacity="0.18" />
          <stop offset="100%" stopColor="var(--v-accent)" stopOpacity="0" />
        </linearGradient>
      </defs>

      {yTicks.map((t, i) => (
        <g key={i}>
          <line
            x1={padL}
            x2={padL + innerW}
            y1={y(t)}
            y2={y(t)}
            stroke="var(--v-line)"
            strokeDasharray={i === 0 ? "0" : "2 4"}
          />
          <text
            x={padL - 6}
            y={y(t)}
            dy={3}
            className="trend-chart-axis mono"
            textAnchor="end"
          >
            {t.toFixed(0)}%
          </text>
        </g>
      ))}

      <path d={areaPath} fill="url(#trend-grad)" />
      <path
        d={linePath}
        stroke="var(--v-accent)"
        strokeWidth={1.75}
        fill="none"
        strokeLinecap="round"
        strokeLinejoin="round"
      />

      {points.map((p, i) => (
        <g key={p.startedAt}>
          <circle
            cx={x(i)}
            cy={y(values[i])}
            r={3}
            fill="var(--v-paper)"
            stroke="var(--v-accent)"
            strokeWidth={1.5}
          />
          <text
            x={x(i)}
            y={padT + innerH + 14}
            className="trend-chart-axis mono"
            textAnchor="middle"
          >
            {formatChartDate(p.startedAt)}
          </text>
        </g>
      ))}
    </svg>
  );
}

function formatChartDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function RecentlyChangedColumn({
  title,
  tone,
  symbol,
  items,
  onJump,
}: {
  title: string;
  tone: "pass" | "fail";
  symbol: string;
  items: RecentChange[];
  onJump: (recId: string) => void;
}) {
  return (
    <div className="recently-changed-col">
      <div className={`recently-changed-head tone-${tone}`}>
        <span aria-hidden="true">{symbol}</span>
        <span>{title}</span>
        <span className="recently-changed-count muted">· {items.length}</span>
      </div>
      {items.length === 0 ? (
        <p className="recently-changed-empty muted">None recently.</p>
      ) : (
        <ul className="recently-changed-list">
          {items.map(({ rec }) => (
            <li key={rec.id}>
              <button
                type="button"
                className="recently-changed-row"
                onClick={() => onJump(rec.id)}
              >
                <div className="recently-changed-meta">
                  <span className="mono recently-changed-id">{rec.id}</span>
                  <span
                    className={`level-chip level-${rec.level.toLowerCase()}`}
                  >
                    {rec.level}
                  </span>
                </div>
                <div className="recently-changed-title">{rec.title}</div>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
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
