import {
  Fragment,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

import { openUrl } from "@tauri-apps/plugin-opener";

import type {
  Baseline,
  ChangeEvent,
  Exception,
  Level,
  Note,
  Recommendation,
  Scan,
  ScanLoadErrors,
  ScanResult,
  UserState,
} from "./bindings";
import {
  computeDelta,
  indexLatestChanges,
  type Delta,
} from "./data/changes";
import {
  defaultConsoleFilter,
  type ConsoleFilter,
} from "./data/consoleFilter";
import {
  effectiveStatus,
  topLevelCategoryScores,
  type CategoryScore,
  type EffectiveStatus,
} from "./data/score";

type SortKey = "id" | "status" | "level" | "title" | "category";
type SortDirection = "asc" | "desc";
type Sort = { key: SortKey; direction: SortDirection };

const defaultSort: Sort = { key: "id", direction: "asc" };

export default function Console({
  baseline,
  scan,
  changes,
  loadErrors,
  userState,
  filter,
  onFilterChange,
  onUpdateUserState,
  onResetChanges,
}: {
  baseline: Baseline;
  scan: Scan;
  /** Per-rec scan-time status flips, oldest first. */
  changes: ChangeEvent[];
  /** Per-sub-file load failures keyed by sub-file. */
  loadErrors: ScanLoadErrors;
  userState: UserState;
  filter: ConsoleFilter;
  onFilterChange: (next: ConsoleFilter) => void;
  onUpdateUserState: (next: UserState) => void;
  /** Deletes the per-rec change log and reloads. Invoked from the inline
   * recovery action when `loadErrors.changes` is set. */
  onResetChanges: () => void;
}) {
  const [openRecId, setOpenRecId] = useState<string | null>(null);
  const [selectedRecId, setSelectedRecId] = useState<string | null>(null);
  const [sort, setSort] = useState<Sort>(defaultSort);

  const changesIndex = useMemo(() => indexLatestChanges(changes), [changes]);

  const filtered = useMemo(() => {
    const needle = filter.search.trim().toLowerCase();
    return baseline.recommendations.filter((rec) => {
      if (filter.level !== "all" && rec.level !== filter.level) return false;
      if (filter.category && !matchesCategory(rec.categoryNumber, filter.category)) {
        return false;
      }
      if (filter.status !== "all") {
        if (effectiveStatus(rec, scan, userState) !== filter.status) return false;
      }
      if (filter.delta !== "all") {
        if (computeDelta(rec, changesIndex, scan, userState) !== filter.delta) {
          return false;
        }
      }
      if (needle) {
        if (
          !rec.id.toLowerCase().includes(needle) &&
          !rec.title.toLowerCase().includes(needle)
        ) {
          return false;
        }
      }
      return true;
    });
  }, [baseline, scan, userState, filter, changesIndex]);

  const sorted = useMemo(() => {
    const out = [...filtered];
    const sign = sort.direction === "asc" ? 1 : -1;
    out.sort((a, b) => sign * compareRecs(a, b, sort.key, scan, userState));
    return out;
  }, [filtered, sort, scan, userState]);

  const openRec = openRecId
    ? (baseline.recommendations.find((r) => r.id === openRecId) ?? null)
    : null;

  // Resolved chip label for the active category filter — the local name
  // (last segment of the parsed full path) when available, otherwise the
  // chip falls back to just the number.
  const categoryName = useMemo(() => {
    if (!filter.category) return null;
    const cat = baseline.categories.find((c) => c.number === filter.category);
    if (!cat || !cat.name) return null;
    return cat.name.split(" - ").pop() ?? cat.name;
  }, [baseline, filter.category]);

  // Keyboard navigation. ArrowUp/ArrowDown move the selected row; Enter
  // opens the drawer for it. Skipped while the drawer is already open or
  // while the user is typing in a form field.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (openRecId !== null) return;
      const target = e.target as HTMLElement;
      const tag = target.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;

      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSelectedRecId((current) => {
          const idx = current
            ? sorted.findIndex((r) => r.id === current)
            : -1;
          return sorted[Math.min(idx + 1, sorted.length - 1)]?.id ?? current;
        });
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setSelectedRecId((current) => {
          const idx = current
            ? sorted.findIndex((r) => r.id === current)
            : sorted.length;
          return sorted[Math.max(idx - 1, 0)]?.id ?? current;
        });
      } else if (e.key === "Enter" && selectedRecId !== null) {
        e.preventDefault();
        setOpenRecId(selectedRecId);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [openRecId, selectedRecId, sorted]);

  function selectAndOpen(id: string) {
    setSelectedRecId(id);
    setOpenRecId(id);
  }

  return (
    <div className="console">
      <SavedViewRail
        baseline={baseline}
        scan={scan}
        userState={userState}
        changesIndex={changesIndex}
        filter={filter}
        onFilterChange={onFilterChange}
      />
      <div className="console-main">
        <FilterBar
          filter={filter}
          onFilterChange={onFilterChange}
          total={baseline.recommendations.length}
          shown={sorted.length}
          categoryName={categoryName}
        />
        {loadErrors.changes && (
          <p className="surface-notice">
            <span>Change history can't be read — Δ indicators disabled.</span>
            <button
              type="button"
              className="surface-notice-action"
              onClick={onResetChanges}
            >
              Reset change history
            </button>
          </p>
        )}
        {sorted.length === 0 ? (
          <EmptyResults
            onClear={() => onFilterChange(defaultConsoleFilter)}
          />
        ) : (
          <RecTable
            recs={sorted}
            scan={scan}
            changesIndex={changesIndex}
            userState={userState}
            sort={sort}
            onSortChange={setSort}
            selectedRecId={selectedRecId}
            onOpen={selectAndOpen}
          />
        )}
      </div>
      <DetailDrawer
        baseline={baseline}
        rec={openRec}
        scan={scan}
        userState={userState}
        changesIndex={changesIndex}
        onClose={() => setOpenRecId(null)}
        onUpdate={onUpdateUserState}
      />
    </div>
  );
}

