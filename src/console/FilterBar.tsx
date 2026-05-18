import { useEffect, useRef, useState } from "react";

import type { Level } from "../bindings";
import { type ConsoleColumns } from "../data/consoleColumns";
import {
  defaultConsoleFilter,
  type ConsoleFilter,
} from "../data/consoleFilter";
import { RailChevronIcon, SelectCaret } from "./widgets";

export function FilterBar({
  filter,
  onFilterChange,
  columns,
  onColumnsChange,
  showViewsButton,
  onShowViews,
  total,
  shown,
  categoryName,
  levelsPresent,
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
  /** Levels present in the loaded benchmark, in L1→L2→BL order; the
   * level dropdown renders these. */
  levelsPresent: Level[];
  onExport: (format: "csv" | "json") => void;
}) {
  // Local draft so typing stays instant while the heavier filter
  // recompute is debounced — a 500-rec baseline shouldn't re-filter on
  // every keystroke.
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
    filter.bitlocker !== "all" ||
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
        placeholder="Search recs…"
        title="Searches id, title, category, expected/found values, notes, and exception reasons"
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
          ...levelsPresent.map((lvl) => ({ value: lvl, label: lvl })),
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
 * dropdowns are consistent. The export itself is built in Console
 * (it owns baseline/scan/userState); this just triggers it.
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
 * Pill-styled popover for turning the table's optional columns on and
 * off. ID and Status are always shown; the rest get a checkbox each.
 * Closes on outside click and Escape, like the other dropdowns.
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
