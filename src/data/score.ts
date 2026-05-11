import type {
  Baseline,
  Level,
  Recommendation,
  Scan,
  UserState,
} from "../bindings";

export type EffectiveStatus =
  | "pass"
  | "fail"
  | "manual"
  | "error"
  | "exception"
  | "pending";

/**
 * Returns the display status for `rec` against the scan and user state.
 * A Fail with a matching entry in `userState.exceptions` is reported as
 * "exception" — counts as a pass for the In-scope score per HANDOFF.
 * A missing result for an in-progress scan (no `finishedAt`) is
 * reported as "pending" so the UI can render it distinctly from
 * "manual" while results stream in.
 */
export function effectiveStatus(
  rec: Recommendation,
  scan: Scan,
  userState: UserState,
): EffectiveStatus {
  const result = scan.results[rec.id];
  if (!result) {
    // No result yet. If the scan is still running we know more is
    // coming; once it's done, treat a missing result as Manual.
    return scan.finishedAt === null ? "pending" : "manual";
  }
  if (result.status === "Fail" && userState.exceptions[rec.id]) {
    return "exception";
  }
  switch (result.status) {
    case "Pass":
      return "pass";
    case "Fail":
      return "fail";
    case "Manual":
      return "manual";
    case "Error":
      return "error";
  }
}

export type LevelScore = {
  level: Level;
  total: number;
  pass: number;
  fail: number;
  manual: number;
  error: number;
  exception: number;
  pending: number;
  /** (pass + exception) / (total - manual - pending). Null when
   * nothing is in scope yet. Excludes pending so the percentage
   * reflects only the recs whose verdict is settled. */
  inScopePct: number | null;
  /** pass / total. */
  fullPct: number;
};

/**
 * Returns one LevelScore per recognized level (L1, L2, BL).
 */
export function scoresByLevel(
  baseline: Baseline,
  scan: Scan,
  userState: UserState,
): LevelScore[] {
  const levels: Level[] = ["L1", "L2", "BL"];
  return levels.map((level) => {
    const recs = baseline.recommendations.filter((r) => r.level === level);
    return scoreForRecs(level, recs, scan, userState);
  });
}

function scoreForRecs(
  level: Level,
  recs: Recommendation[],
  scan: Scan,
  userState: UserState,
): LevelScore {
  let pass = 0;
  let fail = 0;
  let manual = 0;
  let error = 0;
  let exception = 0;
  let pending = 0;
  for (const rec of recs) {
    switch (effectiveStatus(rec, scan, userState)) {
      case "pass":
        pass++;
        break;
      case "fail":
        fail++;
        break;
      case "manual":
        manual++;
        break;
      case "error":
        error++;
        break;
      case "exception":
        exception++;
        break;
      case "pending":
        pending++;
        break;
    }
  }
  const total = recs.length;
  const inScopeDenom = total - manual - pending;
  return {
    level,
    total,
    pass,
    fail,
    manual,
    error,
    exception,
    pending,
    inScopePct: inScopeDenom > 0 ? (pass + exception) / inScopeDenom : null,
    fullPct: total > 0 ? pass / total : 0,
  };
}

export type CategoryScore = {
  number: string;
  /** Empty until the parser extracts category names from the PDF; the UI
   * falls back to `number` when this is empty. */
  name: string;
  total: number;
  inScope: number;
  pass: number;
  inScopePct: number;
};

/**
 * Returns the `limit` weakest categories by in-scope pass rate, restricted
 * to categories with at least three in-scope recommendations (per HANDOFF
 * — fewer than that and the percentage is too noisy).
 */
export function weakestCategories(
  baseline: Baseline,
  scan: Scan,
  userState: UserState,
  limit: number,
): CategoryScore[] {
  const nameByNumber = new Map<string, string>();
  for (const cat of baseline.categories) {
    nameByNumber.set(cat.number, cat.name);
  }

  const buckets = new Map<string, Recommendation[]>();
  for (const rec of baseline.recommendations) {
    const arr = buckets.get(rec.categoryNumber) ?? [];
    arr.push(rec);
    buckets.set(rec.categoryNumber, arr);
  }

  const scores: CategoryScore[] = [];
  for (const [number, recs] of buckets) {
    let pass = 0;
    let inScope = 0;
    for (const rec of recs) {
      const status = effectiveStatus(rec, scan, userState);
      if (status === "manual" || status === "pending") continue;
      inScope++;
      if (status === "pass" || status === "exception") pass++;
    }
    if (inScope >= 3) {
      scores.push({
        number,
        name: nameByNumber.get(number) ?? "",
        total: recs.length,
        inScope,
        pass,
        inScopePct: pass / inScope,
      });
    }
  }

  scores.sort((a, b) => a.inScopePct - b.inScopePct);
  return scores.slice(0, limit);
}
