import { describe, expect, it } from "vitest";

import {
  compareDottedNumbers,
  matchesCategory,
  nextSort,
  paragraphs,
  verdictKey,
  verdictLabel,
} from "./consoleModel";

describe("compareDottedNumbers", () => {
  it("orders segments numerically, not lexicographically", () => {
    // Lexicographic order would put "1.10" before "1.2".
    expect(compareDottedNumbers("1.10", "1.2")).toBeGreaterThan(0);
    expect(compareDottedNumbers("1.2", "1.10")).toBeLessThan(0);
  });

  it("returns 0 for equal ids", () => {
    expect(compareDottedNumbers("4.6.11", "4.6.11")).toBe(0);
  });

  it("treats a missing deeper segment as 0", () => {
    // "1.2" vs "1.2.1": the shorter sorts first.
    expect(compareDottedNumbers("1.2", "1.2.1")).toBeLessThan(0);
  });

  it("treats non-numeric segments as 0", () => {
    expect(compareDottedNumbers("x", "y")).toBe(0);
  });
});

describe("matchesCategory", () => {
  it("matches an exact category number", () => {
    expect(matchesCategory("4.6", "4.6")).toBe(true);
  });

  it("matches a descendant via the dotted prefix", () => {
    expect(matchesCategory("4.6.11", "4.6")).toBe(true);
  });

  it("does not match a sibling that merely shares a numeric prefix", () => {
    // "4.60" must not match a "4.6" filter.
    expect(matchesCategory("4.60", "4.6")).toBe(false);
  });
});

describe("nextSort", () => {
  it("toggles direction when the key is unchanged", () => {
    expect(nextSort({ key: "id", direction: "asc" }, "id")).toEqual({
      key: "id",
      direction: "desc",
    });
  });

  it("starts a new key ascending", () => {
    expect(nextSort({ key: "id", direction: "desc" }, "title")).toEqual({
      key: "title",
      direction: "asc",
    });
  });
});

describe("paragraphs", () => {
  it("splits on blank lines and collapses inner whitespace", () => {
    const text = "first   line\nwrapped\n\nsecond  paragraph";
    expect(paragraphs(text)).toEqual(["first line wrapped", "second paragraph"]);
  });

  it("drops empty paragraphs", () => {
    expect(paragraphs("\n\n   \n\n")).toEqual([]);
  });
});

describe("verdictKey / verdictLabel", () => {
  it("maps the pass tristate", () => {
    expect(verdictKey(true)).toBe("pass");
    expect(verdictKey(false)).toBe("fail");
    expect(verdictKey(null)).toBe("manual");
    expect(verdictLabel(true)).toBe("Pass");
    expect(verdictLabel(false)).toBe("Fail");
    expect(verdictLabel(null)).toBe("Manual");
  });
});
