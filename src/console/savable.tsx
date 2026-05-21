import { useEffect, useRef, useState } from "react";

import type { Recommendation, UserState } from "../bindings";

export type SaveState = "idle" | "saved" | "error";

/**
 * Save-mechanics for one editable section of the detail drawer. Owns
 * the field form state, the save status (idle / saved / error), and a
 * `commit` that calls `onUpdate` and reflects the real disk outcome.
 * The form re-seeds whenever `rec` or the section's saved slice
 * changes; a stale auto-clear timer from a previous save can't
 * truncate a fresh save's flash.
 */
export function useSavable<F, S>({
  rec,
  saved,
  initial,
  onUpdate,
}: {
  rec: Recommendation | null;
  /** The saved slice this section edits, e.g. `userState.notes[rec.id]`.
   * The form re-seeds from it whenever it changes. */
  saved: S;
  initial: (saved: S) => F;
  onUpdate: (next: UserState) => Promise<boolean>;
}) {
  const [form, setForm] = useState<F>(() => initial(saved));
  const [status, setStatus] = useState<SaveState>("idle");
  // Each commit takes a fresh token; only the latest one's auto-clear
  // timeout actually transitions back to "idle", so a rapid second save
  // doesn't get its flash truncated by the first save's stale timer.
  const tokenRef = useRef(0);

  useEffect(() => {
    if (!rec) return;
    setForm(initial(saved));
    // Clear a lingering save-error on rec/save change, but leave the
    // "saved" flash alone — a successful save's userState update would
    // otherwise truncate the 2-second confirmation.
    setStatus((s) => (s === "error" ? "idle" : s));
    // initial is intentionally not a dep: callers pass inline arrows
    // that derive the form purely from the saved slice already in deps.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rec, saved]);

  async function commit(next: UserState) {
    const token = ++tokenRef.current;
    const ok = await onUpdate(next);
    if (ok) {
      setStatus("saved");
      setTimeout(() => {
        if (tokenRef.current === token) {
          setStatus((s) => (s === "saved" ? "idle" : s));
        }
      }, 2000);
    } else {
      setStatus("error");
    }
  }

  return { form, setForm, status, commit };
}

/** Inline status next to a section's save action: the "Saved" flash, the
 * disk-save-failed message, or nothing. */
export function SaveStatus({ state }: { state: SaveState }) {
  if (state === "saved") {
    return (
      <span className="saved-flash" role="status">
        Saved
      </span>
    );
  }
  if (state === "error") {
    return (
      <span className="save-error" role="alert">
        Couldn't save — not stored on disk. Try again.
      </span>
    );
  }
  return null;
}
