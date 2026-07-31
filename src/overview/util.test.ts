import { describe, expect, it } from "vitest";

import type { ScanSummary } from "../bindings";
import { buildHeadline } from "./util";

/** Builds a ScanSummary at `startedAt` with the given pass/fail split. */
function summary(startedAt: string, pass: number, fail: number): ScanSummary {
  return {
    startedAt,
    finishedAt: startedAt,
    pass,
    fail,
    manual: 0,
    error: 0,
    exception: 0,
    parserVersion: 1,
    auditScriptVersion: 1,
  };
}

describe("buildHeadline", () => {
  it("returns empty with no summaries and first with one", () => {
    expect(buildHeadline([], 0, 0, 0).kind).toBe("empty");
    expect(buildHeadline([summary("2025-05-15T12:00:00Z", 5, 5)], 0, 0, 0).kind).toBe("first");
  });

  it("anchors at the first recorded scan, not the previous one", () => {
    // Three scans across ten days climbing 20% -> 50% -> 50%. The delta
    // must span the whole history (+30 pts), even though the last two
    // scans are identical.
    const summaries = [
      summary("2025-05-05T12:00:00Z", 2, 8),
      summary("2025-05-10T12:00:00Z", 5, 5),
      summary("2025-05-15T12:00:00Z", 5, 5),
    ];
    const headline = buildHeadline(summaries, 0, 0, 0);
    if (headline.kind !== "trend") throw new Error("expected trend");
    expect(headline.pointsDelta).toBeCloseTo(30);
    expect(headline.trend).toBe("improving");
    expect(headline.spanDays).toBe(10);
  });

  it("reports the day span between the first and latest scans", () => {
    const summaries = [
      summary("2025-03-06T12:00:00Z", 2, 8),
      summary("2025-05-15T12:00:00Z", 5, 5),
    ];
    const headline = buildHeadline(summaries, 0, 0, 0);
    if (headline.kind !== "trend") throw new Error("expected trend");
    expect(headline.pointsDelta).toBeCloseTo(30);
    expect(headline.spanDays).toBe(70);
  });

  it("labels a sub-threshold move stable and floors the span at one day", () => {
    const summaries = [
      summary("2025-05-15T10:00:00Z", 50, 50),
      summary("2025-05-15T12:00:00Z", 50, 50),
    ];
    const headline = buildHeadline(summaries, 0, 0, 0);
    if (headline.kind !== "trend") throw new Error("expected trend");
    expect(headline.trend).toBe("stable");
    expect(headline.spanDays).toBe(1);
  });
});