/** Returns true when `recCategory` falls under the prefix `selected` —
 * matches either the exact number or anything below it (`"1"` matches
 * `"1.2.3"`). */
function matchesCategory(recCategory: string, selected: string): boolean {
  return recCategory === selected || recCategory.startsWith(selected + ".");
}

const LEVEL_RANK: Record<Level, number> = { L1: 1, L2: 2, BL: 3 };

function compareRecs(
  a: Recommendation,
  b: Recommendation,
  key: SortKey,
  scan: Scan,
  userState: UserState,
): number {
  switch (key) {
    case "id":
      return compareDottedNumbers(a.id, b.id);
    case "category":
      return compareDottedNumbers(a.categoryNumber, b.categoryNumber);
    case "level":
      return LEVEL_RANK[a.level] - LEVEL_RANK[b.level];
    case "title":
      return a.title.localeCompare(b.title);
    case "status": {
      const sa = effectiveStatus(a, scan, userState);
      const sb = effectiveStatus(b, scan, userState);
      return sa.localeCompare(sb);
    }
  }
}

/** Compares dotted-decimal IDs ("1.10" > "1.2") by treating each segment
 * as an integer rather than the lexicographic default. */
function compareDottedNumbers(a: string, b: string): number {
  const aParts = a.split(".").map((p) => Number(p) || 0);
  const bParts = b.split(".").map((p) => Number(p) || 0);
  const max = Math.max(aParts.length, bParts.length);
  for (let i = 0; i < max; i++) {
    const av = aParts[i] ?? 0;
    const bv = bParts[i] ?? 0;
    if (av !== bv) return av - bv;
  }
  return 0;
}

function nextSort(current: Sort, key: SortKey): Sort {
  if (current.key === key) {
    return { key, direction: current.direction === "asc" ? "desc" : "asc" };
  }
  return { key, direction: "asc" };
}

type SavedView = {
  id: string;
  name: string;
  description?: string;
  filter: Partial<ConsoleFilter>;
};

