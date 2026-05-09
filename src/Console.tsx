import { useEffect, useMemo, useState } from "react";

import type {
  Baseline,
  Exception,
  Level,
  Note,
  Recommendation,
  Scan,
  UserState,
} from "./bindings";
import { effectiveStatus, type EffectiveStatus } from "./data/score";

type StatusFilter = "all" | EffectiveStatus;
type LevelFilter = "all" | Level;

export default function Console({
  baseline,
  scan,
  userState,
  onUpdateUserState,
}: {
  baseline: Baseline;
  scan: Scan;
  userState: UserState;
  onUpdateUserState: (next: UserState) => void;
}) {
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [levelFilter, setLevelFilter] = useState<LevelFilter>("all");
  const [search, setSearch] = useState("");
  const [openRecId, setOpenRecId] = useState<string | null>(null);

  const filtered = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return baseline.recommendations.filter((rec) => {
      if (levelFilter !== "all" && rec.level !== levelFilter) return false;
      if (statusFilter !== "all") {
        if (effectiveStatus(rec, scan, userState) !== statusFilter) return false;
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
  }, [baseline, scan, userState, statusFilter, levelFilter, search]);

  const openRec = openRecId
    ? (baseline.recommendations.find((r) => r.id === openRecId) ?? null)
    : null;

  return (
    <div className="console">
      <FilterBar
        statusFilter={statusFilter}
        onStatusFilter={setStatusFilter}
        levelFilter={levelFilter}
        onLevelFilter={setLevelFilter}
        search={search}
        onSearch={setSearch}
        total={baseline.recommendations.length}
        shown={filtered.length}
      />
      <RecTable
        recs={filtered}
        scan={scan}
        userState={userState}
        onOpen={setOpenRecId}
      />
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

function FilterBar({
  statusFilter,
  onStatusFilter,
  levelFilter,
  onLevelFilter,
  search,
  onSearch,
  total,
  shown,
}: {
  statusFilter: StatusFilter;
  onStatusFilter: (s: StatusFilter) => void;
  levelFilter: LevelFilter;
  onLevelFilter: (l: LevelFilter) => void;
  search: string;
  onSearch: (s: string) => void;
  total: number;
  shown: number;
}) {
  return (
    <div className="filter-bar">
      <span className="muted mono filter-count">
        {shown} of {total}
      </span>
      <select
        value={statusFilter}
        onChange={(e) => onStatusFilter(e.target.value as StatusFilter)}
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
        value={levelFilter}
        onChange={(e) => onLevelFilter(e.target.value as LevelFilter)}
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
        value={search}
        onChange={(e) => onSearch(e.target.value)}
      />
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
