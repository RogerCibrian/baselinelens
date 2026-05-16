/**
 * Display formatters for timestamps the backend stores as UTC ISO
 * strings (`new Date().toISOString()`). Every user-facing time is
 * rendered in the device's local timezone — slicing the ISO string
 * directly would show UTC, which is wrong for anyone not on UTC and
 * can even land the date a day off near midnight.
 */

import type { TimeFormat } from "./bindings";

function pad(value: number): string {
  return value < 10 ? `0${value}` : String(value);
}

/**
 * Active clock-format preference. Held at module scope rather than
 * threaded through every `formatTimestamp` caller: the preference is
 * app-wide and changes rarely, and a toggle re-renders the whole tree
 * (it lives in App state), so reads always pick up the current value.
 * App keeps this in step with the persisted preference via
 * `setTimeFormat`.
 */
let activeTimeFormat: TimeFormat = "24h";

/** Points the timestamp formatter at the user's clock-format choice. */
export function setTimeFormat(format: TimeFormat): void {
  activeTimeFormat = format;
}

/**
 * Local-timezone date plus clock time — terse, monospace-friendly, and
 * (in 24-hour form) sortable. The date is always `YYYY-MM-DD`; the
 * clock is `HH:MM` or `h:MM AM/PM` per the active time-format
 * preference. Used by the top bar's last-scan time and the drawer's
 * scan-result timestamps.
 */
export function formatTimestamp(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const day =
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  const minutes = pad(date.getMinutes());
  if (activeTimeFormat === "12h") {
    const hours24 = date.getHours();
    const meridiem = hours24 < 12 ? "AM" : "PM";
    const hours12 = hours24 % 12 === 0 ? 12 : hours24 % 12;
    return `${day} ${hours12}:${minutes} ${meridiem}`;
  }
  return `${day} ${pad(date.getHours())}:${minutes}`;
}

/**
 * Just the clock portion — no date — honoring the 12/24h preference
 * (`14:30` or `2:30 PM`). Used by the trend axis to disambiguate
 * multiple scans that fall on the same calendar day.
 */
export function formatClock(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const minutes = pad(date.getMinutes());
  if (activeTimeFormat === "12h") {
    const hours24 = date.getHours();
    const meridiem = hours24 < 12 ? "AM" : "PM";
    const hours12 = hours24 % 12 === 0 ? 12 : hours24 % 12;
    return `${hours12}:${minutes} ${meridiem}`;
  }
  return `${pad(date.getHours())}:${minutes}`;
}

/** Local-timezone `YYYY-MM-DD` for the report's date overline. */
export function formatDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** Local-timezone short date (`May 15`) for trend-chart axis ticks. */
export function formatDateShort(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/**
 * Coarse elapsed duration from `fromIso` to now, in the largest unit
 * that still reads cleanly: "12 days", "3 hours", "5 months".
 */
export function formatAge(fromIso: string): string {
  const elapsedMs = Date.now() - Date.parse(fromIso);
  const minutes = Math.floor(elapsedMs / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"}`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"}`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days} day${days === 1 ? "" : "s"}`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months} month${months === 1 ? "" : "s"}`;
  const years = Math.floor(days / 365);
  return `${years} year${years === 1 ? "" : "s"}`;
}
