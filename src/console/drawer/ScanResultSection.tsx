import type { ScanResult } from "../../bindings";
import { verdictKey, verdictLabel } from "../../data/consoleModel";
import { formatAge, formatTimestamp } from "../../format";
import { breakableRegistryPath } from "../widgets";

// Registry and PolicyManager checks report a real registry path; the
// other audit types report a human label ("Local Security Policy",
// "Audit Policy", "User Rights Assignment", "Manual review"). Only a
// real path earns the monospace + path-wrap treatment.
const isRegistryPath = (path: string) => /^HK/i.test(path);

/**
 * Shows the scan verdict for the open rec. When `result.checks` is
 * populated, renders one card per check: a pass/fail/manual marker,
 * the location read, the value name, and the expected/found pair.
 * Falls back to the single `expected` / `currentValue` strings when
 * checks aren't available (mock scans, or errors that stopped before
 * any check ran).
 */
export function ScanResultSection({
  result,
  stateAge,
  exceptionAccepted = false,
}: {
  result: ScanResult | undefined;
  stateAge: { label: string; since: string } | null;
  /** True when the rec's Fail is covered by an accepted exception. The
   * raw scan Status here is still "Fail"; the note keeps it from
   * reading as a contradiction of the Console's "Exception" pill. */
  exceptionAccepted?: boolean;
}) {
  if (!result) return null;
  // Coalesce once up-front so the rest of the body can use `checks`
  // without re-narrowing the optional.
  const checks = result.checks ?? [];
  const hasChecks = checks.length > 0;
  return (
    <section className="drawer-section">
      <h4>Scan result</h4>
      <dl className="drawer-kv">
        <dt>Status</dt>
        <dd className={`scan-status scan-status-${result.status.toLowerCase()}`}>
          {result.status}
          {exceptionAccepted && (
            <span className="muted"> · exception accepted</span>
          )}
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
          {checks.map((c) => (
            <li key={`${c.path}|${c.valueName}`} className="check-card">
              <span
                className={`check-verdict check-verdict-${verdictKey(c.pass)}`}
              >
                {verdictLabel(c.pass)}
              </span>
              <p className={`check-loc${isRegistryPath(c.path) ? " mono" : ""}`}>
                {isRegistryPath(c.path)
                  ? breakableRegistryPath(c.path)
                  : c.path}
              </p>
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
