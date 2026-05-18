import { type Dispatch, type SetStateAction } from "react";

import { Channel } from "@tauri-apps/api/core";

import {
  commands,
  type Baseline,
  type Density,
  type ParserProgress,
  type Theme,
  type TimeFormat,
  type UserState,
} from "../bindings";
import { setTimeFormat as applyTimeFormat } from "../format";

export type AppState =
  | { kind: "loading" }
  | { kind: "onboarding" }
  | { kind: "parsing"; fileName: string; progress: ParserProgress | null }
  | {
      kind: "pendingConfirm";
      fileName: string;
      baseline: Baseline;
      userState: UserState;
    }
  | {
      kind: "error";
      message: string;
      /** Filename of the rejected/failed file, if any. Carried through
       * from parsing → error so the drop zone keeps showing the file
       * instead of snapping back to its idle "Drop benchmark PDF here"
       * label between drop and error message. Null for errors not tied
       * to a specific file (e.g. cache restore failures). */
      fileName: string | null;
    }
  | {
      kind: "loaded";
      baseline: Baseline;
      userState: UserState;
      /** True when the cached baseline's parser_version doesn't match the
       * running parser's PARSER_VERSION — surfaces a re-parse prompt. */
      isStale: boolean;
      /** One-shot signal: kick off a scan as soon as the dashboard
       * mounts. Set by the onboarding "Scan this device" button so the
       * user doesn't have to click again on the empty state. Dashboard
       * guards against repeated firing via a ref. */
      autoScan?: boolean;
    };

/**
 * Reads `app_state.json` on mount and rehydrates the dashboard from the
 * cached `Baseline` and its `UserState`. Falls back to the onboarding
 * screen when nothing is cached or the cached entry can't be loaded.
 * Also syncs the theme, time-format, and density preferences from the
 * saved store into the in-memory state (and, for theme, the
 * localStorage mirror).
 */
export async function restoreFromCache(
  setAppState: Dispatch<SetStateAction<AppState>>,
  setTheme: Dispatch<SetStateAction<Theme>>,
  setTimeFormatState: Dispatch<SetStateAction<TimeFormat>>,
  setDensityState: Dispatch<SetStateAction<Density>>,
) {
  const persisted = await commands.loadAppState();
  if (persisted.status !== "ok") {
    setAppState({ kind: "error", message: persisted.error, fileName: null });
    return;
  }
  const storedTheme = persisted.data?.preferences?.theme;
  if (storedTheme) {
    setTheme(storedTheme);
    try {
      localStorage.setItem("theme", storedTheme);
    } catch {
      // Same fallthrough as above — locked-down storage just skips the
      // mirror; the in-memory copy still drives the active session.
    }
  }
  const storedTimeFormat = persisted.data?.preferences?.timeFormat;
  if (storedTimeFormat) {
    setTimeFormatState(storedTimeFormat);
    applyTimeFormat(storedTimeFormat);
  }
  const storedDensity = persisted.data?.preferences?.density;
  if (storedDensity) {
    setDensityState(storedDensity);
  }
  const sha = persisted.data?.activeBaselineSha;
  if (!sha) {
    setAppState({ kind: "onboarding" });
    return;
  }
  const baselineResult = await commands.loadCachedBaseline(sha);
  if (baselineResult.status !== "ok") {
    setAppState({
      kind: "error",
      message: baselineResult.error,
      fileName: null,
    });
    return;
  }
  if (!baselineResult.data) {
    // app_state points at a SHA whose cache file is gone (manual deletion,
    // disk full at write time). Treat as "first launch" and show onboarding.
    setAppState({ kind: "onboarding" });
    return;
  }
  const { baseline, isStale } = baselineResult.data;
  const userState = await loadOrInitUserState(sha);
  setAppState({ kind: "loaded", baseline, userState, isStale });
}

/**
 * Drives the parse pipeline from a known path. Transitions through
 * `parsing` (with progress events streamed in) to `pendingConfirm` so
 * the onboarding flow can show the confirmation modal before committing
 * to the new baseline.
 */
export async function parseAtPath(
  path: string,
  setAppState: Dispatch<SetStateAction<AppState>>,
) {
  const fileName = extractFileName(path);
  const channel = new Channel<ParserProgress>();
  channel.onmessage = (progress) => {
    // Guard against late progress events: if the parse already resolved
    // (or errored) we've moved past "parsing" and shouldn't reopen it.
    setAppState((prev) =>
      prev.kind === "parsing" ? { ...prev, progress } : prev,
    );
  };

  setAppState({ kind: "parsing", fileName, progress: null });
  const result = await commands.parseBaseline(path, channel);
  if (result.status !== "ok") {
    setAppState({ kind: "error", message: result.error, fileName });
    return;
  }
  const baseline = result.data;
  const userState = await loadOrInitUserState(baseline.source.pdfSha256);
  setAppState({ kind: "pendingConfirm", fileName, baseline, userState });
}

function extractFileName(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

/**
 * Returns the persisted `UserState` for `sha`, or an empty one when no
 * file exists yet (a freshly-parsed baseline with no annotations).
 */
export async function loadOrInitUserState(sha: string): Promise<UserState> {
  const result = await commands.loadUserState(sha);
  if (result.status === "ok" && result.data) {
    return result.data;
  }
  return { baselineSha256: sha, exceptions: {}, notes: {} };
}
