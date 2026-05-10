import { useEffect, useMemo, useState } from "react";

import type {
  Baseline,
  Exception,
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

  const openRec = openRecId
    ? (baseline.recommendations.find((r) => r.id === openRecId) ?? null)
    : null;

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
          shown={filtered.length}
        />
        <RecTable
          recs={filtered}
          scan={scan}
          userState={userState}
          onOpen={setOpenRecId}
        />
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
  onOpen,
}: {
  recs: Recommendation[];
  scan: Scan;
  userState: UserState;
  onOpen: (recId: string) => void;
}) {
  return (
    <table className="rec-table">
      <thead>
        <tr>
          <th>ID</th>
          <th>Status</th>
          <th>Level</th>
          <th>Title</th>
          <th>Category</th>
        </tr>
      </thead>
      <tbody>
        {recs.map((rec) => {
          const status = effectiveStatus(rec, scan, userState);
          return (
            <tr key={rec.id} onClick={() => onOpen(rec.id)}>
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

function StatusPill({ status }: { status: EffectiveStatus }) {
  return (
    <span className={`status-pill status-${status}`}>{status}</span>
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

  useEffect(() => {
    if (!rec) return;
    const ex = userState.exceptions[rec.id];
    const note = userState.notes[rec.id];
    setExceptionReason(ex?.reason ?? "");
    setExceptionGrantedBy(ex?.grantedBy ?? "");
    setNoteText(note?.text ?? "");
  }, [rec, userState]);

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
  }

  function clearNote() {
    if (!rec) return;
    const notes = { ...userState.notes };
    delete notes[rec.id];
    onUpdate({ ...userState, notes });
  }

  const isOpen = rec !== null;
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

              {rec.description && (
                <section className="drawer-section">
                  <h4 className="section-eyebrow">Description</h4>
                  <p className="drawer-prose">{rec.description}</p>
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
                </div>
              </section>
            </div>
          </>
        )}
      </aside>
    </div>
  );
}
