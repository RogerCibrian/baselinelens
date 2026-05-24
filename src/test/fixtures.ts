import type {
  Baseline,
  Category,
  Level,
  Recommendation,
  Scan,
  ScanResult,
  Status,
  UserState,
} from "../bindings";

/** Builds a Recommendation with stock fields; the audit body is irrelevant
 * to the pure scoring/sort logic, so it defaults to a Manual stub. */
export function rec(
  id: string,
  level: Level,
  categoryNumber: string,
  overrides: Partial<Recommendation> = {},
): Recommendation {
  return {
    id,
    level,
    bitlocker: false,
    categoryNumber,
    title: `Rec ${id}`,
    description: "",
    rationale: null,
    impact: null,
    assessment: "Automated",
    audit: { type: "Manual", description: "" },
    auditText: null,
    remediation: null,
    references: [],
    ...overrides,
  };
}

export function result(
  status: Status,
  overrides: Partial<ScanResult> = {},
): ScanResult {
  return {
    status,
    currentValue: null,
    expected: null,
    error: null,
    measuredAt: "2025-05-15T12:00:00.000Z",
    ...overrides,
  };
}

export function scan(
  results: Record<string, ScanResult>,
  overrides: Partial<Scan> = {},
): Scan {
  return {
    baselineSha256: "sha",
    startedAt: "2025-05-15T12:00:00.000Z",
    finishedAt: "2025-05-15T12:05:00.000Z",
    device: {
      hostname: "HOST",
      osName: "Windows 11",
      osVersion: "10.0",
      osBuild: "22631",
      managedBy: { intune: false, groupPolicy: false },
    },
    results,
    error: null,
    parserVersion: 1,
    auditScriptVersion: 1,
    ...overrides,
  };
}

export function userState(overrides: Partial<UserState> = {}): UserState {
  return {
    baselineSha256: "sha",
    exceptions: {},
    notes: {},
    attestations: {},
    ...overrides,
  };
}

export function baseline(
  recommendations: Recommendation[],
  categories: Category[] = [],
): Baseline {
  return {
    source: {
      benchmarkName: "Bench",
      benchmarkVersion: "v1",
      pdfFilename: "bench.pdf",
      pdfSha256: "sha",
      parsedAt: "2025-05-15T12:00:00.000Z",
      parserVersion: 1,
    },
    categories,
    recommendations,
  };
}
