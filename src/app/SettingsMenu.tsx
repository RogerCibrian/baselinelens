import { useEffect, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";

import {
  commands,
  type BaselineSource,
  type Density,
  type Theme,
  type TimeFormat,
} from "../bindings";
import { formatDate } from "../format";
import ConfirmDialog from "../ConfirmDialog";
import SettingSegment from "../SettingSegment";
import ThemeSegment from "../ThemeSegment";

type PendingConfirm = {
  title: string;
  message: string;
  confirmLabel: string;
  onConfirm: () => void;
};

const TIME_FORMAT_OPTIONS = ["24h", "12h"] as const;
const TIME_FORMAT_LABELS: Record<TimeFormat, string> = {
  "24h": "24-hour",
  "12h": "12-hour",
};

const DENSITY_OPTIONS = ["comfortable", "compact"] as const;
const DENSITY_LABELS: Record<Density, string> = {
  comfortable: "Comfortable",
  compact: "Compact",
};

/**
 * Settings popover anchored to the gear button in the top bar.
 * Grouped into Preferences (theme, time format, density), Baseline (a
 * read-only source readout + switch), and Data (open folder + the
 * destructive resets behind a disclosure). Closes on click-outside,
 * Esc, or selecting an item; arrow keys rove the action items. Reset
 * items prompt for confirmation since the user reaches them outside an
 * error context.
 */
export function SettingsMenu({
  theme,
  timeFormat,
  density,
  scanning,
  baselineSource,
  appVersion,
  onThemeChange,
  onTimeFormatChange,
  onDensityChange,
  onChangeBaseline,
  onResetLatest,
  onResetSummaries,
  onResetChanges,
  onClearAll,
  onRemoveBaseline,
}: {
  theme: Theme;
  timeFormat: TimeFormat;
  density: Density;
  /** While a scan runs, baseline-switch and the destructive resets are
   * disabled — they'd race the in-flight run (re-parse swaps the
   * baseline out from under it; a reset clears files it's about to
   * rewrite). */
  scanning: boolean;
  /** Source metadata for the loaded baseline — surfaced read-only so
   * the user can see what they're being measured against. */
  baselineSource: BaselineSource;
  appVersion: string;
  onThemeChange: (next: Theme) => void;
  onTimeFormatChange: (next: TimeFormat) => void;
  onDensityChange: (next: Density) => void;
  onChangeBaseline: () => void;
  onResetLatest: () => void;
  onResetSummaries: () => void;
  onResetChanges: () => void;
  /** Clears scans + history + annotations; baseline stays loaded. */
  onClearAll: () => void;
  /** Removes the baseline entirely; app returns to onboarding. */
  onRemoveBaseline: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [confirm, setConfirm] = useState<PendingConfirm | null>(null);
  // The three destructive resets sit behind a disclosure so a stray
  // click near the gear can't wipe scan history.
  const [resetsOpen, setResetsOpen] = useState(false);
  const [dataError, setDataError] = useState<string | null>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onMouseDown(e: MouseEvent) {
      if (!wrapperRef.current?.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onMouseDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onMouseDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  function askConfirm(pending: PendingConfirm) {
    setOpen(false);
    setConfirm(pending);
  }

  async function openFolder() {
    setDataError(null);
    const result = await commands.openDataDir();
    if (result.status === "ok") setOpen(false);
    else setDataError(result.error);
  }

  // Roving focus across the action items (the menuitem buttons). The
  // segmented controls keep their own radiogroup behavior; arrows only
  // hop between the actionable rows so keyboard users aren't stuck
  // tabbing through everything.
  function onMenuKeyDown(e: ReactKeyboardEvent<HTMLDivElement>) {
    if (
      e.key !== "ArrowDown" &&
      e.key !== "ArrowUp" &&
      e.key !== "Home" &&
      e.key !== "End"
    ) {
      return;
    }
    const menu = menuRef.current;
    if (!menu) return;
    const items = Array.from(
      menu.querySelectorAll<HTMLButtonElement>(
        'button[role="menuitem"]:not(:disabled)',
      ),
    );
    if (items.length === 0) return;
    e.preventDefault();
    const current = items.indexOf(document.activeElement as HTMLButtonElement);
    let next: number;
    if (e.key === "Home") next = 0;
    else if (e.key === "End") next = items.length - 1;
    else if (e.key === "ArrowDown") {
      next = current < 0 ? 0 : Math.min(current + 1, items.length - 1);
    } else {
      next = current < 0 ? items.length - 1 : Math.max(current - 1, 0);
    }
    items[next]?.focus();
  }

  return (
    <div className="settings-wrapper" ref={wrapperRef}>
      <button
        type="button"
        className="icon-button"
        onClick={() => setOpen((current) => !current)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Settings"
      >
        <GearIcon />
      </button>
      {open && (
        <div
          className="settings-menu"
          role="menu"
          ref={menuRef}
          onKeyDown={onMenuKeyDown}
        >
          <span className="settings-group-label">Preferences</span>
          <div className="settings-section">
            <span className="settings-section-label">Appearance</span>
            <ThemeSegment theme={theme} onThemeChange={onThemeChange} />
          </div>
          <div className="settings-section">
            <span className="settings-section-label">Time format</span>
            <SettingSegment
              options={TIME_FORMAT_OPTIONS}
              labels={TIME_FORMAT_LABELS}
              value={timeFormat}
              ariaLabel="Time format"
              onChange={onTimeFormatChange}
            />
          </div>
          <div className="settings-section">
            <span className="settings-section-label">Density</span>
            <SettingSegment
              options={DENSITY_OPTIONS}
              labels={DENSITY_LABELS}
              value={density}
              ariaLabel="Table density"
              onChange={onDensityChange}
            />
          </div>

          <div className="settings-divider" role="separator" />

          <span className="settings-group-label">Baseline</span>
          <dl className="settings-meta">
            <dt>Benchmark</dt>
            <dd title={`Parsed from ${baselineSource.pdfFilename}`}>
              {baselineSource.benchmarkName} {baselineSource.benchmarkVersion}
            </dd>
          </dl>
          <button
            type="button"
            role="menuitem"
            className="settings-item settings-item-action"
            disabled={scanning}
            onClick={() => {
              setOpen(false);
              onChangeBaseline();
            }}
          >
            Change baseline
          </button>

          <div className="settings-divider" role="separator" />

          <span className="settings-group-label">Data</span>
          <button
            type="button"
            role="menuitem"
            className="settings-item"
            onClick={() => void openFolder()}
          >
            Open data folder
          </button>
          {dataError && (
            <p className="settings-error" role="alert">
              {dataError}
            </p>
          )}

          <button
            type="button"
            role="menuitem"
            className="settings-item settings-reset-trigger"
            aria-expanded={resetsOpen}
            aria-controls="settings-reset-panel"
            onClick={() => setResetsOpen((current) => !current)}
          >
            <DisclosureChevron />
            <span>Clear data</span>
          </button>
          {resetsOpen && (
            <div
              className="settings-resets"
              id="settings-reset-panel"
              role="group"
              aria-label="Clear data"
            >
              <p className="settings-resets-caption">
                These permanently delete data for this baseline.
              </p>
              {[
                {
                  title: "Clear last scan",
                  sub: "Removes the latest results; the next scan replaces them.",
                  confirm: {
                    title: "Clear last scan",
                    message:
                      "Deletes this baseline's most recent scan. The Overview and Console show no results until you run a new scan.",
                    confirmLabel: "Clear last scan",
                    onConfirm: onResetLatest,
                  },
                },
                {
                  title: "Clear trend history",
                  sub: "Empties the Trend chart; it rebuilds from your next scan.",
                  confirm: {
                    title: "Clear trend history",
                    message:
                      "Deletes this baseline's saved scan summaries. The Trend chart empties and rebuilds from your next scan.",
                    confirmLabel: "Clear trend history",
                    onConfirm: onResetSummaries,
                  },
                },
                {
                  title: "Clear change history",
                  sub: "Clears the Recently-changed list and the Console's change markers.",
                  confirm: {
                    title: "Clear change history",
                    message:
                      "Deletes this baseline's change history. The 'Recently changed' section and the Console's improved/regressed markers clear until a future scan flips a recommendation.",
                    confirmLabel: "Clear change history",
                    onConfirm: onResetChanges,
                  },
                },
                {
                  title: "Clear all results & notes",
                  sub: "Deletes scans, history, exceptions, and notes for this baseline. The baseline stays loaded.",
                  confirm: {
                    title: "Clear all results & notes",
                    message:
                      "Permanently deletes this baseline's scans, trend history, change history, exceptions, and notes. The baseline stays loaded; the next scan starts fresh.",
                    confirmLabel: "Clear all",
                    onConfirm: onClearAll,
                  },
                },
                {
                  title: "Remove this baseline",
                  sub: "Deletes everything above and unloads the baseline — returns to onboarding.",
                  confirm: {
                    title: "Remove this baseline",
                    message:
                      "Returns you to onboarding and permanently deletes this baseline's scans, trend history, change history, exceptions, and notes, plus its parsed copy. Other baselines you've loaded are unaffected.",
                    confirmLabel: "Remove baseline",
                    onConfirm: onRemoveBaseline,
                  },
                },
              ].map((item) => (
                <button
                  key={item.title}
                  type="button"
                  role="menuitem"
                  className="settings-item settings-item-destructive settings-reset-item"
                  disabled={scanning}
                  onClick={() => askConfirm(item.confirm)}
                >
                  <span className="settings-reset-title">{item.title}</span>
                  <span className="settings-reset-sub">{item.sub}</span>
                </button>
              ))}
            </div>
          )}

          <p className="settings-about mono">
            Parsed {formatDate(baselineSource.parsedAt)} · App v
            {appVersion || "—"}
          </p>
        </div>
      )}
      {confirm && (
        <ConfirmDialog
          title={confirm.title}
          message={confirm.message}
          confirmLabel={confirm.confirmLabel}
          onConfirm={() => {
            confirm.onConfirm();
            setConfirm(null);
          }}
          onCancel={() => setConfirm(null)}
        />
      )}
    </div>
  );
}

/** Right-pointing caret for the Clear-data disclosure. CSS rotates it
 * to point down when the trigger's `aria-expanded` is true. */
function DisclosureChevron() {
  return (
    <svg
      className="settings-reset-chevron"
      width="10"
      height="10"
      viewBox="0 0 10 10"
      fill="none"
      aria-hidden="true"
    >
      <path
        d="M3.5 2 6.5 5 3.5 8"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function GearIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  );
}
