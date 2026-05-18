import { useRef } from "react";

import { useEscapeDismiss, useFocusTrap } from "./hooks";

/**
 * Styled, focus-trapped confirmation modal — replaces the native
 * `window.confirm`, which blocked the thread and broke out of the app's
 * visual language for exactly the destructive/data-losing actions that
 * most need to feel deliberate. Esc or backdrop click cancels; the
 * cancel action is focused on open so an accidental Enter doesn't
 * destroy data.
 */
export default function ConfirmDialog({
  title,
  message,
  confirmLabel,
  onConfirm,
  onCancel,
}: {
  title: string;
  message: string;
  confirmLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  useFocusTrap(true, dialogRef);
  useEscapeDismiss(onCancel);

  return (
    <div className="confirm-scrim" onClick={onCancel} aria-hidden="true">
      <div
        className="confirm-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="confirm-title"
        aria-describedby="confirm-message"
        ref={dialogRef}
        onClick={(e) => e.stopPropagation()}
      >
        <h2 id="confirm-title" className="confirm-title">
          {title}
        </h2>
        <p id="confirm-message" className="confirm-message">
          {message}
        </p>
        <div className="confirm-actions">
          <button
            type="button"
            className="button-secondary"
            onClick={onCancel}
            autoFocus
          >
            Cancel
          </button>
          <button type="button" className="button-danger" onClick={onConfirm}>
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
