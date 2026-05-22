import { describe, expect, it } from "vitest";

import type { Attestation, Exception } from "../bindings";
import { baseline, rec, result, scan, userState } from "../test/fixtures";
import {
  categoryScores,
  effectiveStatus,
  scoresByLevel,
  topLevelCategoryScores,
  weakestCategories,
} from "./score";

function exception(): Exception {
  return { reason: "accepted", grantedAt: "2025-05-15T12:00:00.000Z", grantedBy: null };
}

function attestation(outcome: "pass" | "fail"): Attestation {
  return { outcome, attestedAt: "2025-05-15T12:00:00.000Z", attestedBy: null };
}

describe("effectiveStatus", () => {
  const r = rec("1.1", "L1", "1");

  it("is pending when a result is missing and the scan is still running", () => {
    const s = scan({}, { finishedAt: null });
    expect(effectiveStatus(r, s, userState())).toBe("pending");
  });

  it("is manual when a result is missing and the scan has finished", () => {
    const s = scan({});
    expect(effectiveStatus(r, s, userState())).toBe("manual");
  });

  it("maps a plain Pass / Fail / Error result through unchanged", () => {
    expect(effectiveStatus(r, scan({ "1.1": result("Pass") }), userState())).toBe("pass");
    expect(effectiveStatus(r, scan({ "1.1": result("Fail") }), userState())).toBe("fail");
    expect(effectiveStatus(r, scan({ "1.1": result("Error") }), userState())).toBe("error");
  });

  it("reports a Fail with a matching exception as exception", () => {
    const s = scan({ "1.1": result("Fail") });
    const us = userState({ exceptions: { "1.1": exception() } });
    expect(effectiveStatus(r, s, us)).toBe("exception");
  });

  it("ignores an exception when the result is not a Fail", () => {
    const s = scan({ "1.1": result("Pass") });
    const us = userState({ exceptions: { "1.1": exception() } });
    expect(effectiveStatus(r, s, us)).toBe("pass");
  });

  it("resolves a Manual result through its attestation outcome", () => {
    const s = scan({ "1.1": result("Manual") });
    expect(
      effectiveStatus(r, s, userState({ attestations: { "1.1": attestation("pass") } })),
    ).toBe("pass");
    expect(
      effectiveStatus(r, s, userState({ attestations: { "1.1": attestation("fail") } })),
    ).toBe("fail");
  });

  it("leaves a Manual result manual with no attestation", () => {
    expect(effectiveStatus(r, scan({ "1.1": result("Manual") }), userState())).toBe("manual");
  });
});

describe("scoresByLevel", () => {
  it("omits levels with no recommendations and computes per-level tallies", () => {
    const recs = [rec("1.1", "L1", "1"), rec("1.2", "L1", "1"), rec("2.1", "L2", "2")];
    const b = baseline(recs);
    const s = scan({
      "1.1": result("Pass"),
      "1.2": result("Fail"),
      "2.1": result("Pass"),
    });
    const scores = scoresByLevel(b, s, userState());
    expect(scores.map((x) => x.level)).toEqual(["L1", "L2"]);

    const l1 = scores[0]!;
    expect(l1.total).toBe(2);
    expect(l1.pass).toBe(1);
    expect(l1.fail).toBe(1);
    // 1 pass / (1 pass + 1 fail) evaluated.
    expect(l1.inScopePct).toBe(0.5);
    expect(l1.fullPct).toBe(0.5);
  });

  it("reports inScopePct null when nothing is actionable", () => {
    const b = baseline([rec("1.1", "L1", "1")]);
    const s = scan({ "1.1": result("Manual") });
    expect(scoresByLevel(b, s, userState())[0]!.inScopePct).toBeNull();
  });
});

describe("categoryScores", () => {
  it("only includes categories with at least three in-scope recs", () => {
    const recs = [
      rec("1.1", "L1", "1"),
      rec("1.2", "L1", "1"),
      rec("1.3", "L1", "1"),
      rec("2.1", "L1", "2"),
      rec("2.2", "L1", "2"),
    ];
    const b = baseline(recs, [
      { number: "1", name: "Cat One", parent: null },
      { number: "2", name: "Cat Two", parent: null },
    ]);
    const s = scan({
      "1.1": result("Pass"),
      "1.2": result("Pass"),
      "1.3": result("Fail"),
      "2.1": result("Pass"),
      "2.2": result("Fail"),
    });
    const scores = categoryScores(b, s, userState());
    expect(scores.map((x) => x.number)).toEqual(["1"]);
    const cat = scores[0]!;
    expect(cat.name).toBe("Cat One");
    expect(cat.inScope).toBe(3);
    expect(cat.inScopePct).toBeCloseTo(2 / 3);
  });
});

describe("weakestCategories", () => {
  it("breaks ties at the same pass rate by raw fail count descending", () => {
    const recs = [
      ...["a1", "a2", "a3"].map((id) => rec(id, "L1", "10")),
      ...["b1", "b2", "b3", "b4", "b5"].map((id) => rec(id, "L1", "20")),
    ];
    const b = baseline(recs);
    // Both categories sit at 0% pass, but category 20 has more fails.
    const results: Record<string, ReturnType<typeof result>> = {};
    for (const r of recs) results[r.id] = result("Fail");
    const scores = weakestCategories(b, scan(results), userState(), 2);
    expect(scores[0]!.number).toBe("20");
    expect(scores[0]!.fail).toBe(5);
    expect(scores[1]!.number).toBe("10");
  });
});

describe("topLevelCategoryScores", () => {
  it("groups by the first dotted segment and sorts numerically", () => {
    const recs = [
      rec("2.1", "L1", "2.3"),
      rec("10.1", "L1", "10.1"),
      rec("1.1", "L1", "1.4"),
    ];
    const b = baseline(recs, [{ number: "2", name: "Two", parent: null }]);
    const s = scan({
      "2.1": result("Pass"),
      "10.1": result("Pass"),
      "1.1": result("Pass"),
    });
    const scores = topLevelCategoryScores(b, s, userState());
    // Numeric sort, not lexicographic: 1, 2, 10.
    expect(scores.map((x) => x.number)).toEqual(["1", "2", "10"]);
    expect(scores.find((x) => x.number === "2")!.name).toBe("Two");
  });
});