const SAVED_VIEWS: SavedView[] = [
  { id: "all", name: "All recommendations", filter: {} },
  {
    id: "open-fails",
    name: "Open fails",
    description: "Failing without an exception",
    filter: { status: "fail" },
  },
  {
    id: "exceptions",
    name: "Exceptions",
    description: "Accepted-risk decisions",
    filter: { status: "exception" },
  },
  {
    id: "manual",
    name: "Manual",
    description: "Needs human verification",
    filter: { status: "manual" },
  },
  {
    id: "errored",
    name: "Errored",
    description: "Audit couldn't complete",
    filter: { status: "error" },
  },
  {
    id: "passing",
    name: "Passing",
    filter: { status: "pass" },
  },
  {
    id: "regressed",
    name: "Regressed",
    description: "Flipped from pass to fail",
    filter: { delta: "regressed" },
  },
  {
    id: "recently-fixed",
    name: "Recently fixed",
    description: "Flipped from fail to pass",
    filter: { delta: "improved" },
  },
  {
    id: "bitlocker",
    name: "BitLocker only",
    filter: { level: "BL" },
  },
];

function SavedViewRail({
  baseline,
  scan,
  userState,
  changesIndex,
  filter,
  onFilterChange,
}: {
  baseline: Baseline;
  scan: Scan;
  userState: UserState;
  changesIndex: Map<string, ChangeEvent>;
  filter: ConsoleFilter;
  onFilterChange: (next: ConsoleFilter) => void;
}) {
  // Counts depend only on the data, not on the active filter — memoize
  // so flipping between views doesn't recompute every recommendation.
  const counts = useMemo(() => {
    const result: Record<string, number> = {};
    for (const view of SAVED_VIEWS) {
      const target = { ...defaultConsoleFilter, ...view.filter };
      result[view.id] = baseline.recommendations.filter((rec) => {
        if (target.level !== "all" && rec.level !== target.level) return false;
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
      <h3 className="rail-eyebrow">Views</h3>
      <ul className="saved-views">
        {SAVED_VIEWS.map((view) => {
          const active = isViewActive(view, filter);
          return (
            <li key={view.id}>
              <button
                type="button"
                className={`saved-view${active ? " saved-view-active" : ""}`}
                onClick={() =>
                  onFilterChange({ ...defaultConsoleFilter, ...view.filter })
                }
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

function toneFor(pct: number): "pass" | "warn" | "fail" {
  if (pct >= 0.8) return "pass";
  if (pct >= 0.5) return "warn";
  return "fail";
}

function isViewActive(view: SavedView, current: ConsoleFilter): boolean {
  const target = { ...defaultConsoleFilter, ...view.filter };
  return (
    target.level === current.level &&
    target.status === current.status &&
    target.category === current.category &&
    target.delta === current.delta &&
    target.search === current.search
  );
}

/**
 * Splits a PDF-extracted text blob into display paragraphs. The PDF
 * extractor keeps column-wrap newlines as literal `\n`, so we treat
 * blank lines as the real paragraph break and collapse run-of-whitespace
 * inside each paragraph to a single space.
 */
function paragraphs(text: string): string[] {
  return text
    .split(/\n\s*\n/)
    .map((p) => p.replace(/\s+/g, " ").trim())
    .filter((p) => p.length > 0);
}

function FilterBar({
  filter,
  onFilterChange,
  total,
  shown,
  categoryName,
}: {
  filter: ConsoleFilter;
  onFilterChange: (next: ConsoleFilter) => void;
  total: number;
  shown: number;
  /** Local name of the active category, or `null` when no name is known
   * (parser couldn't extract a heading). Shown alongside the number in
   * the chip; absence means the chip falls back to the bare number. */
  categoryName: string | null;
}) {
  return (
    <div className="filter-bar">
      <input
        type="search"
        className="filter-search"
        placeholder="Search id or title…"
        value={filter.search}
        onChange={(e) => onFilterChange({ ...filter, search: e.target.value })}
      />
      <FilterPill
        label="Status"
        value={filter.status}
        onChange={(v) =>
          onFilterChange({ ...filter, status: v as ConsoleFilter["status"] })
        }
        options={[
          { value: "all", label: "Any status" },
          { value: "pass", label: "Pass" },
          { value: "fail", label: "Fail" },
          { value: "exception", label: "Exception" },
          { value: "manual", label: "Manual" },
          { value: "error", label: "Error" },
        ]}
      />
      <FilterPill
        label="Level"
        value={filter.level}
        onChange={(v) =>
          onFilterChange({ ...filter, level: v as ConsoleFilter["level"] })
        }
        options={[
          { value: "all", label: "Any level" },
          { value: "L1", label: "L1" },
          { value: "L2", label: "L2" },
          { value: "BL", label: "BL" },
        ]}
      />
      {filter.category && (
        <button
          type="button"
          className="filter-chip"
          onClick={() => onFilterChange({ ...filter, category: null })}
          aria-label={`Clear category filter (${categoryName ?? filter.category})`}
          title={categoryName ? `${filter.category} — ${categoryName}` : filter.category}
        >
          <span className="mono filter-chip-num">{filter.category}</span>
          {categoryName && (
            <span className="filter-chip-name">{categoryName}</span>
          )}
          <span aria-hidden="true">×</span>
        </button>
      )}
      <span className="filter-bar-spacer" />
      <span className="muted mono filter-count">
        {shown} of {total}
      </span>
    </div>
  );
}

function FilterPill({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange: (next: string) => void;
  options: { value: string; label: string }[];
}) {
  const active = value !== "all";
  return (
    <label className={`filter-pill${active ? " filter-pill-active" : ""}`}>
      <span className="filter-pill-label">{label}</span>
      <select
        className="filter-pill-select"
        value={value}
        onChange={(e) => onChange(e.target.value)}
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}

function RecTable({
  recs,
  scan,
  changesIndex,
  userState,
  sort,
  onSortChange,
  selectedRecId,
  onOpen,
}: {
  recs: Recommendation[];
  scan: Scan;
  changesIndex: Map<string, ChangeEvent>;
  userState: UserState;
  sort: Sort;
  onSortChange: (next: Sort) => void;
  selectedRecId: string | null;
  onOpen: (recId: string) => void;
}) {
  return (
    <table className="rec-table">
      <thead>
        <tr>
          <th><SortHeader sort={sort} onChange={onSortChange} keyName="id">ID</SortHeader></th>
          <th><SortHeader sort={sort} onChange={onSortChange} keyName="status">Status</SortHeader></th>
          <th><SortHeader sort={sort} onChange={onSortChange} keyName="level">Level</SortHeader></th>
          <th><SortHeader sort={sort} onChange={onSortChange} keyName="title">Title</SortHeader></th>
          <th><SortHeader sort={sort} onChange={onSortChange} keyName="category">Category</SortHeader></th>
          <th className="rec-table-delta-col" aria-label="Change">Δ</th>
        </tr>
      </thead>
      <tbody>
        {recs.map((rec) => {
          const status = effectiveStatus(rec, scan, userState);
          const delta = computeDelta(rec, changesIndex, scan, userState);
          const selected = rec.id === selectedRecId;
          return (
            <tr
              key={rec.id}
              onClick={() => onOpen(rec.id)}
              className={selected ? "rec-row-selected" : ""}
              aria-selected={selected}
            >
              <td className="mono">{rec.id}</td>
              <td>
                <StatusPill status={status} />
              </td>
              <td>
                <span className={`level-chip level-${rec.level.toLowerCase()}`}>
                  {rec.level}
                </span>
              </td>
              <td>{rec.title}</td>
              <td className="muted mono">{rec.categoryNumber}</td>
              <td className="rec-table-delta-col">
                <DeltaCell delta={delta} />
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function SortHeader({
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

function StatusPill({ status }: { status: EffectiveStatus }) {
  return (
    <span className={`status-pill status-${status}`}>{status}</span>
  );
}

function DeltaCell({ delta }: { delta: Delta }) {
  if (delta === "improved") {
    return (
      <span className="delta-marker delta-improved" aria-label="Improved">
        ▲
      </span>
    );
  }
  if (delta === "regressed") {
    return (
      <span className="delta-marker delta-regressed" aria-label="Regressed">
        ▼
      </span>
    );
  }
  return null;
}

function EmptyResults({ onClear }: { onClear: () => void }) {
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
 * Slide-in detail panel for a single recommendation. Exception and note
 * fields edit local form state; clicking Save flushes a new UserState
 * upward via `onUpdate`, which the parent persists. The form is reset
 * whenever `rec` changes so switching rows doesn't bleed values.
 */
function DetailDrawer({
  baseline,
  rec,
  scan,
  userState,
  changesIndex,
  onClose,
  onUpdate,
}: {
  baseline: Baseline;
  rec: Recommendation | null;
  scan: Scan;
  userState: UserState;
  /** Latest ChangeEvent per rec; lets the drawer compute "Failing for"
   * / "Passing for" by reading when the rec last flipped into its
   * current scan-time status. */
  changesIndex: Map<string, ChangeEvent>;
  onClose: () => void;
  onUpdate: (next: UserState) => void;
}) {
  const [exceptionReason, setExceptionReason] = useState("");
  const [exceptionGrantedBy, setExceptionGrantedBy] = useState("");
  const [noteText, setNoteText] = useState("");
  const [savedFlash, setSavedFlash] = useState<"exception" | "note" | null>(null);
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!rec) return;
    const ex = userState.exceptions[rec.id];
    const note = userState.notes[rec.id];
    setExceptionReason(ex?.reason ?? "");
    setExceptionGrantedBy(ex?.grantedBy ?? "");
    setNoteText(note?.text ?? "");
  }, [rec, userState]);

  const isOpen = rec !== null;

  // Focus the close button when the drawer transitions from closed to
  // open. Tab moves on into the form, and Esc has somewhere to live.
  useEffect(() => {
    if (isOpen) closeRef.current?.focus();
  }, [isOpen]);

  // Esc closes from anywhere while the drawer is open.
  useEffect(() => {
    if (!isOpen) return;
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [isOpen, onClose]);

  // Briefly shows "Saved" next to the action button. The closure-captured
  // `which` means rapid back-to-back saves don't clobber each other's flash.
  function flashSaved(which: "exception" | "note") {
    setSavedFlash(which);
    setTimeout(() => {
      setSavedFlash((prev) => (prev === which ? null : prev));
    }, 2000);
  }

  function saveException() {
    if (!rec) return;
    const existing = userState.exceptions[rec.id];
    const next: Exception = {
      reason: exceptionReason.trim(),
      // Preserve the original timestamp on edits so the audit history
      // reflects when the decision was first made.
      grantedAt: existing?.grantedAt ?? new Date().toISOString(),
      grantedBy: exceptionGrantedBy.trim() || null,
    };
    onUpdate({
      ...userState,
      exceptions: { ...userState.exceptions, [rec.id]: next },
    });
    flashSaved("exception");
  }

  function clearException() {
    if (!rec) return;
    const exceptions = { ...userState.exceptions };
    delete exceptions[rec.id];
    onUpdate({ ...userState, exceptions });
  }

  function saveNote() {
    if (!rec) return;
    const next: Note = {
      text: noteText.trim(),
      updatedAt: new Date().toISOString(),
    };
    onUpdate({
      ...userState,
      notes: { ...userState.notes, [rec.id]: next },
    });
    flashSaved("note");
  }

  function clearNote() {
    if (!rec) return;
    const notes = { ...userState.notes };
    delete notes[rec.id];
    onUpdate({ ...userState, notes });
  }

  const status = rec ? effectiveStatus(rec, scan, userState) : null;
  const hasException = rec ? userState.exceptions[rec.id] !== undefined : false;
  const hasNote = rec ? userState.notes[rec.id] !== undefined : false;

  // Duration since the rec last flipped into its current status. Only
  // computed for pass/fail — Manual/Error/Pending have no meaningful
  // duration, and Exception is shadowed by the user's accept-decision
  // (the Exception section below shows when that was granted).
  const stateAge = useMemo(() => {
    if (!rec || (status !== "fail" && status !== "pass")) return null;
    const latest = changesIndex.get(rec.id);
    if (!latest) return null;
    const targetToStatus = status === "fail" ? "Fail" : "Pass";
    // Skip when the latest change event's toStatus doesn't match the
    // current scan-time status — the index and the live scan disagree
    // (e.g. mid-stream rescan); avoid stitching a misleading duration.
    if (latest.toStatus !== targetToStatus) return null;
    return {
      label: status === "fail" ? "Failing for" : "Passing for",
      since: latest.observedAt,
    };
  }, [rec, status, changesIndex]);

  return (
    <div className={`drawer-overlay${isOpen ? " drawer-overlay-open" : ""}`}>
      <div
        className="drawer-backdrop"
        onClick={onClose}
        aria-hidden="true"
      />
      <aside className="drawer" role="dialog" aria-modal="true">
        {rec && (
          <>
            <header className="drawer-head">
              <div className="drawer-head-row">
                <span className="mono drawer-id">{rec.id}</span>
                <button
                  ref={closeRef}
                  type="button"
                  className="drawer-close"
                  onClick={onClose}
                  aria-label="Close drawer"
                >
                  ×
                </button>
              </div>
              <div className="drawer-chips">
                <span className={`level-chip level-${rec.level.toLowerCase()}`}>
                  {rec.level}
                </span>
                {status && <StatusPill status={status} />}
                <span className="chip-neutral">
                  {rec.assessment === "Automated"
                    ? "Automated"
                    : "Manual check"}
                </span>
              </div>
              <h2 className="drawer-title">{rec.title}</h2>
              <DrawerCategoryMeta
                baseline={baseline}
                number={rec.categoryNumber}
              />
            </header>

            <div className="drawer-body">
              {rec.description && (
                <DrawerText title="Description" text={rec.description} />
              )}
              {rec.rationale && (
                <DrawerText title="Rationale" text={rec.rationale} />
              )}

              <ScanResultSection
                result={scan.results[rec.id]}
                stateAge={stateAge}
              />

              <section className="drawer-section">
                <h4 className="section-eyebrow">Exception</h4>
                <p className="muted drawer-help">
                  Granting an exception treats this rec as a pass for the
                  In-scope score.
                </p>
                <label>
                  Reason
                  <textarea
                    rows={3}
                    value={exceptionReason}
                    onChange={(e) => setExceptionReason(e.target.value)}
                  />
                </label>
                <label>
                  Granted by (optional)
                  <input
                    type="text"
                    value={exceptionGrantedBy}
                    onChange={(e) => setExceptionGrantedBy(e.target.value)}
                  />
                </label>
                <div className="drawer-actions">
                  <button
                    type="button"
                    className="button-primary"
                    onClick={saveException}
                    disabled={!exceptionReason.trim()}
                  >
                    Save exception
                  </button>
                  {hasException && (
                    <button
                      type="button"
                      className="button-secondary"
                      onClick={clearException}
                    >
                      Remove
                    </button>
                  )}
                  {savedFlash === "exception" && (
                    <span className="saved-flash" role="status">Saved</span>
                  )}
                </div>
              </section>

              <section className="drawer-section">
                <h4 className="section-eyebrow">Note</h4>
                <label>
                  Free-form context — doesn't affect status
                  <textarea
                    rows={4}
                    value={noteText}
                    onChange={(e) => setNoteText(e.target.value)}
                  />
                </label>
                <div className="drawer-actions">
                  <button
                    type="button"
                    className="button-primary"
                    onClick={saveNote}
                    disabled={!noteText.trim()}
                  >
                    Save note
                  </button>
                  {hasNote && (
                    <button
                      type="button"
                      className="button-secondary"
                      onClick={clearNote}
                    >
                      Remove
                    </button>
                  )}
                  {savedFlash === "note" && (
                    <span className="saved-flash" role="status">Saved</span>
                  )}
                </div>
              </section>

              {rec.references.length > 0 && (
                <section className="drawer-section">
                  <h4 className="section-eyebrow">References</h4>
                  <ul className="drawer-references">
                    {rec.references.map((ref, i) => (
                      <li key={i}>
                        {ref.type === "Url" ? (
                          <a
                            href={ref.url}
                            onClick={(e) => {
                              // Default link click would navigate the
                              // Tauri webview itself — open in the
                              // system browser instead.
                              e.preventDefault();
                              void openUrl(ref.url);
                            }}
                          >
                            {ref.url}
                          </a>
                        ) : (
                          <span>{ref.text}</span>
                        )}
                      </li>
                    ))}
                  </ul>
                </section>
              )}
            </div>
          </>
        )}
      </aside>
    </div>
  );
}

/**
 * Renders one text section of the drawer body — a heading and one
 * `<p>` per paragraph parsed out of `text`.
 */
function DrawerText({ title, text }: { title: string; text: string }) {
  return (
    <section className="drawer-section">
      <h4 className="section-eyebrow">{title}</h4>
      {paragraphs(text).map((para, i) => (
        <p key={i} className="drawer-text">
          {para}
        </p>
      ))}
    </section>
  );
}

/**
 * Renders the small "{number} {local name}" context line beneath the
 * drawer's title. Falls back to the bare number when the parser
 * couldn't extract a heading for that section.
 */
function DrawerCategoryMeta({
  baseline,
  number,
}: {
  baseline: Baseline;
  number: string;
}) {
  const cat = baseline.categories.find((c) => c.number === number);
  // `cat.name` is the parser's full hierarchical path joined with " - ";
  // the leaf segment is the local section heading.
  const localName = cat?.name ? (cat.name.split(" - ").pop() ?? null) : null;
  return (
    <p className="drawer-meta">
      <span className="mono drawer-meta-num">{number}</span>
      {localName && <span className="drawer-meta-name">{localName}</span>}
    </p>
  );
}

/**
 * Shows the scan verdict for the open rec. When `result.checks` is
 * populated (real scans), renders a per-check table — one row per
 * registry value or conceptual check, with full path + value name +
 * expected predicate + actual reading + pass/fail. Falls back to the
 * flat `expected` / `currentValue` strings when checks aren't
 * available (mock scans, errors that short-circuited before
 * enumerating).
 */
function ScanResultSection({
  result,
  stateAge,
}: {
  result: ScanResult | undefined;
  stateAge: { label: string; since: string } | null;
}) {
  if (!result) return null;
  const hasChecks = result.checks && result.checks.length > 0;
  return (
    <section className="drawer-section">
      <h4 className="section-eyebrow">Scan result</h4>
      <dl className="drawer-kv">
        <dt>Status</dt>
        <dd className={`scan-status scan-status-${result.status.toLowerCase()}`}>
          {result.status}
        </dd>
        <dt>Last scanned</dt>
        <dd className="mono">{formatScanTimestamp(result.measuredAt)}</dd>
        {stateAge && (
          <>
            <dt>{stateAge.label}</dt>
            <dd className="mono">{formatAge(stateAge.since)}</dd>
          </>
        )}
        {result.error && (
          <>
            <dt>Error</dt>
            <dd className="mono">{result.error}</dd>
          </>
        )}
        {!hasChecks && result.expected && (
          <>
            <dt>Expected</dt>
            <dd className="mono">{result.expected}</dd>
          </>
        )}
        {!hasChecks && result.currentValue && (
          <>
            <dt>Found</dt>
            <dd className="mono">{result.currentValue}</dd>
          </>
        )}
      </dl>
      {hasChecks && (
        <table className="checks-table mono">
          <thead>
            <tr>
              <th>Path</th>
              <th>Value</th>
              <th>Expected</th>
              <th>Found</th>
            </tr>
          </thead>
          <tbody>
            {result.checks!.map((c, i) => (
              <tr key={i}>
                <td>{breakableRegistryPath(c.path)}</td>
                <td>{c.valueName}</td>
                <td>{c.expected}</td>
                <td>
                  {c.actual ?? <span className="muted-italic">absent</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

/** YYYY-MM-DD HH:MM — terse, mono, sortable. Mirrors the top bar's
 * timestamp style for consistency. */
function formatScanTimestamp(iso: string): string {
  return iso.slice(0, 16).replace("T", " ");
}

/** Coarse duration from `fromIso` to now, in the largest unit that
 * still reads cleanly: "12 days", "3 hours", "5 months". */
function formatAge(fromIso: string): string {
  const elapsedMs = Date.now() - Date.parse(fromIso);
  const minutes = Math.floor(elapsedMs / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"}`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"}`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days} day${days === 1 ? "" : "s"}`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months} month${months === 1 ? "" : "s"}`;
  const years = Math.floor(days / 365);
  return `${years} year${years === 1 ? "" : "s"}`;
}

/**
 * Inserts `<wbr>` after each backslash so long registry paths wrap at
 * segment boundaries (HKLM: / SOFTWARE / Policies / …) rather than
 * mid-token. Short paths stay on one line; long ones break readably.
 */
function breakableRegistryPath(path: string): ReactNode {
  const parts = path.split(/(?<=\\)/);
  return parts.map((part, i) => (
    <Fragment key={i}>
      {part}
      {i < parts.length - 1 && <wbr />}
    </Fragment>
  ));
}
