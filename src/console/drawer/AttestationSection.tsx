import type { Dispatch, SetStateAction } from "react";

import type { Attestation, AttestationOutcome } from "../../bindings";
import { formatTimestamp } from "../../format";
import { SaveStatus, type SaveState } from "../savable";

export type AttestationForm = { attestedBy: string };

/**
 * Manual-check attestation editor, shown only for recs whose scan
 * verdict is Manual. Form state and the save/clear handlers are owned by
 * the drawer; this component renders the current attestation (with a
 * staleness badge when a scan has run since) and the verdict buttons.
 */
export function AttestationSection({
  form,
  setForm,
  status,
  saved,
  stale,
  onSave,
  onClear,
}: {
  form: AttestationForm;
  setForm: Dispatch<SetStateAction<AttestationForm>>;
  status: SaveState;
  saved: Attestation | undefined;
  stale: boolean;
  onSave: (outcome: AttestationOutcome) => void;
  onClear: () => void;
}) {
  return (
    <section className="drawer-section">
      <h4>Attestation</h4>
      <p className="muted drawer-help">
        This check has no automated verdict. Record the result after
        verifying it by hand — it then counts in the In-scope pass rate
        like a scanned result.
      </p>
      {saved && (
        <p className={`attestation-current${stale ? " attestation-stale" : ""}`}>
          Attested{" "}
          <strong>{saved.outcome === "pass" ? "Pass" : "Fail"}</strong>
          {saved.attestedBy ? ` by ${saved.attestedBy}` : ""} on{" "}
          {formatTimestamp(saved.attestedAt)}
          {stale && (
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
          value={form.attestedBy}
          onChange={(e) =>
            setForm((f) => ({ ...f, attestedBy: e.target.value }))
          }
        />
      </label>
      <div className="drawer-actions">
        <button
          type="button"
          className="button-primary button-pass"
          onClick={() => onSave("pass")}
        >
          Mark passing
        </button>
        <button
          type="button"
          className="button-primary button-fail"
          onClick={() => onSave("fail")}
        >
          Mark failing
        </button>
        {saved && (
          <button type="button" className="button-secondary" onClick={onClear}>
            Remove
          </button>
        )}
        <SaveStatus state={status} />
      </div>
    </section>
  );
}
