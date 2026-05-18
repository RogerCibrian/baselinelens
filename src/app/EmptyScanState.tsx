export function EmptyScanState({
  onScan,
  disabled,
  loadError,
  onResetLatest,
}: {
  onScan: () => void;
  disabled: boolean;
  /** When the most-recent scan file failed to load, surface the error
   * inline so the user knows running a scan will overwrite it rather
   * than letting the failure stay invisible. */
  loadError?: string | null;
  /** Removes the unreadable scan file so the user doesn't have to open
   * the data folder to recover. Triggered from the inline action when
   * `loadError` is set. */
  onResetLatest: () => void;
}) {
  const title = loadError ? "Last scan couldn't be loaded" : "No scan yet";
  const body = loadError
    ? "The most-recent scan file for this baseline can't be read. Reset it (or run a new scan, which overwrites it) to continue."
    : "Run a scan to evaluate this device against the loaded baseline. Results stay on the device and are saved between launches.";
  return (
    <div className="empty-scan">
      <span className="empty-scan-icon" aria-hidden="true">
        <ScanIcon />
      </span>
      <h2 className="empty-scan-title">{title}</h2>
      <p className="empty-scan-body">{body}</p>
      {loadError && <p className="empty-scan-error mono">{loadError}</p>}
      <div className="empty-scan-actions">
        <button
          type="button"
          className="button-primary"
          onClick={onScan}
          disabled={disabled}
        >
          Run scan
        </button>
        {loadError && (
          <button
            type="button"
            className="button-secondary"
            onClick={onResetLatest}
          >
            Clear last scan
          </button>
        )}
      </div>
    </div>
  );
}

/** Display with an inline scan-pulse — the empty-state mark for "no
 * scan yet / run a scan". Lucide-style 1.5px stroke to match the
 * other inline icons. */
function ScanIcon() {
  return (
    <svg
      width="44"
      height="44"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="2.5" y="4" width="19" height="13" rx="2" />
      <path d="M9 21h6" />
      <path d="M12 17v4" />
      <path d="M6 11h3l1.5-3 2 5 1.5-3H18" />
    </svg>
  );
}
