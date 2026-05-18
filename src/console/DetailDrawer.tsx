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
  ScanResult,
  UserState,
} from "../bindings";
import { paragraphs, verdictKey, verdictLabel } from "../data/consoleModel";
import { effectiveStatus } from "../data/score";
import { formatAge, formatTimestamp } from "../format";
import { useFocusTrap } from "../hooks";
import { LevelChip } from "../ui";
import ConfirmDialog from "../ConfirmDialog";
import { breakableRegistryPath, NavChevron, StatusPill } from "./widgets";

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
  const [exceptionReason, setExceptionReason] = useState("");
  const [exceptionGrantedBy, setExceptionGrantedBy] = useState("");
  const [attestationBy, setAttestationBy] = useState("");
  const [noteText, setNoteText] = useState("");
  type SaveTarget = "exception" | "attestation" | "note";
  const [savedFlash, setSavedFlash] = useState<SaveTarget | null>(null);
  const [saveError, setSaveError] = useState<SaveTarget | null>(null);
  // Action deferred behind the unsaved-edits prompt. Holds the thing to
  // do (close, or navigate to another rec) once the user confirms the
  // discard; null when there's nothing pending. Stored as a function so
  // close and prev/next funnel through one guard.
  const [pendingLeave, setPendingLeave] = useState<(() => void) | null>(null);
  const confirmDiscard = pendingLeave !== null;
  const drawerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!rec) return;
    const ex = userState.exceptions[rec.id];
    const att = userState.attestations?.[rec.id];
    const note = userState.notes[rec.id];
    setExceptionReason(ex?.reason ?? "");
    setExceptionGrantedBy(ex?.grantedBy ?? "");
    setAttestationBy(att?.attestedBy ?? "");
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
  const savedAttestation = rec ? userState.attestations?.[rec.id] : undefined;
  const savedNote = rec ? userState.notes[rec.id] : undefined;
  // Unsaved-edit guard: compare trimmed form values to what's persisted
  // so closing (×, backdrop, Esc) can warn before discarding an
  // exception justification or a note the user typed but didn't save.
  // The attestation outcome itself saves on the verdict button click,
  // so only its "attested by" free-text field can be dirty.
  const dirty =
    exceptionReason.trim() !== (savedException?.reason ?? "") ||
    (exceptionGrantedBy.trim() || "") !== (savedException?.grantedBy ?? "") ||
    (attestationBy.trim() || "") !== (savedAttestation?.attestedBy ?? "") ||
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
  function flashSaved(which: SaveTarget) {
    setSavedFlash(which);
    setTimeout(() => {
      setSavedFlash((prev) => (prev === which ? null : prev));
    }, 2000);
  }

  // Reflects the real persistence outcome instead of always flashing
  // "Saved": a failed write (disk error, etc.) leaves the in-memory
  // state ahead of disk, so the user needs to know to retry.
  async function persist(
    which: SaveTarget,
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

  function saveAttestation(outcome: AttestationOutcome) {
    if (!rec) return;
    const next: Attestation = {
      outcome,
      attestedBy: attestationBy.trim() || null,
      // Stamp every save with the current time (not preserved like an
      // exception's grantedAt): re-attesting means the admin re-checked
      // against the current device state, so the timestamp must move
      // forward to clear the "scan ran since" staleness badge.
      attestedAt: new Date().toISOString(),
    };
    void persist("attestation", {
      ...userState,
      attestations: { ...userState.attestations, [rec.id]: next },
    });
  }

  function clearAttestation() {
    if (!rec) return;
    const attestations = { ...userState.attestations };
    delete attestations[rec.id];
    void persist("attestation", { ...userState, attestations });
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
                <section className="drawer-section">
                  <h4>Attestation</h4>
                  <p className="muted drawer-help">
                    This check has no automated verdict. Record the
                    result after verifying it by hand — it then counts
                    in the In-scope pass rate like a scanned result.
                  </p>
                  {hasAttestation && savedAttestation && (
                    <p
                      className={`attestation-current${
                        attestationStale ? " attestation-stale" : ""
                      }`}
                    >
                      Attested{" "}
                      <strong>
                        {savedAttestation.outcome === "pass"
                          ? "Pass"
                          : "Fail"}
                      </strong>
                      {savedAttestation.attestedBy
                        ? ` by ${savedAttestation.attestedBy}`
                        : ""}{" "}
                      on {formatTimestamp(savedAttestation.attestedAt)}
                      {attestationStale && (
                        <span className="attestation-stale-badge">
                          A scan has run since — re-attest to confirm
                        </span>
                      )}
                    </p>
                  )}
                  <label>
                    Attested by (optional)
                    <input
                      type="text"
                      value={attestationBy}
                      onChange={(e) => setAttestationBy(e.target.value)}
                    />
                  </label>
                  <div className="drawer-actions">
                    <button
                      type="button"
                      className="button-primary button-pass"
                      onClick={() => saveAttestation("pass")}
                    >
                      Mark passing
                    </button>
                    <button
                      type="button"
                      className="button-primary button-fail"
                      onClick={() => saveAttestation("fail")}
                    >
                      Mark failing
                    </button>
                    {hasAttestation && (
                      <button
                        type="button"
                        className="button-secondary"
                        onClick={clearAttestation}
                      >
                        Remove
                      </button>
                    )}
                    {savedFlash === "attestation" && (
                      <span className="saved-flash" role="status">
                        Saved
                      </span>
                    )}
                    {saveError === "attestation" && (
                      <span className="save-error" role="alert">
                        Couldn't save — not stored on disk. Try again.
                      </span>
                    )}
                  </div>
                </section>
              )}

              <section className="drawer-section">
                <h4>Exception</h4>
                <p className="muted drawer-help">
                  Granting an exception records an accepted risk. The rec
                  is excluded from the In-scope pass rate and counts
                  toward Strict compliance.
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
 * Falls back to the single `expected` / `currentValue` strings when
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
