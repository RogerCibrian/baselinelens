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
 * "exception" — a deliberately accepted risk. It's excluded from the
 * In-scope pass rate (like manual and pending) and counts toward the
 * Strict compliance total. A Manual with a matching entry in
 * `userState.attestations` resolves to the admin's recorded "pass" /
 * "fail" so a hand-verified check counts in the In-scope rate the same
 * as an automated one. A missing result for an in-progress scan (no
 * `finishedAt`) is reported as "pending" so the UI can render it
 * distinctly from "manual" while results stream in.
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
  if (result.status === "Manual") {
    const attestation = userState.attestations?.[rec.id];
    if (attestation) {
      return attestation.outcome === "pass" ? "pass" : "fail";
    }
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
    default:
      // A status outside the known set can only come from an old or
      // hand-edited scan file. Treat it as the unknown bucket rather
      // than returning undefined and silently skewing every tally.
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
  /** pass / (pass + fail). Null when nothing is actionable yet.
   * Manual, pending, accepted exceptions, and errored checks are all
   * out of scope, so this is the pass rate over the controls that
   * were actually evaluated. */
  inScopePct: number | null;
  /** pass / total. */
  fullPct: number;
};

/**
 * Returns one LevelScore per level present in the baseline, in
 * L1→L2→BL order. A level with no recommendations is omitted.
 */
export function scoresByLevel(
  baseline: Baseline,
  scan: Scan,
  userState: UserState,
): LevelScore[] {
  const levels: Level[] = ["L1", "L2", "BL"];
  return levels.flatMap((level) => {
    const recs = baseline.recommendations.filter((r) => r.level === level);
    if (recs.length === 0) return [];
    return [scoreForRecs(level, recs, scan, userState)];
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
  const inScopeDenom = total - manual - pending - exception - error;
  return {
    level,
    total,
    pass,
    fail,
    manual,
    error,
    exception,
    pending,
    inScopePct: inScopeDenom > 0 ? pass / inScopeDenom : null,
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
  fail: number;
  exception: number;
  error: number;
  /** pass / inScope, where inScope is pass + fail only — manual,
   * pending, accepted exceptions, and errored checks are all excluded
   * (the controls that were actually evaluated). */
  inScopePct: number;
};

type CategoryTally = Pick<
  CategoryScore,
  "total" | "inScope" | "pass" | "fail" | "exception" | "error"
>;

/**
 * Counts a category's recommendations into the scoring buckets. In
 * scope is pass + fail only — manual, pending, accepted exceptions,
 * and errored checks are tracked but excluded from `inScope`. Shared
 * by both category-score functions so the bucketing can't drift.
 */
function tallyCategory(
  recs: Recommendation[],
  scan: Scan,
  userState: UserState,
): CategoryTally {
  let pass = 0;
  let fail = 0;
  let exception = 0;
  let error = 0;
  let inScope = 0;
  for (const rec of recs) {
    const status = effectiveStatus(rec, scan, userState);
    if (status === "manual" || status === "pending") continue;
    if (status === "exception") {
      exception++;
      continue;
    }
    if (status === "error") {
      error++;
      continue;
    }
    inScope++;
    if (status === "pass") pass++;
    else if (status === "fail") fail++;
  }
  return { total: recs.length, inScope, pass, fail, exception, error };
}

/**
 * Returns one CategoryScore per recommendation category that has at
 * least three in-scope recommendations (fewer than that and the
 * percentage is too noisy to rank on per HANDOFF). Order is
 * insertion-by-iteration; callers sort/filter as needed.
 */
export function categoryScores(
  baseline: Baseline,
  scan: Scan,
  userState: UserState,
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
    const tally = tallyCategory(recs, scan, userState);
    if (tally.inScope >= 3) {
      scores.push({
        number,
        name: nameByNumber.get(number) ?? "",
        ...tally,
        inScopePct: tally.pass / tally.inScope,
      });
    }
  }

  return scores;
}

/**
 * Returns one CategoryScore per top-level category (the first dotted
 * segment of each recommendation's category number) in dotted-numeric
 * order. The `number` field is the top-level segment (`"1"`, not
 * `"1.2.3"`), and `name` is filled from the matching parent-less
 * `Category` entry when the parser supplied it.
 */
export function topLevelCategoryScores(
  baseline: Baseline,
  scan: Scan,
  userState: UserState,
): CategoryScore[] {
  const topLevelNames = new Map<string, string>();
  for (const cat of baseline.categories) {
    if (cat.parent === null) topLevelNames.set(cat.number, cat.name);
  }

  const buckets = new Map<string, Recommendation[]>();
  for (const rec of baseline.recommendations) {
    const top = rec.categoryNumber.split(".")[0];
    if (!top) continue;
    const arr = buckets.get(top) ?? [];
    arr.push(rec);
    buckets.set(top, arr);
  }

  const scores: CategoryScore[] = [];
  for (const [number, recs] of buckets) {
    const tally = tallyCategory(recs, scan, userState);
    scores.push({
      number,
      name: topLevelNames.get(number) ?? "",
      ...tally,
      inScopePct: tally.inScope > 0 ? tally.pass / tally.inScope : 0,
    });
  }

  scores.sort((a, b) => Number(a.number) - Number(b.number));
  return scores;
}

/**
 * Returns the `limit` weakest categories by in-scope pass rate. Ties
 * (common at 0% on a fresh scan) are broken by raw fail count
 * descending — a category with 12 failing recs ranks above one with 3
 * even though both read "0%".
 */
export function weakestCategories(
  baseline: Baseline,
  scan: Scan,
  userState: UserState,
  limit: number,
): CategoryScore[] {
  const scores = categoryScores(baseline, scan, userState);
  scores.sort((a, b) => {
    if (a.inScopePct !== b.inScopePct) return a.inScopePct - b.inScopePct;
    return b.fail - a.fail;
  });
  return scores.slice(0, limit);
}
