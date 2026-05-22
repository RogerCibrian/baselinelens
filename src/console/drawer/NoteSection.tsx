import type { Dispatch, SetStateAction } from "react";

import { SaveStatus, type SaveState } from "../savable";

export type NoteForm = { text: string };

/**
 * Free-text note editor. Form state and the save/clear handlers are
 * owned by the drawer; this component only renders them.
 */
export function NoteSection({
  form,
  setForm,
  status,
  hasNote,
  onSave,
  onClear,
}: {
  form: NoteForm;
  setForm: Dispatch<SetStateAction<NoteForm>>;
  status: SaveState;
  hasNote: boolean;
  onSave: () => void;
  onClear: () => void;
}) {
  return (
    <section className="drawer-section">
      <h4>Note</h4>
      <label>
        Investigation notes, links, decisions — won't change pass/fail.
        <textarea
          rows={4}
          value={form.text}
          onChange={(e) => setForm((f) => ({ ...f, text: e.target.value }))}
        />
      </label>
      <div className="drawer-actions">
        <button
          type="button"
          className="button-primary"
          onClick={onSave}
          disabled={!form.text.trim()}
        >
          Save note
        </button>
        {hasNote && (
          <button type="button" className="button-secondary" onClick={onClear}>
            Remove
          </button>
        )}
        <SaveStatus state={status} />
      </div>
    </section>
  );
}
