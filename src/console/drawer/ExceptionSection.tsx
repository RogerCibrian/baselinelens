import type { Dispatch, SetStateAction } from "react";

import { SaveStatus, type SaveState } from "../savable";

export type ExceptionForm = { reason: string; grantedBy: string };

/**
 * Exception editor. Form state and the save/clear handlers are owned by
 * the drawer (which also folds this section's edits into its
 * unsaved-changes guard); this component only renders them.
 */
export function ExceptionSection({
  form,
  setForm,
  status,
  hasException,
  onSave,
  onClear,
}: {
  form: ExceptionForm;
  setForm: Dispatch<SetStateAction<ExceptionForm>>;
  status: SaveState;
  hasException: boolean;
  onSave: () => void;
  onClear: () => void;
}) {
  return (
    <section className="drawer-section">
      <h4>Exception</h4>
      <p className="muted drawer-help">
        Granting an exception records an accepted risk. The rec is excluded
        from the In-scope pass rate and counts toward Strict compliance.
      </p>
      <label>
        Reason
        <textarea
          rows={3}
          value={form.reason}
          onChange={(e) => setForm((f) => ({ ...f, reason: e.target.value }))}
        />
      </label>
      <label>
        Granted by (optional)
        <input
          type="text"
          value={form.grantedBy}
          onChange={(e) => setForm((f) => ({ ...f, grantedBy: e.target.value }))}
        />
      </label>
      <div className="drawer-actions">
        <button
          type="button"
          className="button-primary"
          onClick={onSave}
          disabled={!form.reason.trim()}
        >
          Save exception
        </button>
        {hasException && (
          <button type="button" className="button-secondary" onClick={onClear}>
            Remove
          </button>
        )}
        <SaveStatus state={status} />
      </div>
    </section>
  );
}
