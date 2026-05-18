import type { Baseline, Scan, UserState } from "../bindings";
import { formatTimestamp } from "../format";

import { effectiveStatus, type EffectiveStatus } from "./score";

/**
 * One exported recommendation. Composed on the frontend so the values
 * match the console one-to-one — effective status (exceptions fold in
 * here), the human-readable expected/found strings, and the user's
 * annotations. CSV and JSON derive from this same shape so the two
 * formats never drift.
 */
type ExportRow = {
  id: string;
  category: string;
  title: string;
  level: string;
  assessment: string;
  /** What the console shows — exceptions resolved in. */
  status: string;
  /** The underlying technical verdict, so "Fail, but accepted" stays
   * visible rather than being hidden behind the effective status. */
  rawStatus: string;
  expected: string;
  found: string;
  error: string;
  exceptionReason: string;
  exceptionGrantedBy: string;
  exceptionGrantedAt: string;
  attestationOutcome: string;
  attestationBy: string;
  attestationAt: string;
  note: string;
  lastScanned: string;
};

const COLUMNS: { key: keyof ExportRow; header: string }[] = [
  { key: "id", header: "ID" },
  { key: "category", header: "Category" },
  { key: "title", header: "Title" },
  { key: "level", header: "Level" },
  { key: "assessment", header: "Assessment" },
  { key: "status", header: "Status" },
  { key: "rawStatus", header: "Raw status" },
  { key: "expected", header: "Expected" },
  { key: "found", header: "Found" },
  { key: "error", header: "Error" },
  { key: "exceptionReason", header: "Exception reason" },
  { key: "exceptionGrantedBy", header: "Exception granted by" },
  { key: "exceptionGrantedAt", header: "Exception granted at" },
  { key: "attestationOutcome", header: "Attestation outcome" },
  { key: "attestationBy", header: "Attested by" },
  { key: "attestationAt", header: "Attested at" },
  { key: "note", header: "Note" },
  { key: "lastScanned", header: "Last scanned" },
];

const STATUS_LABEL: Record<EffectiveStatus, string> = {
  pass: "Pass",
  fail: "Fail",
  manual: "Manual",
  error: "Error",
  exception: "Accepted exception",
  pending: "Pending",
};

/** Local category name keyed by number — the last segment of the
 * parsed "A - B - C" path, matching what the Console chip/cell shows.
 * Falls back to the number when the parser couldn't extract a name. */
function categoryNames(baseline: Baseline): Map<string, string> {
  const map = new Map<string, string>();
  for (const category of baseline.categories) {
    const local = category.name?.split(" - ").pop() ?? category.name;
    if (local) map.set(category.number, local);
  }
  return map;
}

function buildRows(
  baseline: Baseline,
  scan: Scan,
  userState: UserState,
): ExportRow[] {
  const names = categoryNames(baseline);
  return baseline.recommendations.map((rec) => {
    const result = scan.results[rec.id];
    const exception = userState.exceptions[rec.id];
    const attestation = userState.attestations?.[rec.id];
    const note = userState.notes[rec.id];
    return {
      id: rec.id,
      category: names.get(rec.categoryNumber) ?? rec.categoryNumber,
      title: rec.title,
      level: rec.level,
      assessment: rec.assessment,
      status: STATUS_LABEL[effectiveStatus(rec, scan, userState)],
      rawStatus: result?.status ?? "",
      expected: result?.expected ?? "",
      found: result?.currentValue ?? "",
      error: result?.error ?? "",
      exceptionReason: exception?.reason ?? "",
      exceptionGrantedBy: exception?.grantedBy ?? "",
      exceptionGrantedAt: exception ? formatTimestamp(exception.grantedAt) : "",
      attestationOutcome: attestation
        ? attestation.outcome === "pass"
          ? "Pass"
          : "Fail"
        : "",
      attestationBy: attestation?.attestedBy ?? "",
      attestationAt: attestation
        ? formatTimestamp(attestation.attestedAt)
        : "",
      note: note?.text ?? "",
      lastScanned: result ? formatTimestamp(result.measuredAt) : "",
    };
  });
}

/** Quotes a field only when it contains a delimiter, quote, or
 * newline; embedded quotes are doubled (RFC 4180). */
function csvField(value: string): string {
  return /["\n\r,]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/** Excel, LibreOffice, and Sheets evaluate a cell that begins with
 * `=`, `+`, `-`, `@`, tab, or CR as a formula. Prefixing a single
 * quote forces the cell to be read as text, so a note or title like
 * `=HYPERLINK(...)` can't execute when the export is opened. Applied
 * only to the CSV path — JSON consumers don't evaluate formulas, so
 * the JSON export keeps the value verbatim. */
function neutralizeFormula(value: string): string {
  return /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
}

/** Recommendations in benchmark order as RFC-4180 CSV. */
export function buildCsv(
  baseline: Baseline,
  scan: Scan,
  userState: UserState,
): string {
  const rows = buildRows(baseline, scan, userState);
  const lines = [
    COLUMNS.map((column) => csvField(column.header)).join(","),
    ...rows.map((row) =>
      COLUMNS.map((column) =>
        csvField(neutralizeFormula(row[column.key])),
      ).join(","),
    ),
  ];
  return lines.join("\r\n") + "\r\n";
}

/** Same data as a structured JSON document with a short header for
 * audit context. */
export function buildJson(
  baseline: Baseline,
  scan: Scan,
  userState: UserState,
): string {
  return JSON.stringify(
    {
      benchmark: `${baseline.source.benchmarkName} ${baseline.source.benchmarkVersion}`,
      source: baseline.source.pdfFilename,
      scannedAt: scan.finishedAt ?? scan.startedAt,
      results: buildRows(baseline, scan, userState),
    },
    null,
    2,
  );
}
