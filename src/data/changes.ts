import type {
  ChangeEvent,
  Recommendation,
  Scan,
  Status,
  UserState,
} from "../bindings";
import { effectiveStatus } from "./score";

export type Delta = "improved" | "regressed" | "unchanged";

/**
 * Indexes a change log by `recId`, keeping only the most recent event
 * per rec. The change log is append-ordered chronologically, so the
 * last event for a given id supersedes earlier ones — that's what the
 * dashboard reads for per-rec delta indicators.
 */
export function indexLatestChanges(
  events: readonly ChangeEvent[],
): Map<string, ChangeEvent> {
  const out = new Map<string, ChangeEvent>();
  for (const event of events) {
    out.set(event.recId, event);
  }
  return out;
}

/**
 * Returns the per-rec delta against the most recent recorded status
 * change. "Improved" means the rec's effective status is now good
 * (pass / exception) where the last change recorded it as bad (fail);
 * "regressed" is the reverse. Statuses without a verdict — manual,
 * error, pending — are treated as unknown and produce "unchanged" in
 * either direction (we lost visibility, not improved or regressed).
 *
 * Persistence comes from the change log itself: the indicator stays
 * "improved" or "regressed" until another scan-time flip for the same
 * rec replaces it, so a no-op rescan no longer wipes out yesterday's
 * regression flag.
 */
export function computeDelta(
  rec: Recommendation,
  latestChanges: Map<string, ChangeEvent>,
  latest: Scan,
  userState: UserState,
): Delta {
  const event = latestChanges.get(rec.id);
  if (!event || event.fromStatus === null) return "unchanged";
  const current = bucket(effectiveStatus(rec, latest, userState));
  const previous = bucketRaw(event.fromStatus);
  if (current === "unknown" || previous === "unknown") return "unchanged";
  if (current === "good" && previous === "bad") return "improved";
  if (current === "bad" && previous === "good") return "regressed";
  return "unchanged";
}

type StatusBucket = "good" | "bad" | "unknown";

function bucket(
  status: ReturnType<typeof effectiveStatus>,
): StatusBucket {
  switch (status) {
    case "pass":
    case "exception":
      return "good";
    case "fail":
      return "bad";
    case "manual":
    case "error":
    case "pending":
      return "unknown";
  }
}

/**
 * Buckets a raw `Status` (as recorded in the change log) — no
 * userState overlay, since exception annotations live on top of the
 * scan-time verdict and aren't part of the historical record.
 */
function bucketRaw(status: Status): StatusBucket {
  switch (status) {
    case "Pass":
      return "good";
    case "Fail":
      return "bad";
    case "Manual":
    case "Error":
      return "unknown";
    default:
      // Status read from the change log / scan on disk; an unrecognized
      // value (old or hand-edited file) is treated as unknown rather
      // than dropping out of every bucket.
      return "unknown";
  }
}
