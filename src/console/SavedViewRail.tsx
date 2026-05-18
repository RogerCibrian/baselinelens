import { useMemo } from "react";

import type { Baseline, ChangeEvent, Scan, UserState } from "../bindings";
import { computeDelta } from "../data/changes";
import {
  defaultConsoleFilter,
  type ConsoleFilter,
} from "../data/consoleFilter";
import { isViewActive, SAVED_VIEWS } from "../data/consoleModel";
import {
  effectiveStatus,
  topLevelCategoryScores,
  type CategoryScore,
} from "../data/score";
import { toneFor } from "../ui";
import { RailChevronIcon } from "./widgets";

export function SavedViewRail({
  baseline,
  scan,
  userState,
  changesIndex,
  filter,
  onFilterChange,
  onCollapse,
}: {
  baseline: Baseline;
  scan: Scan;
  userState: UserState;
  changesIndex: Map<string, ChangeEvent>;
  filter: ConsoleFilter;
  onFilterChange: (next: ConsoleFilter) => void;
  /** Hides the rail; the filter bar gains a "Views" button to bring
   * it back. */
  onCollapse: () => void;
}) {
  // Counts depend only on the data, not on the active filter — memoize
  // so flipping between views doesn't recompute every recommendation.
  const counts = useMemo(() => {
    const result: Record<string, number> = {};
    for (const view of SAVED_VIEWS) {
      const target = { ...defaultConsoleFilter, ...view.filter };
      result[view.id] = baseline.recommendations.filter((rec) => {
        if (target.level !== "all" && rec.level !== target.level) return false;
        if (target.bitlocker === "only" && !rec.bitlocker) return false;
        if (target.status !== "all") {
          if (effectiveStatus(rec, scan, userState) !== target.status) {
            return false;
          }
        }
        if (target.delta !== "all") {
          if (computeDelta(rec, changesIndex, scan, userState) !== target.delta) {
            return false;
          }
        }
        return true;
      }).length;
    }
    return result;
  }, [baseline, scan, userState, changesIndex]);

  const categories = useMemo(
    () => topLevelCategoryScores(baseline, scan, userState),
    [baseline, scan, userState],
  );

  return (
    <aside className="saved-view-rail">
      <div className="rail-header">
        <h3 className="rail-eyebrow">Views</h3>
        <button
          type="button"
          className="rail-collapse"
          onClick={onCollapse}
          aria-label="Hide views"
          title="Hide views"
        >
          <RailChevronIcon />
        </button>
      </div>
      <ul className="saved-views">
        {SAVED_VIEWS.filter(
          (view) =>
            // "All" is the reset anchor and always shown. Otherwise a
            // view is hidden once nothing matches it — a zero-count
            // view is dead weight regardless of which status it is. The
            // active view is kept even at zero so it stays highlighted
            // and toggleable instead of vanishing mid-use.
            view.id === "all" ||
            counts[view.id] > 0 ||
            isViewActive(view, filter),
        ).map((view) => {
          const active = isViewActive(view, filter);
          return (
            <li key={view.id}>
              <button
                type="button"
                className={`saved-view${active ? " saved-view-active" : ""}`}
                onClick={() => {
                  const keys = Object.keys(
                    view.filter,
                  ) as (keyof ConsoleFilter)[];
                  // Empty filter = the "All" view: a true reset.
                  if (keys.length === 0) {
                    onFilterChange(defaultConsoleFilter);
                    return;
                  }
                  // Active → toggle off: restore this view's fields to
                  // their defaults, keeping any category/search and
                  // other composed views. Inactive → merge its fields
                  // onto the current filter so it composes with a
                  // selected category/search, matching the Categories
                  // list below.
                  onFilterChange(
                    active
                      ? keys.reduce(
                          (acc, key) => ({
                            ...acc,
                            [key]: defaultConsoleFilter[key],
                          }),
                          filter,
                        )
                      : { ...filter, ...view.filter },
                  );
                }}
              >
                <span className="saved-view-text">
                  <span className="saved-view-name">{view.name}</span>
                  {view.description && (
                    <span className="saved-view-description">
                      {view.description}
                    </span>
                  )}
                </span>
                <span className="saved-view-count mono">
                  {counts[view.id]}
                </span>
              </button>
            </li>
          );
        })}
      </ul>

      <h3 className="rail-eyebrow rail-eyebrow-secondary">Categories</h3>
      <ul className="saved-views">
        {categories.map((cat) => (
          <CategoryRailRow
            key={cat.number}
            score={cat}
            active={filter.category === cat.number}
            onClick={() =>
              onFilterChange({
                ...filter,
                category: filter.category === cat.number ? null : cat.number,
              })
            }
          />
        ))}
      </ul>
    </aside>
  );
}

function CategoryRailRow({
  score,
  active,
  onClick,
}: {
  score: CategoryScore;
  active: boolean;
  onClick: () => void;
}) {
  const tone = toneFor(score.inScopePct);
  const label = score.name ? `${score.number} ${score.name}` : score.number;
  return (
    <li>
      <button
        type="button"
        className={`saved-view category-rail-row${active ? " saved-view-active" : ""}`}
        onClick={onClick}
        title={label}
      >
        <span className="category-rail-label">{label}</span>
        {score.inScope > 0 && (
          <span className={`category-rail-bar tone-${tone}`}>
            <span
              className="category-bar-fill"
              style={{ width: `${score.inScopePct * 100}%` }}
            />
          </span>
        )}
        <span className="saved-view-count mono">{score.total}</span>
      </button>
    </li>
  );
}
