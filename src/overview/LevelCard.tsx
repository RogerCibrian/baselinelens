import { type LevelScore } from "../data/score";
import { LevelChip, toneFor } from "../ui";

import { levelName } from "./util";

/** One per-level score card: in-scope pass rate, a passing/excluded
 * note, and a threshold bar. Clicking jumps to that level in the
 * Console. */
export function LevelCard({
  score,
  onJump,
}: {
  score: LevelScore;
  onJump: () => void;
}) {
  const tone = toneFor(score.inScopePct);
  // In-scope is the set that was actually evaluated: pass + fail.
  // Manual (no automated check), Pending (not scanned yet), accepted
  // exceptions, and errored checks are all excluded. The excluded
  // counts surface separately in the note.
  const inScopeDenom =
    score.total -
    score.manual -
    score.pending -
    score.exception -
    score.error;
  const inScopePct =
    score.inScopePct === null ? null : Math.round(score.inScopePct * 100);
  return (
    <button type="button" className="level-card" onClick={onJump}>
      <div className="level-card-head">
        <LevelChip level={score.level} />
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
        {score.pass} of {inScopeDenom} passing
        {score.error > 0 && ` · ${score.error} errored`}
        {score.exception > 0 &&
          ` · ${score.exception} exception${score.exception === 1 ? "" : "s"}`}
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
