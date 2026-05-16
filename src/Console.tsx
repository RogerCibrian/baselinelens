import {
  Fragment,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

import { save } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";

import { commands } from "./bindings";
import type {
  Baseline,
  ChangeEvent,
  Density,
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
import { type ConsoleColumns } from "./data/consoleColumns";
import {
  defaultConsoleFilter,
  type ConsoleFilter,
} from "./data/consoleFilter";
import { buildCsv, buildJson } from "./data/exportScan";
import {
  effectiveStatus,
  topLevelCategoryScores,
  type CategoryScore,
  type EffectiveStatus,
} from "./data/score";
import ConfirmDialog from "./ConfirmDialog";
import { formatAge, formatTimestamp } from "./format";
import { useFocusTrap } from "./hooks";

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
  columns,
  onColumnsChange,
  railCollapsed,
  onRailCollapsedChange,
  density,
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
  /** Visibility flags for the table's optional columns. */
  columns: ConsoleColumns;
  onColumnsChange: (next: ConsoleColumns) => void;
  /** Whether the Views/Categories rail is collapsed (hidden). When
   * true, the rail unmounts and the filter bar gains a "Views" button
   * that reopens it. */
  railCollapsed: boolean;
  onRailCollapsedChange: (next: boolean) => void;
  /** Table row spacing — applied as `data-density` for the CSS to
   * tighten or relax row padding. */
  density: Density;
  onUpdateUserState: (next: UserState) => Promise<boolean>;
  /** Deletes the per-rec change log and reloads. Invoked from the inline
   * recovery action when `loadErrors.changes` is set. */
  onResetChanges: () => void;
}) {
  const [openRecId, setOpenRecId] = useState<string | null>(null);
  const [selectedRecId, setSelectedRecId] = useState<string | null>(null);
  const [sort, setSort] = useState<Sort>(defaultSort);
  const [exportError, setExportError] = useState<string | null>(null);

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

  // Position of the open rec within the list as currently filtered and
  // sorted, so the drawer's prev/next walks exactly what the table
  // shows. -1 while the drawer is closed or the open rec was filtered
  // out from under it.
  const openIndex = openRecId
    ? sorted.findIndex((r) => r.id === openRecId)
    : -1;
  const prevRecId = openIndex > 0 ? sorted[openIndex - 1].id : null;
  const nextRecId =
    openIndex >= 0 && openIndex < sorted.length - 1
      ? sorted[openIndex + 1].id
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

  // Map of category number → local name for the table's Category cell.
  // Pre-computed once per baseline so each row gets an O(1) lookup
  // instead of scanning `baseline.categories` per render.
  const categoryNamesByNumber = useMemo(() => {
    const map = new Map<string, string>();
    for (const cat of baseline.categories) {
      const localName = cat.name?.split(" - ").pop() ?? cat.name ?? "";
      if (localName) map.set(cat.number, localName);
    }
    return map;
  }, [baseline.categories]);

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

  // Composed here (not in Rust) so the export matches the console
  // exactly — effective status, exceptions, notes, and the
  // human-readable strings all already live in this tree.
  async function exportResults(format: "csv" | "json") {
    setExportError(null);
    const path = await save({
      defaultPath: `baselinelens-results.${format}`,
      filters: [{ name: format.toUpperCase(), extensions: [format] }],
    });
    if (!path) return;
    const contents =
      format === "csv"
        ? buildCsv(baseline, scan, userState)
        : buildJson(baseline, scan, userState);
    const result = await commands.writeExport(path, contents);
    if (result.status !== "ok") setExportError(result.error);
  }

  return (
    <div
      className={`console${railCollapsed ? " console-rail-collapsed" : ""}`}
      data-density={density}
    >
      {!railCollapsed && (
        <SavedViewRail
          baseline={baseline}
          scan={scan}
          userState={userState}
          changesIndex={changesIndex}
          filter={filter}
          onFilterChange={onFilterChange}
          onCollapse={() => onRailCollapsedChange(true)}
        />
      )}
      <div className="console-main">
        <FilterBar
          filter={filter}
          onFilterChange={onFilterChange}
          columns={columns}
          onColumnsChange={onColumnsChange}
          showViewsButton={railCollapsed}
          onShowViews={() => onRailCollapsedChange(false)}
          total={baseline.recommendations.length}
          shown={sorted.length}
          categoryName={categoryName}
          onExport={(format) => void exportResults(format)}
        />
        {exportError && (
          <p className="surface-notice">
            <span>Export failed: {exportError}</span>
            <button
              type="button"
              className="surface-notice-action"
              onClick={() => setExportError(null)}
            >
              Dismiss
            </button>
          </p>
        )}
        {loadErrors.changes && (
          <p className="surface-notice">
            <span>
              Change history can't be read — change indicators disabled.
            </span>
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
          <>
          <p className="rec-table-hint muted">
            Click a row to open it · ↑ ↓ to move, Enter to open
          </p>
          <RecTable
            recs={sorted}
            scan={scan}
            changesIndex={changesIndex}
            userState={userState}
            sort={sort}
            onSortChange={setSort}
            columns={columns}
            categoryNames={categoryNamesByNumber}
            selectedRecId={selectedRecId}
            onOpen={selectAndOpen}
          />
          </>
        )}
      </div>
      <DetailDrawer
        baseline={baseline}
        rec={openRec}
        scan={scan}
        userState={userState}
        changesIndex={changesIndex}
        prevRecId={prevRecId}
        nextRecId={nextRecId}
        position={openIndex >= 0 ? openIndex + 1 : null}
        total={sorted.length}
        onNavigate={selectAndOpen}
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
    description: "Currently meeting the baseline",
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
    description: "BitLocker profile recommendations",
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
        {SAVED_VIEWS.map((view) => {
          const active = isViewActive(view, filter);
          return (
            <li key={view.id}>
              <button
                type="button"
                className={`saved-view${active ? " saved-view-active" : ""}`}
                onClick={() =>
                  onFilterChange(
                    // Empty filter = the "All" view: a true reset.
                    // Every other view merges its fields onto the
                    // current filter so it composes with a selected
                    // category/search — the same merge semantics the
                    // Categories list below uses, so the two rail
                    // sections behave the same way.
                    Object.keys(view.filter).length === 0
                      ? defaultConsoleFilter
                      : { ...filter, ...view.filter },
                  )
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

/**
 * A view is highlighted when the fields it defines match the current
 * filter — category and search (orthogonal refinements) are ignored so
 * a view stays selected after the user also picks a category. The empty
 * "All" view is active only when nothing is filtered at all.
 */
function isViewActive(view: SavedView, current: ConsoleFilter): boolean {
  const keys = Object.keys(view.filter) as (keyof ConsoleFilter)[];
  if (keys.length === 0) {
    return (
      current.level === "all" &&
      current.status === "all" &&
      current.category === null &&
      current.delta === "all" &&
      current.search.trim() === ""
    );
  }
  return keys.every((key) => current[key] === view.filter[key]);
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
  columns,
  onColumnsChange,
  showViewsButton,
  onShowViews,
  total,
  shown,
  categoryName,
  onExport,
}: {
  filter: ConsoleFilter;
  onFilterChange: (next: ConsoleFilter) => void;
  columns: ConsoleColumns;
  onColumnsChange: (next: ConsoleColumns) => void;
  /** True when the rail is collapsed; the bar shows a "Views" button
   * on the left to bring it back. */
  showViewsButton: boolean;
  onShowViews: () => void;
  total: number;
  shown: number;
  /** Local name of the active category, or `null` when no name is known
   * (parser couldn't extract a heading). Shown alongside the number in
   * the chip; absence means the chip falls back to the bare number. */
  categoryName: string | null;
  onExport: (format: "csv" | "json") => void;
}) {
  // Local draft so each keystroke is instant while the (per-rec
  // effectiveStatus/computeDelta) filter recompute is debounced —
  // typing in a 500-rec baseline shouldn't re-filter on every key.
  const [draft, setDraft] = useState(filter.search);
  useEffect(() => {
    setDraft(filter.search);
  }, [filter.search]);
  useEffect(() => {
    if (draft === filter.search) return;
    const timer = setTimeout(
      () => onFilterChange({ ...filter, search: draft }),
      200,
    );
    return () => clearTimeout(timer);
    // Re-running only on `draft` is intentional: an external filter
    // change resyncs the draft above, which no-ops this effect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft]);

  const anyActive =
    filter.level !== "all" ||
    filter.status !== "all" ||
    filter.category !== null ||
    filter.delta !== "all" ||
    filter.search.trim() !== "";

  return (
    <div className="filter-bar">
      {showViewsButton && (
        <button
          type="button"
          className="filter-pill"
          onClick={onShowViews}
          title="Show views"
        >
          <RailChevronIcon flipped />
          <span className="filter-pill-label">Views</span>
        </button>
      )}
      <input
        type="search"
        className="filter-search"
        placeholder="Search id or title…"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
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
      <ColumnsMenu columns={columns} onChange={onColumnsChange} />
      {anyActive && (
        <button
          type="button"
          className="filter-clear"
          onClick={() => {
            setDraft("");
            onFilterChange(defaultConsoleFilter);
          }}
        >
          Clear filters
        </button>
      )}
      <span className="filter-bar-spacer" />
      <span className="muted mono filter-count">
        {shown} of {total}
      </span>
      <ExportMenu onExport={onExport} />
    </div>
  );
}

/**
 * Pill-styled popover offering CSV / JSON download of the full result
 * set. Mirrors ColumnsMenu's open/close behavior so the toolbar
 * dropdowns are consistent. The composition itself lives in the
 * Console (it owns baseline/scan/userState); this just triggers it.
 */
function ExportMenu({
  onExport,
}: {
  onExport: (format: "csv" | "json") => void;
}) {
  const [open, setOpen] = useState(false);
  const wrapperRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onMouseDown(e: MouseEvent) {
      if (!wrapperRef.current?.contains(e.target as Node)) setOpen(false);
    }
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onMouseDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onMouseDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  function pick(format: "csv" | "json") {
    setOpen(false);
    onExport(format);
  }

  return (
    <div className="columns-menu" ref={wrapperRef}>
      <button
        type="button"
        className="filter-pill columns-menu-trigger"
        onClick={() => setOpen((current) => !current)}
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <span className="filter-pill-label">Export</span>
        <SelectCaret />
      </button>
      {open && (
        <div className="columns-menu-popover" role="menu">
          <button
            type="button"
            role="menuitem"
            className="columns-menu-action"
            onClick={() => pick("csv")}
          >
            Export as CSV
          </button>
          <button
            type="button"
            role="menuitem"
            className="columns-menu-action"
            onClick={() => pick("json")}
          >
            Export as JSON
          </button>
        </div>
      )}
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
      <SelectCaret />
    </label>
  );
}

/**
 * Pill-styled popover that toggles the table's optional columns. Each
 * column is a tri-state from the rendering side (hidden / shown), but
 * the menu just exposes a checkbox per column. Closes on outside click
 * and Escape to match the other dropdowns in the app.
 */
function ColumnsMenu({
  columns,
  onChange,
}: {
  columns: ConsoleColumns;
  onChange: (next: ConsoleColumns) => void;
}) {
  const [open, setOpen] = useState(false);
  const wrapperRef = useRef<HTMLDivElement>(null);
  // Visible-column count for the trigger badge: the two always-on
  // columns (ID + Status) plus whichever toggleable ones are checked.
  const count =
    2 +
    (columns.level ? 1 : 0) +
    (columns.title ? 1 : 0) +
    (columns.category ? 1 : 0) +
    (columns.expected ? 1 : 0) +
    (columns.found ? 1 : 0);

  useEffect(() => {
    if (!open) return;
    function onMouseDown(e: MouseEvent) {
      if (!wrapperRef.current?.contains(e.target as Node)) setOpen(false);
    }
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onMouseDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onMouseDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  const items: { key: keyof ConsoleColumns; label: string }[] = [
    { key: "level", label: "Level" },
    { key: "title", label: "Title" },
    { key: "category", label: "Category" },
    { key: "expected", label: "Expected" },
    { key: "found", label: "Found" },
  ];

  return (
    <div className="columns-menu" ref={wrapperRef}>
      <button
        type="button"
        className="filter-pill columns-menu-trigger"
        onClick={() => setOpen((current) => !current)}
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <span className="filter-pill-label">Edit columns</span>
        <span className="filter-pill-select">{count}</span>
        <SelectCaret />
      </button>
      {open && (
        <div className="columns-menu-popover" role="menu">
          <div className="columns-menu-locked" aria-hidden="true">
            ID and Status are always shown.
          </div>
          {items.map(({ key, label }) => (
            <label key={key} className="columns-menu-item">
              <input
                type="checkbox"
                checked={columns[key]}
                onChange={(e) =>
                  onChange({ ...columns, [key]: e.target.checked })
                }
              />
              {label}
            </label>
          ))}
        </div>
      )}
    </div>
  );
}

function RecTable({
  recs,
  scan,
  changesIndex,
  userState,
  sort,
  onSortChange,
  columns,
  categoryNames,
  selectedRecId,
  onOpen,
}: {
  recs: Recommendation[];
  scan: Scan;
  changesIndex: Map<string, ChangeEvent>;
  userState: UserState;
  sort: Sort;
  onSortChange: (next: Sort) => void;
  columns: ConsoleColumns;
  /** Lookup from category number to its display name; used by the
   * Category cell so the user sees "Account Policies" instead of
   * "1.1.2". The number is preserved as a tooltip for reference. */
  categoryNames: Map<string, string>;
  selectedRecId: string | null;
  onOpen: (recId: string) => void;
}) {
  return (
    <table className="rec-table">
      <thead>
        <tr>
          <th><SortHeader sort={sort} onChange={onSortChange} keyName="id">ID</SortHeader></th>
          <th><SortHeader sort={sort} onChange={onSortChange} keyName="status">Status</SortHeader></th>
          {columns.level && (
            <th><SortHeader sort={sort} onChange={onSortChange} keyName="level">Level</SortHeader></th>
          )}
          {columns.title && (
            <th><SortHeader sort={sort} onChange={onSortChange} keyName="title">Title</SortHeader></th>
          )}
          {columns.category && (
            <th><SortHeader sort={sort} onChange={onSortChange} keyName="category">Category</SortHeader></th>
          )}
          {columns.expected && <th>Expected</th>}
          {columns.found && <th>Found</th>}
          <th
            className="rec-table-delta-col"
            title="Change vs. prior scan"
          >
            <span aria-hidden="true">Δ</span>
            <span className="sr-only">Change vs. prior scan</span>
          </th>
        </tr>
      </thead>
      <tbody>
        {recs.map((rec) => {
          const status = effectiveStatus(rec, scan, userState);
          const delta = computeDelta(rec, changesIndex, scan, userState);
          const selected = rec.id === selectedRecId;
          const result = scan.results[rec.id];
          const categoryLabel = categoryNames.get(rec.categoryNumber) ?? rec.categoryNumber;
          return (
            <tr
              key={rec.id}
              data-rec-id={rec.id}
              role="button"
              tabIndex={0}
              onClick={() => onOpen(rec.id)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  onOpen(rec.id);
                }
              }}
              className={selected ? "rec-row-selected" : ""}
              aria-selected={selected}
              aria-label={`${rec.id} ${rec.title} — open details`}
            >
              <td className="mono">{rec.id}</td>
              <td>
                <StatusPill status={status} />
              </td>
              {columns.level && (
                <td>
                  <span className={`level-chip level-${rec.level.toLowerCase()}`}>
                    {rec.level}
                  </span>
                </td>
              )}
              {columns.title && <td>{rec.title}</td>}
              {columns.category && (
                <td className="muted" title={rec.categoryNumber}>
                  {categoryLabel}
                </td>
              )}
              {columns.expected && (
                <td className="muted mono rec-table-value-col">
                  {valueCell(result?.expected, result?.checks?.length)}
                </td>
              )}
              {columns.found && (
                <td className="muted mono rec-table-value-col">
                  {valueCell(result?.currentValue, result?.checks?.length)}
                </td>
              )}
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

/**
 * Renders the flat Expected / Found string from a scan result, falling
 * back to an em-dash when absent. The flat string is null for recs
 * with multi-check structured output (registry recs with several
 * value names) where the drawer's check table is the canonical view.
 */
function valueCell(
  value: string | null | undefined,
  checksLen: number | undefined,
): ReactNode {
  if (value && value.trim().length > 0) return value;
  // Multi-check recs (registry recs with several value names) carry no
  // flat string — the data lives in the drawer's check table. Surface
  // the count instead of a bare em-dash so the cell doesn't read as
  // "no data" for exactly the richest rows.
  if (checksLen && checksLen > 0) {
    return (
      <span className="muted-italic">
        {checksLen} check{checksLen === 1 ? "" : "s"}
      </span>
    );
  }
  return "—";
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
      <span
        className="delta-marker delta-improved"
        aria-label="Improved since the prior scan"
        title="Improved since the prior scan"
      >
        ▲
      </span>
    );
  }
  if (delta === "regressed") {
    return (
      <span
        className="delta-marker delta-regressed"
        aria-label="Regressed since the prior scan"
        title="Regressed since the prior scan"
      >
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
  prevRecId,
  nextRecId,
  position,
  total,
  onNavigate,
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
  /** Id of the rec one row above the open one in the filtered+sorted
   * list, or null at the top of the list. */
  prevRecId: string | null;
  /** Id of the rec one row below, or null at the bottom. */
  nextRecId: string | null;
  /** 1-based position of the open rec in the current list, or null
   * when it isn't in the list (e.g. filtered out after opening). */
  position: number | null;
  /** Size of the current filtered+sorted list. */
  total: number;
  onNavigate: (id: string) => void;
  onClose: () => void;
  onUpdate: (next: UserState) => Promise<boolean>;
}) {
  const [exceptionReason, setExceptionReason] = useState("");
  const [exceptionGrantedBy, setExceptionGrantedBy] = useState("");
  const [noteText, setNoteText] = useState("");
  const [savedFlash, setSavedFlash] = useState<"exception" | "note" | null>(null);
  const [saveError, setSaveError] = useState<"exception" | "note" | null>(null);
  // Action deferred behind the unsaved-edits prompt. Holds the thing to
  // do (close, or navigate to another rec) once the user confirms the
  // discard; null when there's nothing pending. Stored as a thunk so
  // close and prev/next funnel through one guard.
  const [pendingLeave, setPendingLeave] = useState<(() => void) | null>(null);
  const confirmDiscard = pendingLeave !== null;
  const drawerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!rec) return;
    const ex = userState.exceptions[rec.id];
    const note = userState.notes[rec.id];
    setExceptionReason(ex?.reason ?? "");
    setExceptionGrantedBy(ex?.grantedBy ?? "");
    setNoteText(note?.text ?? "");
    setSaveError(null);
  }, [rec, userState]);

  const isOpen = rec !== null;

  // Confine Tab to the drawer while open and hand focus back to the
  // originating row on close. Suspended while the discard prompt is up
  // so that modal owns focus instead.
  useFocusTrap(isOpen && !confirmDiscard, drawerRef);

  // Land initial focus on the dialog itself, not the first header
  // control. The focus trap would otherwise park the ring on the
  // prev-rec chevron, which looks wrong when the drawer was reached by
  // mouse and stays stuck there during arrow navigation. Runs after the
  // trap effect (declared below it), so the trap still captures the
  // originating row for restore-on-close; this only redirects where
  // focus lands. Re-asserted when the discard prompt closes.
  useEffect(() => {
    if (isOpen && !confirmDiscard) drawerRef.current?.focus();
  }, [isOpen, confirmDiscard]);

  const savedException = rec ? userState.exceptions[rec.id] : undefined;
  const savedNote = rec ? userState.notes[rec.id] : undefined;
  // Unsaved-edit guard: compare trimmed form values to what's persisted
  // so closing (×, backdrop, Esc) can warn before discarding an
  // exception justification or note the user typed but didn't save.
  const dirty =
    exceptionReason.trim() !== (savedException?.reason ?? "") ||
    (exceptionGrantedBy.trim() || "") !== (savedException?.grantedBy ?? "") ||
    noteText.trim() !== (savedNote?.text ?? "");

  // Runs `action` immediately when there's nothing unsaved; otherwise
  // defers it behind the discard prompt. Both closing and prev/next go
  // through here so the guard behaves identically for each.
  function guardedLeave(action: () => void) {
    if (dirty) {
      setPendingLeave(() => action);
      return;
    }
    action();
  }

  function attemptClose() {
    guardedLeave(onClose);
  }

  function navigateTo(id: string | null) {
    if (id === null) return;
    guardedLeave(() => onNavigate(id));
  }

  // Esc requests close; Up/Down step to the previous/next rec in the
  // current list. All route through the unsaved-edit guard. Arrow nav
  // is suppressed while focus is in a form field so it doesn't fight
  // caret movement in the note textarea. Ignored entirely while the
  // discard prompt is open — that modal handles its own keys.
  useEffect(() => {
    if (!isOpen || confirmDiscard) return;
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        attemptClose();
        return;
      }
      if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
      const tag = (e.target as HTMLElement).tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      e.preventDefault();
      navigateTo(e.key === "ArrowUp" ? prevRecId : nextRecId);
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
    // attemptClose/navigateTo close over `dirty` + the nav ids; the
    // listed deps gate and refresh the handler.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, confirmDiscard, dirty, prevRecId, nextRecId]);

  // Briefly shows "Saved" next to the action button. The closure-captured
  // `which` means rapid back-to-back saves don't clobber each other's flash.
  function flashSaved(which: "exception" | "note") {
    setSavedFlash(which);
    setTimeout(() => {
      setSavedFlash((prev) => (prev === which ? null : prev));
    }, 2000);
  }

  // Reflects the real persistence outcome instead of always flashing
  // "Saved": a failed write (disk error, etc.) leaves the in-memory
  // state ahead of disk, so the user needs to know to retry.
  async function persist(
    which: "exception" | "note",
    next: UserState,
  ) {
    const ok = await onUpdate(next);
    if (ok) {
      setSaveError((prev) => (prev === which ? null : prev));
      flashSaved(which);
    } else {
      setSavedFlash((prev) => (prev === which ? null : prev));
      setSaveError(which);
    }
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
    void persist("exception", {
      ...userState,
      exceptions: { ...userState.exceptions, [rec.id]: next },
    });
  }

  function clearException() {
    if (!rec) return;
    const exceptions = { ...userState.exceptions };
    delete exceptions[rec.id];
    void persist("exception", { ...userState, exceptions });
  }

  function saveNote() {
    if (!rec) return;
    const next: Note = {
      text: noteText.trim(),
      updatedAt: new Date().toISOString(),
    };
    void persist("note", {
      ...userState,
      notes: { ...userState.notes, [rec.id]: next },
    });
  }

  function clearNote() {
    if (!rec) return;
    const notes = { ...userState.notes };
    delete notes[rec.id];
    void persist("note", { ...userState, notes });
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
        onClick={attemptClose}
        aria-hidden="true"
      />
      <aside
        className="drawer"
        role="dialog"
        aria-modal="true"
        aria-labelledby="drawer-title-h"
        tabIndex={-1}
        ref={drawerRef}
      >
        {rec && (
          <>
            <header className="drawer-head">
              <div className="drawer-head-row">
                <span className="drawer-head-id">
                  <span className="mono drawer-id">{rec.id}</span>
                  {dirty && (
                    <span className="drawer-dirty" role="status">
                      Unsaved
                    </span>
                  )}
                </span>
                <div className="drawer-head-actions">
                  {position !== null && total > 1 && (
                    <div className="drawer-nav">
                      <button
                        type="button"
                        className="drawer-nav-btn"
                        onClick={() => navigateTo(prevRecId)}
                        disabled={prevRecId === null}
                        aria-label="Previous recommendation"
                      >
                        <NavChevron dir="up" />
                      </button>
                      <span className="drawer-nav-pos" aria-live="polite">
                        {position} / {total}
                      </span>
                      <button
                        type="button"
                        className="drawer-nav-btn"
                        onClick={() => navigateTo(nextRecId)}
                        disabled={nextRecId === null}
                        aria-label="Next recommendation"
                      >
                        <NavChevron dir="down" />
                      </button>
                    </div>
                  )}
                  <button
                    type="button"
                    className="drawer-close"
                    onClick={attemptClose}
                    aria-label="Close drawer"
                  >
                    ×
                  </button>
                </div>
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
              <h2 id="drawer-title-h" className="drawer-title">
                {rec.title}
              </h2>
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
              {rec.remediation?.description && (
                <DrawerText
                  title="Remediation"
                  text={rec.remediation.description}
                />
              )}

              <ScanResultSection
                result={scan.results[rec.id]}
                stateAge={stateAge}
              />

              <section className="drawer-section">
                <h4>Exception</h4>
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
                  {saveError === "exception" && (
                    <span className="save-error" role="alert">
                      Couldn't save — not stored on disk. Try again.
                    </span>
                  )}
                </div>
              </section>

              <section className="drawer-section">
                <h4>Note</h4>
                <label>
                  Investigation notes, links, decisions — won't change pass/fail.
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
                  {saveError === "note" && (
                    <span className="save-error" role="alert">
                      Couldn't save — not stored on disk. Try again.
                    </span>
                  )}
                </div>
              </section>

              {rec.references.length > 0 && (
                <section className="drawer-section">
                  <h4>References</h4>
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
      {pendingLeave && (
        <ConfirmDialog
          title="Discard unsaved changes?"
          message="This panel has edits that haven't been saved. Leaving will lose them."
          confirmLabel="Discard"
          onConfirm={() => {
            const action = pendingLeave;
            setPendingLeave(null);
            action();
          }}
          onCancel={() => setPendingLeave(null)}
        />
      )}
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
      <h4>{title}</h4>
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
 * populated, renders one card per check: a pass/fail/manual marker,
 * the location read, the value name, and the expected/found pair.
 * Falls back to the flat `expected` / `currentValue` strings when
 * checks aren't available (mock scans, or errors that stopped before
 * any check ran).
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
      <h4>Scan result</h4>
      <dl className="drawer-kv">
        <dt>Status</dt>
        <dd className={`scan-status scan-status-${result.status.toLowerCase()}`}>
          {result.status}
        </dd>
        <dt>Last scanned</dt>
        <dd className="mono">{formatTimestamp(result.measuredAt)}</dd>
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
        <ul className="check-cards">
          {result.checks!.map((c, i) => (
            <li key={i} className="check-card">
              <span
                className={`check-verdict check-verdict-${verdictKey(c.pass)}`}
              >
                {verdictLabel(c.pass)}
              </span>
              <p className="check-loc mono">{breakableRegistryPath(c.path)}</p>
              {c.valueName && <p className="check-name mono">{c.valueName}</p>}
              <dl className="check-kv">
                <dt>Expected</dt>
                <dd className="mono">{c.expected}</dd>
                <dt>Found</dt>
                <dd className="mono">
                  {c.actual ?? (
                    <span className="muted-italic">Not configured</span>
                  )}
                </dd>
              </dl>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/**
 * Inserts `<wbr>` after each backslash so long registry paths wrap at
 * segment boundaries (HKLM: / SOFTWARE / Policies / …) rather than
 * mid-token. Short paths stay on one line; long ones break readably.
 */
/** Maps a per-check `pass` tristate to its verdict CSS suffix. */
function verdictKey(pass: boolean | null): "pass" | "fail" | "manual" {
  if (pass === true) return "pass";
  if (pass === false) return "fail";
  return "manual";
}

/** Maps a per-check `pass` tristate to its verdict label. */
function verdictLabel(pass: boolean | null): string {
  if (pass === true) return "Pass";
  if (pass === false) return "Fail";
  return "Manual";
}

function breakableRegistryPath(path: string): ReactNode {
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
function NavChevron({ dir }: { dir: "up" | "down" }) {
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
function RailChevronIcon({ flipped = false }: { flipped?: boolean }) {
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
function SelectCaret() {
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
