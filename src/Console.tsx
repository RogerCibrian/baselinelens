import {
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";

import { save } from "@tauri-apps/plugin-dialog";

import { commands } from "./bindings";
import type {
  Baseline,
  ChangeEvent,
  Density,
  Level,
  Scan,
  ScanLoadErrors,
  UserState,
} from "./bindings";
import { computeDelta, indexLatestChanges } from "./data/changes";
import { type ConsoleColumns } from "./data/consoleColumns";
import {
  defaultConsoleFilter,
  type ConsoleFilter,
} from "./data/consoleFilter";
import { buildCsv, buildJson } from "./data/exportScan";
import { effectiveStatus } from "./data/score";
import {
  compareRecs,
  matchesCategory,
  type Sort,
} from "./data/consoleModel";
import { DetailDrawer } from "./console/DetailDrawer";
import { FilterBar } from "./console/FilterBar";
import { RecTable } from "./console/RecTable";
import { SavedViewRail } from "./console/SavedViewRail";
import { EmptyResults } from "./console/widgets";

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
  const [exportOk, setExportOk] = useState<string | null>(null);

  const changesIndex = useMemo(() => indexLatestChanges(changes), [changes]);

  // Category number → local name (last segment of the parsed path).
  // Used by the table's Category cell and the search predicate, so
  // both read the same names; computed once per baseline.
  const categoryNamesByNumber = useMemo(() => {
    const map = new Map<string, string>();
    for (const cat of baseline.categories) {
      const localName = cat.name?.split(" - ").pop() ?? cat.name ?? "";
      if (localName) map.set(cat.number, localName);
    }
    return map;
  }, [baseline.categories]);

  const filtered = useMemo(() => {
    const needle = filter.search.trim().toLowerCase();
    return baseline.recommendations.filter((rec) => {
      if (filter.level !== "all" && rec.level !== filter.level) return false;
      if (filter.bitlocker === "only" && !rec.bitlocker) return false;
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
        const result = scan.results[rec.id];
        const haystack = [
          rec.id,
          rec.title,
          rec.categoryNumber,
          categoryNamesByNumber.get(rec.categoryNumber) ?? "",
          result?.expected ?? "",
          result?.currentValue ?? "",
          userState.notes[rec.id]?.text ?? "",
          userState.exceptions[rec.id]?.reason ?? "",
        ];
        if (!haystack.some((field) => field.toLowerCase().includes(needle))) {
          return false;
        }
      }
      return true;
    });
  }, [baseline, scan, userState, filter, changesIndex, categoryNamesByNumber]);

  const sorted = useMemo(() => {
    const out = [...filtered];
    const sign = sort.direction === "asc" ? 1 : -1;
    out.sort((a, b) => sign * compareRecs(a, b, sort.key, scan, userState));
    return out;
  }, [filtered, sort, scan, userState]);

  // The level dropdown reflects the levels present in the loaded
  // benchmark.
  const levelsPresent = useMemo(() => {
    const order: Level[] = ["L1", "L2", "BL"];
    const present = new Set(baseline.recommendations.map((r) => r.level));
    return order.filter((lvl) => present.has(lvl));
  }, [baseline]);

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

  // Stable identity so changing the selection doesn't re-render every
  // row in the table — only the rows whose highlight actually changes.
  const selectAndOpen = useCallback((id: string) => {
    setSelectedRecId(id);
    setOpenRecId(id);
  }, []);

  // Composed here (not in Rust) so the export matches the console
  // exactly — effective status, exceptions, notes, and the
  // human-readable strings all already live in this tree.
  async function exportResults(format: "csv" | "json") {
    setExportError(null);
    setExportOk(null);
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
    if (result.status !== "ok") {
      setExportError(result.error);
      return;
    }
    const name = path.split(/[\\/]/).pop() ?? path;
    setExportOk(name);
    // Auto-dismiss, but only if this same message is still showing
    // (a later export shouldn't have its confirmation cut short).
    window.setTimeout(() => {
      setExportOk((current) => (current === name ? null : current));
    }, 5000);
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
          levelsPresent={levelsPresent}
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
        {exportOk && (
          <p className="surface-notice surface-notice-ok">
            <span>Exported {exportOk}</span>
            <button
              type="button"
              className="surface-notice-action"
              onClick={() => setExportOk(null)}
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
              Clear change history
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
