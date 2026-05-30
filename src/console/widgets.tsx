import { Fragment, type ReactNode } from "react";

import type { Delta } from "../data/changes";
import { nextSort, type Sort, type SortKey } from "../data/consoleModel";
import type { EffectiveStatus } from "../data/score";

export function SortHeader({
  sort,
  onChange,
  keyName,
  children,
}: {
  sort: Sort;
  onChange: (next: Sort) => void;
  keyName: SortKey;
  children: ReactNode;
}) {
  const active = sort.key === keyName;
  return (
    <button
      type="button"
      className={`sort-header${active ? " sort-header-active" : ""}`}
      onClick={() => onChange(nextSort(sort, keyName))}
      aria-sort={
        active
          ? sort.direction === "asc"
            ? "ascending"
            : "descending"
          : "none"
      }
    >
      {children}
      {active && (
        <span className="sort-arrow" aria-hidden="true">
          {sort.direction === "asc" ? "▲" : "▼"}
        </span>
      )}
    </button>
  );
}

export function StatusPill({
  status,
  attested = false,
}: {
  status: EffectiveStatus;
  attested?: boolean;
}) {
  return (
    <span className={`status-pill status-${status}`}>
      {status}
      {attested && (
        <span className="tag-attested" title="Verdict recorded by an admin, not the automated scan">
          attested
        </span>
      )}
    </span>
  );
}

export function DeltaCell({ delta }: { delta: Delta }) {
  if (delta === "improved") {
    return (
      <span
        className="delta-marker delta-improved"
        aria-label="Remediated"
        title="Remediated"
      >
        ▲
      </span>
    );
  }
  if (delta === "regressed") {
    return (
      <span
        className="delta-marker delta-regressed"
        aria-label="Regressed"
        title="Regressed"
      >
        ▼
      </span>
    );
  }
  return null;
}

export function EmptyResults({ onClear }: { onClear: () => void }) {
  return (
    <div className="empty-state">
      <p className="muted">No recommendations match these filters.</p>
      <button type="button" className="button-secondary" onClick={onClear}>
        Clear filters
      </button>
    </div>
  );
}

/**
 * Inserts `<wbr>` after each backslash so long registry paths wrap at
 * segment boundaries (HKLM: / SOFTWARE / Policies / …) rather than
 * mid-token. Short paths stay on one line; long ones break readably.
 */
export function breakableRegistryPath(path: string): ReactNode {
  const parts = path.split(/(?<=\\)/);
  return parts.map((part, i) => (
    <Fragment key={i}>
      {part}
      {i < parts.length - 1 && <wbr />}
    </Fragment>
  ));
}

/**
 * Up/down caret for the drawer's prev/next controls. `up` steps to the
 * rec above in the list (previous); `down` steps below (next), matching
 * the vertical Console row order.
 */
export function NavChevron({ dir }: { dir: "up" | "down" }) {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 12 12"
      fill="none"
      aria-hidden="true"
      style={dir === "down" ? { transform: "rotate(180deg)" } : undefined}
    >
      <path
        d="M3 7.5 6 4.5 9 7.5"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/**
 * Chevron used by the rail collapse + reopen affordances. Points left
 * by default (collapse direction). Pass `flipped` to point right
 * (reopen direction shown on the filter-bar "Views" button).
 */
export function RailChevronIcon({ flipped = false }: { flipped?: boolean }) {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      style={flipped ? { transform: "rotate(180deg)" } : undefined}
    >
      <path d="M15 18l-6-6 6-6" />
    </svg>
  );
}

/** Down chevron for the filter/columns pills — replaces the prior
 * CSS gradient-triangle caret so it stays crisp at any display scale. */
export function SelectCaret() {
  return (
    <svg
      className="filter-pill-caret"
      width="10"
      height="10"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M6 9l6 6 6-6" />
    </svg>
  );
}
