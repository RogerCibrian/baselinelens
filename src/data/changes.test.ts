import { describe, expect, it } from "vitest";

import type { ChangeEvent, Status } from "../bindings";
import { rec, result, scan, userState } from "../test/fixtures";
import { computeDelta, indexLatestChanges } from "./changes";

function event(
  recId: string,
  fromStatus: Status | null,
  toStatus: Status,
  observedAt = "2025-05-15T12:00:00.000Z",
): ChangeEvent {
  return {
    recId,
    fromStatus,
    toStatus,
    observedAt,
    parserVersion: 1,
    auditScriptVersion: 1,
  };
}

describe("indexLatestChanges", () => {
  it("keeps the last event for each rec id", () => {
    const events = [
      event("1.1", null, "Pass", "t1"),
      event("1.1", "Pass", "Fail", "t2"),
      event("1.2", null, "Pass", "t1"),
    ];
    const index = indexLatestChanges(events);
    expect(index.size).toBe(2);
    expect(index.get("1.1")!.observedAt).toBe("t2");
    expect(index.get("1.1")!.toStatus).toBe("Fail");
  });
});

describe("computeDelta", () => {
  const r = rec("1.1", "L1", "1");

  it("is unchanged when there is no recorded event", () => {
    const delta = computeDelta(r, new Map(), scan({ "1.1": result("Pass") }), userState());
    expect(delta).toBe("unchanged");
  });

  it("is unchanged when the event is a first observation (no fromStatus)", () => {
    const index = indexLatestChanges([event("1.1", null, "Fail")]);
    const delta = computeDelta(r, index, scan({ "1.1": result("Fail") }), userState());
    expect(delta).toBe("unchanged");
  });

  it("is improved when a previously-failing rec now passes", () => {
    const index = indexLatestChanges([event("1.1", "Fail", "Pass")]);
    const delta = computeDelta(r, index, scan({ "1.1": result("Pass") }), userState());
    expect(delta).toBe("improved");
  });

  it("is regressed when a previously-passing rec now fails", () => {
    const index = indexLatestChanges([event("1.1", "Pass", "Fail")]);
    const delta = computeDelta(r, index, scan({ "1.1": result("Fail") }), userState());
    expect(delta).toBe("regressed");
  });

  it("is unchanged when the current status has no verdict (manual)", () => {
    const index = indexLatestChanges([event("1.1", "Pass", "Manual")]);
    const delta = computeDelta(r, index, scan({ "1.1": result("Manual") }), userState());
    expect(delta).toBe("unchanged");
  });

  it("is unchanged when the previous status had no verdict (manual)", () => {
    const index = indexLatestChanges([event("1.1", "Manual", "Pass")]);
    const delta = computeDelta(r, index, scan({ "1.1": result("Pass") }), userState());
    expect(delta).toBe("unchanged");
  });
});
