import { useEffect, useMemo, useRef, useState } from "react";

import { openUrl } from "@tauri-apps/plugin-opener";

import type {
  Attestation,
  AttestationOutcome,
  Baseline,
  ChangeEvent,
  Exception,
  Note,
  Recommendation,
  Scan,
  UserState,
} from "../bindings";
import { effectiveStatus } from "../data/score";
import { useFocusTrap } from "../hooks";
import { LevelChip } from "../ui";
import ConfirmDialog from "../ConfirmDialog";
import { useSavable } from "./savable";
import { NavChevron, StatusPill } from "./widgets";
import { AttestationSection } from "./drawer/AttestationSection";
import { DrawerCategoryMeta } from "./drawer/DrawerCategoryMeta";
import { DrawerText } from "./drawer/DrawerText";
import { ExceptionSection } from "./drawer/ExceptionSection";
import { NoteSection } from "./drawer/NoteSection";
import { ScanResultSection } from "./drawer/ScanResultSection";

/**
 * Slide-in detail panel for a single recommendation. Exception and note
 * fields edit local form state; clicking Save flushes a new UserState
 * upward via `onUpdate`, which the parent persists. The form is reset
 * whenever `rec` changes so switching rows doesn't bleed values.
 */
export function DetailDrawer({
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
  const savedException = rec ? userState.exceptions[rec.id] : undefined;
  const savedAttestation = rec ? userState.attestations?.[rec.id] : undefined;
  const savedNote = rec ? userState.notes[rec.id] : undefined;

  const exception = useSavable({
    rec,
    saved: savedException,
    initial: (saved: Exception | undefined) => ({
      reason: saved?.reason ?? "",
      grantedBy: saved?.grantedBy ?? "",
    }),
    onUpdate,
  });
  const attestation = useSavable({
    rec,
    saved: savedAttestation,
    initial: (saved: Attestation | undefined) => ({
      attestedBy: saved?.attestedBy ?? "",
    }),
    onUpdate,
  });
  const note = useSavable({
    rec,
    saved: savedNote,
    initial: (saved: Note | undefined) => ({ text: saved?.text ?? "" }),
    onUpdate,
  });

  // Action deferred behind the unsaved-edits prompt. Holds the thing to
  // do (close, or navigate to another rec) once the user confirms the
  // discard; null when there's nothing pending. Stored as a function so
  // close and prev/next funnel through one guard.
  const [pendingLeave, setPendingLeave] = useState<(() => void) | null>(null);
  const confirmDiscard = pendingLeave !== null;
  const drawerRef = useRef<HTMLDivElement>(null);

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

  // Unsaved-edit guard: compare trimmed form values to what's persisted
  // so closing (×, backdrop, Esc) can warn before discarding an
  // exception justification or a note the user typed but didn't save.
  // The attestation outcome itself saves on the verdict button click,
  // so only its "attested by" free-text field can be dirty.
  const exceptionDirty =
    exception.form.reason.trim() !== (savedException?.reason ?? "") ||
    (exception.form.grantedBy.trim() || "") !== (savedException?.grantedBy ?? "");
  const attestationDirty =
    (attestation.form.attestedBy.trim() || "") !== (savedAttestation?.attestedBy ?? "");
  const noteDirty = note.form.text.trim() !== (savedNote?.text ?? "");
  const dirty = exceptionDirty || attestationDirty || noteDirty;

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

  function saveException() {
    if (!rec) return;
    const next: Exception = {
      reason: exception.form.reason.trim(),
      // Preserve the original timestamp on edits so the audit history
      // reflects when the decision was first made.
      grantedAt: savedException?.grantedAt ?? new Date().toISOString(),
      grantedBy: exception.form.grantedBy.trim() || null,
    };
    void exception.commit({
      ...userState,
      exceptions: { ...userState.exceptions, [rec.id]: next },
    });
  }

  function clearException() {
    if (!rec) return;
    const exceptions = { ...userState.exceptions };
    delete exceptions[rec.id];
    void exception.commit({ ...userState, exceptions });
  }

  function saveAttestation(outcome: AttestationOutcome) {
    if (!rec) return;
    const next: Attestation = {
      outcome,
      attestedBy: attestation.form.attestedBy.trim() || null,
      // Stamp every save with the current time (not preserved like an
      // exception's grantedAt): re-attesting means the admin re-checked
      // against the current device state, so the timestamp must move
      // forward to clear the "scan ran since" staleness badge.
      attestedAt: new Date().toISOString(),
    };
    void attestation.commit({
      ...userState,
      attestations: { ...userState.attestations, [rec.id]: next },
    });
  }

  function clearAttestation() {
    if (!rec) return;
    const attestations = { ...userState.attestations };
    delete attestations[rec.id];
    void attestation.commit({ ...userState, attestations });
  }

  function saveNote() {
    if (!rec) return;
    const next: Note = {
      text: note.form.text.trim(),
      updatedAt: new Date().toISOString(),
    };
    void note.commit({
      ...userState,
      notes: { ...userState.notes, [rec.id]: next },
    });
  }

  function clearNote() {
    if (!rec) return;
    const notes = { ...userState.notes };
    delete notes[rec.id];
    void note.commit({ ...userState, notes });
  }

  const status = rec ? effectiveStatus(rec, scan, userState) : null;
  const hasException = savedException !== undefined;
  const hasNote = savedNote !== undefined;
  const machineStatus = rec ? scan.results[rec.id]?.status : undefined;
  // Attestation is only meaningful for a Manual scan verdict — an
  // automated Pass/Fail stands on its own and must not be overridable.
  const isManual = machineStatus === "Manual";
  const hasAttestation = savedAttestation !== undefined;
  // The attestation predates the current scan: the device may have
  // drifted since the admin hand-checked it, so the drawer nudges a
  // re-attest. Visual only — the verdict still counts until changed.
  const attestationStale =
    savedAttestation !== undefined &&
    new Date(scan.startedAt).getTime() >
      new Date(savedAttestation.attestedAt).getTime();

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
                <LevelChip level={rec.level} />
                {rec.bitlocker && rec.level !== "BL" && (
                  <span className="tag-bitlocker">BitLocker</span>
                )}
                {status && (
                  <StatusPill
                    status={status}
                    attested={isManual && hasAttestation}
                  />
                )}
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

              {isManual && (
                <AttestationSection
                  form={attestation.form}
                  setForm={attestation.setForm}
                  status={attestation.status}
                  saved={savedAttestation}
                  stale={attestationStale}
                  onSave={saveAttestation}
                  onClear={clearAttestation}
                />
              )}

              <ExceptionSection
                form={exception.form}
                setForm={exception.setForm}
                status={exception.status}
                hasException={hasException}
                onSave={saveException}
                onClear={clearException}
              />

              <NoteSection
                form={note.form}
                setForm={note.setForm}
                status={note.status}
                hasNote={hasNote}
                onSave={saveNote}
                onClear={clearNote}
              />

              {rec.references.length > 0 && (
                <section className="drawer-section">
                  <h4>References</h4>
                  <ul className="drawer-references">
                    {rec.references.map((ref) => (
                      <li key={`${ref.type}:${ref.type === "Url" ? ref.url : ref.text}`}>
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
