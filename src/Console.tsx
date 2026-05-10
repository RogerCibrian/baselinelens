import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

import { openUrl } from "@tauri-apps/plugin-opener";

import type {
  Baseline,
  Exception,
  Level,
  Note,
  Recommendation,
  Scan,
  UserState,
} from "./bindings";
import {
  defaultConsoleFilter,
  type ConsoleFilter,
} from "./data/consoleFilter";
import { effectiveStatus, type EffectiveStatus } from "./data/score";

type SortKey = "id" | "status" | "level" | "title" | "category";
type SortDirection = "asc" | "desc";
type Sort = { key: SortKey; direction: SortDirection };

const defaultSort: Sort = { key: "id", direction: "asc" };

export default function Console({
  baseline,
  scan,
  userState,
  filter,
  onFilterChange,
  onUpdateUserState,
}: {
  baseline: Baseline;
  scan: Scan;
  userState: UserState;
  filter: ConsoleFilter;
  onFilterChange: (next: ConsoleFilter) => void;
  onUpdateUserState: (next: UserState) => void;
}) {
  const [openRecId, setOpenRecId] = useState<string | null>(null);
  const [selectedRecId, setSelectedRecId] = useState<string | null>(null);
  const [sort, setSort] = useState<Sort>(defaultSort);

  const filtered = useMemo(() => {
    const needle = filter.search.trim().toLowerCase();
    return baseline.recommendations.filter((rec) => {
      if (filter.level !== "all" && rec.level !== filter.level) return false;
      if (filter.category && rec.categoryNumber !== filter.category) return false;
      if (filter.status !== "all") {
        if (effectiveStatus(rec, scan, userState) !== filter.status) return false;
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
  }, [baseline, scan, userState, filter]);

  const sorted = useMemo(() => {
    const out = [...filtered];
    const sign = sort.direction === "asc" ? 1 : -1;
    out.sort((a, b) => sign * compareRecs(a, b, sort.key, scan, userState));
    return out;
  }, [filtered, sort, scan, userState]);

  const openRec = openRecId
    ? (baseline.recommendations.find((r) => r.id === openRecId) ?? null)
    : null;

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
        filter={filter}
        onFilterChange={onFilterChange}
      />
      <div className="console-main">
        <FilterBar
          filter={filter}
          onFilterChange={onFilterChange}
          total={baseline.recommendations.length}
          shown={sorted.length}
        />
        {sorted.length === 0 ? (
          <EmptyResults
            onClear={() => onFilterChange(defaultConsoleFilter)}
          />
        ) : (
          <RecTable
            recs={sorted}
            scan={scan}
            userState={userState}
            sort={sort}
            onSortChange={setSort}
            selectedRecId={selectedRecId}
            onOpen={selectAndOpen}
          />
        )}
      </div>
      <DetailDrawer
        rec={openRec}
        scan={scan}
        userState={userState}
        onClose={() => setOpenRecId(null)}
        onUpdate={onUpdateUserState}
      />
    </div>
  );
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
    id: "bitlocker",
    name: "BitLocker only",
    filter: { level: "BL" },
  },
];

function SavedViewRail({
  baseline,
  scan,
  userState,
  filter,
  onFilterChange,
}: {
  baseline: Baseline;
  scan: Scan;
  userState: UserState;
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
        return true;
      }).length;
    }
    return result;
  }, [baseline, scan, userState]);

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
    </aside>
  );
}

function isViewActive(view: SavedView, current: ConsoleFilter): boolean {
  const target = { ...defaultConsoleFilter, ...view.filter };
  return (
    target.level === current.level &&
    target.status === current.status &&
    target.category === current.category &&
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
}: {
  filter: ConsoleFilter;
  onFilterChange: (next: ConsoleFilter) => void;
  total: number;
  shown: number;
}) {
  return (
    <div className="filter-bar">
      <span className="muted mono filter-count">
        {shown} of {total}
      </span>
      <select
        value={filter.status}
        onChange={(e) =>
          onFilterChange({
            ...filter,
            status: e.target.value as ConsoleFilter["status"],
          })
        }
        aria-label="Status filter"
      >
        <option value="all">All statuses</option>
        <option value="pass">Pass</option>
        <option value="fail">Fail</option>
        <option value="manual">Manual</option>
        <option value="error">Error</option>
        <option value="exception">Exception</option>
      </select>
      <select
        value={filter.level}
        onChange={(e) =>
          onFilterChange({
            ...filter,
            level: e.target.value as ConsoleFilter["level"],
          })
        }
        aria-label="Level filter"
      >
        <option value="all">All levels</option>
        <option value="L1">L1</option>
        <option value="L2">L2</option>
        <option value="BL">BL</option>
      </select>
      <input
        type="search"
        placeholder="Search id or title…"
        value={filter.search}
        onChange={(e) => onFilterChange({ ...filter, search: e.target.value })}
      />
      {filter.category && (
        <button
          type="button"
          className="filter-chip"
          onClick={() => onFilterChange({ ...filter, category: null })}
          aria-label="Clear category filter"
        >
          <span className="mono">{filter.category}</span>
          <span aria-hidden="true">×</span>
        </button>
      )}
    </div>
  );
}

function RecTable({
  recs,
  scan,
  userState,
  sort,
  onSortChange,
  selectedRecId,
  onOpen,
}: {
  recs: Recommendation[];
  scan: Scan;
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
        </tr>
      </thead>
      <tbody>
        {recs.map((rec) => {
          const status = effectiveStatus(rec, scan, userState);
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
  rec,
  scan,
  userState,
  onClose,
  onUpdate,
}: {
  rec: Recommendation | null;
  scan: Scan;
  userState: UserState;
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
              <span className="mono drawer-id">{rec.id}</span>
              <span className={`level-chip level-${rec.level.toLowerCase()}`}>
                {rec.level}
              </span>
              {status && <StatusPill status={status} />}
              <button
                ref={closeRef}
                type="button"
                className="drawer-close"
                onClick={onClose}
                aria-label="Close drawer"
              >
                ×
              </button>
            </header>

            <div className="drawer-body">
              <h3 className="drawer-title">{rec.title}</h3>
              <p className="drawer-meta muted mono">{rec.categoryNumber}</p>

              {rec.description && (
                <section className="drawer-section">
                  <h4 className="section-eyebrow">Description</h4>
                  {paragraphs(rec.description).map((para, i) => (
                    <p key={i} className="drawer-text">
                      {para}
                    </p>
                  ))}
                </section>
              )}

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
