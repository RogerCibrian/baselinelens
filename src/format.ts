/**
 * Display formatters for timestamps the backend stores as UTC ISO
 * strings (`new Date().toISOString()`). Every user-facing time is
 * rendered in the device's local timezone — slicing the ISO string
 * directly would show UTC, which is wrong for anyone not on UTC and
 * can even land the date a day off near midnight.
 */

function pad(value: number): string {
  return value < 10 ? `0${value}` : String(value);
}

/**
 * Local-timezone `YYYY-MM-DD HH:MM` — terse, monospace-friendly, and
 * sortable. Used by the top bar's last-scan time and the drawer's
 * scan-result timestamps.
 */
export function formatTimestamp(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    ` ${pad(date.getHours())}:${pad(date.getMinutes())}`
  );
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
