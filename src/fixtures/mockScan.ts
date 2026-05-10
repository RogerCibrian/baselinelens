import type {
  Assessment,
  Baseline,
  Scan,
  ScanResult,
  Status,
} from "../bindings";
import { TARGET_MACHINE } from "../data/host";

/**
 * Returns a deterministic mock Scan for `baseline` so the dashboard has
 * something to render before the audit pipeline lands. Status is derived
 * from a hash of each rec id so the same baseline produces the same
 * statuses across reloads — roughly 70% Pass / 25% Fail / 5% Error for
 * Automated recs, always Manual for Manual-assessment recs.
 */
export function mockScan(baseline: Baseline): Scan {
  const measuredAt = new Date().toISOString();
  const results: { [recId: string]: ScanResult } = {};
  for (const rec of baseline.recommendations) {
    results[rec.id] = mockResult(rec.id, rec.assessment, measuredAt);
  }
  return {
    baselineSha256: baseline.source.pdfSha256,
    startedAt: measuredAt,
    finishedAt: measuredAt,
    device: {
      hostname: TARGET_MACHINE.hostname,
      osName: TARGET_MACHINE.osName,
      osVersion: TARGET_MACHINE.osVersion,
      osBuild: TARGET_MACHINE.osBuild,
      managedBy: { intune: true, groupPolicy: false },
    },
    results,
    error: null,
  };
}

function mockResult(
  recId: string,
  assessment: Assessment,
  measuredAt: string,
): ScanResult {
  if (assessment === "Manual") {
    return { status: "Manual", currentValue: null, error: null, measuredAt };
  }
  const bucket = hash(recId) % 100;
  const status: Status = bucket < 70 ? "Pass" : bucket < 95 ? "Fail" : "Error";
  return {
    status,
    currentValue: null,
    error: status === "Error" ? "Mock scan error" : null,
    measuredAt,
  };
}

// djb2 — chosen for simplicity, not cryptographic strength. We only need
// different rec ids to land in different buckets for visual variety.
function hash(text: string): number {
  let h = 5381;
  for (const ch of text) {
    h = ((h << 5) + h + ch.charCodeAt(0)) >>> 0;
  }
  return h;
}
