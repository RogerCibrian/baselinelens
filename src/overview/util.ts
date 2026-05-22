import type {
  Baseline,
  ChangeEvent,
  Level,
  Recommendation,
  Scan,
  ScanSummary,
  UserState,
} from "../bindings";
import { computeDelta, indexLatestChanges, type Delta } from "../data/changes";

const TREND_WINDOW_DAYS = 30;
const STABLE_THRESHOLD_PTS = 0.5;
const RECENTLY_CHANGED_LIMIT = 6;

export type RecentChange = {
  rec: Recommendation;
  observedAt: string;
};

export type TrendPoint = {
  /** Anchor: the most recent scan in the collapsed run, so the
   * rightmost point stays the latest scan. */
  startedAt: string;
  passPct: number;
  /** Every scan start time that produced this same result, oldest
   * first. Length > 1 when a run of unchanged scans collapsed here. */
  scans: string[];
};

type Trend = "improving" | "declining" | "stable";

export type Headline =
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

export function levelName(level: Level): string {
  switch (level) {
    case "L1":
      return "Level 1";
    case "L2":
      return "Level 2";
    case "BL":
      return "BitLocker";
  }
}

/**
 * In-scope compliance rate for a `ScanSummary`. Matches the level
 * cards' methodology so the headline strip and trend chart move in
 * lockstep with the per-level breakdown: the rate is pass over the
 * controls that were actually evaluated (pass + fail). Manual,
 * accepted exceptions, and errored checks are out of scope, so a
 * transient scan error never moves the trend. Recomputed from the
 * stored component counts so the whole trend stays on one methodology.
 */
export function passPctOf(summary: ScanSummary): number {
  const denom = summary.pass + summary.fail;
  return denom === 0 ? 0 : summary.pass / denom;
}

/**
 * Composes the deterministic single-line summary above the score
 * cards. Returns `first` while only one summary exists (no comparison
 * yet) and `empty` when there are none. The trend variant carries the
 * direction (`improving`/`declining`/`stable`), the magnitude in
 * percentage points, the window in days the comparison spans, and
 * counts for the "remediated · regressed · K below 50%" tail.
 */
export function buildHeadline(
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
 * Buckets recs whose most-recent change-event is currently active into
 * `improved` and `regressed` lists, sorted by `observedAt` descending
 * and capped at `RECENTLY_CHANGED_LIMIT` per bucket. "Active" means
 * `computeDelta` against the current effective status still produces
 * the same direction — a rec that flipped fail→pass and then back to
 * fail wouldn't appear in `improved`.
 */
export function recentChanges(
  baseline: Baseline,
  scan: Scan,
  userState: UserState,
  changes: ChangeEvent[],
): {
  improved: RecentChange[];
  regressed: RecentChange[];
  /** Pre-cap bucket sizes so a capped column can offer a "view all"
   * link into the matching Console delta view. */
  improvedTotal: number;
  regressedTotal: number;
} {
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
    improvedTotal: buckets.improved.length,
    regressedTotal: buckets.regressed.length,
  };
}
