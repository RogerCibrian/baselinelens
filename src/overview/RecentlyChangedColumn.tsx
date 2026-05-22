import { LevelChip } from "../ui";

import type { RecentChange } from "./util";

/** One column of the recently-changed pair (Improved / Regressed): a
 * count, the capped list of rec rows, and a "view all in Console"
 * link when the bucket is larger than the cap. */
export function RecentlyChangedColumn({
  title,
  tone,
  symbol,
  items,
  total,
  onJump,
  onViewAll,
}: {
  title: string;
  tone: "pass" | "fail";
  symbol: string;
  items: RecentChange[];
  /** Pre-cap bucket size. When it exceeds the shown items, a footer
   * link offers the full list in the Console's matching delta view. */
  total: number;
  onJump: (recId: string) => void;
  onViewAll: () => void;
}) {
  return (
    <div className="recently-changed-col">
      <div className={`recently-changed-head tone-${tone}`}>
        <span aria-hidden="true">{symbol}</span>
        <span>{title}</span>
        <span className="recently-changed-count muted">· {total}</span>
      </div>
      {items.length === 0 ? (
        <p className="recently-changed-empty muted">None recently.</p>
      ) : (
        <>
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
                    <LevelChip level={rec.level} />
                  </div>
                  <div className="recently-changed-title">{rec.title}</div>
                </button>
              </li>
            ))}
          </ul>
          {total > items.length && (
            <button
              type="button"
              className="recently-changed-more"
              onClick={onViewAll}
            >
              View all {total} in Console →
            </button>
          )}
        </>
      )}
    </div>
  );
}
