import type { Level } from "./bindings";

export type Tone = "pass" | "warn" | "fail" | "neutral";

/**
 * Maps an in-scope pass rate to a tone class suffix. `null` (nothing
 * actionable yet) is `neutral`; otherwise >=80% passes, >=50% warns,
 * below that fails. Shared by Overview and the Console so the
 * thresholds are defined once.
 */
export function toneFor(pct: number | null): Tone {
  if (pct === null) return "neutral";
  if (pct >= 0.8) return "pass";
  if (pct >= 0.5) return "warn";
  return "fail";
}

/**
 * The L1/L2/BL level badge. Same markup wherever a recommendation or
 * level score shows its level, so the class derivation lives in one
 * place.
 */
export function LevelChip({ level }: { level: Level }) {
  return (
    <span className={`level-chip level-${level.toLowerCase()}`}>{level}</span>
  );
}
