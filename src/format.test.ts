import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  formatAge,
  formatClock,
  formatDate,
  formatDateShort,
  formatTimestamp,
  setTimeFormat,
} from "./format";

// The formatters read local-timezone components off the parsed Date.
// Building the ISO input from local components (rather than a literal
// UTC string) makes the round-trip stable regardless of the machine's
// timezone: what goes in as local 14:30 reads back as local 14:30.
function localIso(
  year: number,
  month1: number,
  day: number,
  hour: number,
  minute: number,
): string {
  return new Date(year, month1 - 1, day, hour, minute, 0).toISOString();
}

describe("formatTimestamp", () => {
  beforeEach(() => setTimeFormat("24h"));
  afterEach(() => setTimeFormat("24h"));

  it("returns the input unchanged when it isn't a valid date", () => {
    expect(formatTimestamp("not a date")).toBe("not a date");
  });

  it("renders date + 24-hour clock by default", () => {
    expect(formatTimestamp(localIso(2025, 5, 15, 14, 30))).toBe("2025-05-15 14:30");
  });

  it("zero-pads month, day, hour, and minute", () => {
    expect(formatTimestamp(localIso(2025, 1, 5, 9, 4))).toBe("2025-01-05 09:04");
  });

  it("renders a 12-hour clock with meridiem when set", () => {
    setTimeFormat("12h");
    expect(formatTimestamp(localIso(2025, 5, 15, 14, 30))).toBe("2025-05-15 2:30 PM");
    expect(formatTimestamp(localIso(2025, 5, 15, 0, 15))).toBe("2025-05-15 12:15 AM");
    expect(formatTimestamp(localIso(2025, 5, 15, 12, 5))).toBe("2025-05-15 12:05 PM");
  });
});

describe("formatClock", () => {
  beforeEach(() => setTimeFormat("24h"));
  afterEach(() => setTimeFormat("24h"));

  it("renders just the 24-hour clock", () => {
    expect(formatClock(localIso(2025, 5, 15, 8, 9))).toBe("08:09");
  });

  it("renders just the 12-hour clock when set", () => {
    setTimeFormat("12h");
    expect(formatClock(localIso(2025, 5, 15, 13, 0))).toBe("1:00 PM");
  });
});

describe("formatDate", () => {
  it("renders local YYYY-MM-DD", () => {
    expect(formatDate(localIso(2025, 5, 15, 23, 59))).toBe("2025-05-15");
  });

  it("returns the input unchanged when it isn't a valid date", () => {
    expect(formatDate("nope")).toBe("nope");
  });
});

describe("formatDateShort", () => {
  it("returns the input unchanged when it isn't a valid date", () => {
    expect(formatDateShort("nope")).toBe("nope");
  });

  it("renders something other than the raw ISO for a valid date", () => {
    const iso = localIso(2025, 5, 15, 12, 0);
    const out = formatDateShort(iso);
    expect(out).not.toBe(iso);
    expect(out.length).toBeGreaterThan(0);
  });
});

describe("formatAge", () => {
  const now = new Date("2025-06-15T12:00:00.000Z");

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
  });
  afterEach(() => vi.useRealTimers());

  function ago(ms: number): string {
    return new Date(now.getTime() - ms).toISOString();
  }

  const SECOND = 1000;
  const MINUTE = 60 * SECOND;
  const HOUR = 60 * MINUTE;
  const DAY = 24 * HOUR;

  it("reads 'just now' under a minute", () => {
    expect(formatAge(ago(30 * SECOND))).toBe("just now");
  });

  it("singularizes one minute and pluralizes more", () => {
    expect(formatAge(ago(MINUTE))).toBe("1 minute");
    expect(formatAge(ago(5 * MINUTE))).toBe("5 minutes");
  });

  it("rolls up to hours, then days", () => {
    expect(formatAge(ago(HOUR))).toBe("1 hour");
    expect(formatAge(ago(3 * HOUR))).toBe("3 hours");
    expect(formatAge(ago(DAY))).toBe("1 day");
    expect(formatAge(ago(5 * DAY))).toBe("5 days");
  });

  it("rolls up to months and years", () => {
    expect(formatAge(ago(30 * DAY))).toBe("1 month");
    expect(formatAge(ago(60 * DAY))).toBe("2 months");
    expect(formatAge(ago(365 * DAY))).toBe("1 year");
  });
});
