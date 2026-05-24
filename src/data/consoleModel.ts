import type { Level, Recommendation, Scan, UserState } from "../bindings";

import type { ConsoleFilter } from "./consoleFilter";
import { effectiveStatus } from "./score";

export type SortKey = "id" | "status" | "level" | "title" | "category";
export type SortDirection = "asc" | "desc";
export type Sort = { key: SortKey; direction: SortDirection };

export type SavedView = {
  id: string;
  name: string;
  description?: string;
  filter: Partial<ConsoleFilter>;
};

const LEVEL_RANK: Record<Level, number> = { L1: 1, L2: 2, BL: 3 };

export function matchesCategory(
  recCategory: string,
  selected: string,
): boolean {
  return recCategory === selected || recCategory.startsWith(selected + ".");
}

/** Compares dotted-decimal IDs ("1.10" > "1.2") by treating each segment
 * as an integer rather than the lexicographic default. */
export function compareDottedNumbers(a: string, b: string): number {
  const aParts = a.split(".").map((p) => Number(p) || 0);
  const bParts = b.split(".").map((p) => Number(p) || 0);
  const max = Math.max(aParts.length, bParts.length);
  for (let i = 0; i < max; i++) {
    const av = aParts[i] ?? 0;
    const bv = bParts[i] ?? 0;
    if (av !== bv) return av - bv;
  }
  return 0;
}

export function compareRecs(
  a: Recommendation,
  b: Recommendation,
  key: SortKey,
  scan: Scan,
  userState: UserState,
): number {
  switch (key) {
    case "id":
      return compareDottedNumbers(a.id, b.id);
    case "category":
      return compareDottedNumbers(a.categoryNumber, b.categoryNumber);
    case "level":
      return LEVEL_RANK[a.level] - LEVEL_RANK[b.level];
    case "title":
      return a.title.localeCompare(b.title);
    case "status": {
      const sa = effectiveStatus(a, scan, userState);
      const sb = effectiveStatus(b, scan, userState);
      return sa.localeCompare(sb);
    }
  }
}

export function nextSort(current: Sort, key: SortKey): Sort {
  if (current.key === key) {
    return { key, direction: current.direction === "asc" ? "desc" : "asc" };
  }
  return { key, direction: "asc" };
}

export const SAVED_VIEWS: SavedView[] = [
  { id: "all", name: "All recommendations", filter: {} },
  {
    id: "open-fails",
    name: "Failing",
    description: "Failing without an exception",
    filter: { status: "fail" },
  },
  {
    id: "passing",
    name: "Passing",
    description: "Currently meeting the baseline",
    filter: { status: "pass" },
  },
  {
    id: "exceptions",
    name: "Exceptions",
    description: "Accepted-risk decisions",
    filter: { status: "exception" },
  },
  {
    id: "manual",
    name: "Manual",
    description: "Needs human verification",
    filter: { status: "manual" },
  },
  {
    id: "errored",
    name: "Errored",
    description: "Audit couldn't complete",
    filter: { status: "error" },
  },
  {
    id: "regressed",
    name: "Regressed",
    description: "Flipped from pass to fail",
    filter: { delta: "regressed" },
  },
  {
    id: "recently-fixed",
    name: "Recently fixed",
    description: "Flipped from fail to pass",
    filter: { delta: "improved" },
  },
  {
    id: "bitlocker",
    name: "BitLocker only",
    description: "BitLocker profile recommendations",
    filter: { bitlocker: "only" },
  },
];

export function isViewActive(
  view: SavedView,
  current: ConsoleFilter,
): boolean {
  const keys = Object.keys(view.filter) as (keyof ConsoleFilter)[];
  if (keys.length === 0) {
    return (
      current.level === "all" &&
      current.status === "all" &&
      current.category === null &&
      current.delta === "all" &&
      current.bitlocker === "all" &&
      current.search.trim() === ""
    );
  }
  return keys.every((key) => current[key] === view.filter[key]);
}

/**
 * Splits a PDF-extracted text blob into display paragraphs. The PDF
 * extractor keeps column-wrap newlines as literal `\n`, so we treat
 * blank lines as the real paragraph break and collapse run-of-whitespace
 * inside each paragraph to a single space.
 */
export function paragraphs(text: string): string[] {
  return text
    .split(/\n\s*\n/)
    .map((p) => p.replace(/\s+/g, " ").trim())
    .filter((p) => p.length > 0);
}

/**
 * Reflows a benchmark audit body for display. The PDF hard-wraps lines at a
 * fixed width; this rejoins them into logical lines, starting a new line at
 * each numbered step and each registry path so steps don't run together. A
 * wrap that fell on a space (the previous line kept its trailing whitespace)
 * rejoins with a space; a mid-token wrap rejoins with none — the same
 * trailing-space signal the parser uses to dewrap paths.
 */
export function auditLines(text: string): string[] {
  const lines: string[] = [];
  let prevHadTrailingSpace = false;
  for (const raw of text.split("\n")) {
    const content = raw.trim();
    if (content === "") continue;
    const startsLine =
      lines.length === 0 ||
      /^\d+\.\s/.test(content) ||
      /^(HKLM|HKU|HKCU|HKEY_)/i.test(content);
    if (startsLine) {
      lines.push(content);
    } else {
      lines[lines.length - 1] += (prevHadTrailingSpace ? " " : "") + content;
    }
    prevHadTrailingSpace = /\s$/.test(raw);
  }
  return lines;
}

export function verdictKey(
  pass: boolean | null,
): "pass" | "fail" | "manual" {
  if (pass === true) return "pass";
  if (pass === false) return "fail";
  return "manual";
}

/** Maps a per-check `pass` tristate to its verdict label. */
export function verdictLabel(pass: boolean | null): string {
  if (pass === true) return "Pass";
  if (pass === false) return "Fail";
  return "Manual";
}
