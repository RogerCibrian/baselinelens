export function ScanErrorBanner({
  message,
  onResetSummaries,
  onDismiss,
}: {
  message: string;
  onResetSummaries: () => void;
  onDismiss: () => void;
}) {
  // Today, summaries is the only file in the save path that's read
  // before being rewritten — so a save-time abort that names it is the
  // schema-drift case where "Clear trend history" recovers. Any other
  // cause (UAC denial, disk full, script failure, etc.) gets a plain
  // banner with no misleading recovery action. If more read-then-write
  // paths land later, extend this detection rather than asserting a
  // cause in the header.
  const isSummariesError = message.includes("summaries.json");
  return (
    <div className="stale-banner" role="alert">
      <WarnIcon />
      <div className="stale-banner-message">
        <span>Scan aborted.</span>
        <span className="stale-banner-detail mono">{message}</span>
      </div>
      {isSummariesError && (
        <button className="stale-banner-action" onClick={onResetSummaries}>
          Clear trend history
        </button>
      )}
      <button className="stale-banner-action-secondary" onClick={onDismiss}>
        Dismiss
      </button>
    </div>
  );
}

export function StaleBanner({ onReparse }: { onReparse: () => void }) {
  return (
    <div className="stale-banner" role="status">
      <WarnIcon />
      <span className="stale-banner-message">
        Parser updated since this baseline was cached. Re-parse to pick up
        the new fields.
      </span>
      <button className="stale-banner-action" onClick={onReparse}>
        Re-parse
      </button>
    </div>
  );
}

export function RescanBanner({ onRescan }: { onRescan: () => void }) {
  return (
    <div className="stale-banner" role="status">
      <WarnIcon />
      <span className="stale-banner-message">
        Audit script updated since this scan ran. Re-scan to pick up the
        new checks.
      </span>
      <button className="stale-banner-action" onClick={onRescan}>
        Re-scan
      </button>
    </div>
  );
}

function WarnIcon() {
  return (
    <svg
      className="stale-banner-icon"
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      aria-hidden="true"
    >
      <path
        d="M8 1.5 L14.5 13.5 L1.5 13.5 Z"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
      <line
        x1="8"
        y1="6"
        x2="8"
        y2="9.5"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
      <circle cx="8" cy="11.5" r="0.85" fill="currentColor" />
    </svg>
  );
}
