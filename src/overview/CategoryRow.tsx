import { type CategoryScore } from "../data/score";
import { toneFor } from "../ui";

/** One weakest-category row: number + leaf name, in-scope pass rate, a
 * bar, and a fail/pass breakdown. Clicking filters the Console to the
 * category. */
export function CategoryRow({
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
          {score.error > 0 && (
            <>
              <span aria-hidden="true">·</span>
              <span>{score.error} errored</span>
            </>
          )}
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
