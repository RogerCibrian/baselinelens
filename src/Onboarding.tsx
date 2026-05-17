import {
  Fragment,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";

import { getCurrentWebview } from "@tauri-apps/api/webview";
import { open } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";

import type { Baseline, DeviceInfo, ParserProgress, Theme } from "./bindings";
import { useFocusTrap } from "./hooks";
import ThemeSegment from "./ThemeSegment";

import "./Onboarding.css";

export type OnboardingState =
  | { kind: "onboarding" }
  | { kind: "parsing"; fileName: string; progress: ParserProgress | null }
  | { kind: "pendingConfirm"; fileName: string; baseline: Baseline }
  | { kind: "error"; message: string; fileName: string | null };

type DragState = "none" | "valid" | "invalid";

export default function Onboarding({
  state,
  deviceInfo,
  theme,
  onThemeChange,
  onPickPath,
  onError,
  onConfirm,
  onCancel,
}: {
  state: OnboardingState;
  /** Real device identity for the "Will scan" strip and the confirm
   * modal's target line. Null while the initial fetch is in-flight;
   * the strip renders empty fields rather than placeholders so the
   * layout stays stable when values arrive. */
  deviceInfo: DeviceInfo | null;
  theme: Theme;
  onThemeChange: (next: Theme) => void;
  onPickPath: (path: string) => void;
  onError: (message: string, fileName?: string) => void;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const [dragState, setDragState] = useState<DragState>("none");
  // Remember the last "active" variant and filename so the overlay's
  // content stays stable while it fades out — otherwise a leave/drop
  // would flash back to empty content for one frame as it disappears.
  const [overlayVariant, setOverlayVariant] = useState<"valid" | "invalid">(
    "valid",
  );
  const [dragFileName, setDragFileName] = useState<string | null>(null);
  useEffect(() => {
    if (dragState !== "none") setOverlayVariant(dragState);
  }, [dragState]);

  // Tauri intercepts file drops at the window level, so the browser
  // dragenter/dragover/drop events don't fire on the webview. Listen on
  // the Tauri webview API instead — payloads carry the absolute paths.
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let mounted = true;
    void (async () => {
      const webview = getCurrentWebview();
      const off = await webview.onDragDropEvent((event) => {
        const payload = event.payload;
        if (payload.type === "enter") {
          // `enter` is when Tauri tells us the paths of the dragged
          // files. `over` fires repeatedly during the hover but doesn't
          // re-include paths, so we classify here and persist through.
          const path = payload.paths[0];
          const valid = path ? path.toLowerCase().endsWith(".pdf") : false;
          setDragState(valid ? "valid" : "invalid");
          setDragFileName(path ? (path.split(/[\\/]/).pop() ?? path) : null);
        } else if (payload.type === "leave") {
          setDragState("none");
        } else if (payload.type === "drop") {
          setDragState("none");
          const path = payload.paths[0];
          if (path && path.toLowerCase().endsWith(".pdf")) {
            onPickPath(path);
          } else if (path) {
            onError(
              "Only PDF files are supported — try dropping a benchmark PDF.",
              path.split(/[\\/]/).pop() ?? path,
            );
          }
        }
      });
      if (mounted) unlisten = off;
      else off();
    })();
    return () => {
      mounted = false;
      unlisten?.();
    };
  }, [onPickPath, onError]);

  async function browse() {
    const path = await open({
      multiple: false,
      directory: false,
      filters: [{ name: "PDF", extensions: ["pdf"] }],
    });
    if (typeof path === "string") onPickPath(path);
  }

  return (
    <div className="ob-page">
      <header className="ob-topbar">
        <div className="ob-wordmark">BaselineLens</div>
        <ThemeSegment theme={theme} onThemeChange={onThemeChange} />
      </header>

      <main className="ob-main">
        <article className="ob-article">
          <Hero />
          <Action state={state} deviceInfo={deviceInfo} onBrowse={browse} />
          <Steps />
        </article>
      </main>

      <Footer />

      <DragOverlay
        variant={overlayVariant}
        visible={dragState !== "none"}
        fileName={dragFileName}
      />

      {state.kind === "pendingConfirm" && (
        <ConfirmModal
          baseline={state.baseline}
          fileName={state.fileName}
          deviceInfo={deviceInfo}
          onConfirm={onConfirm}
          onCancel={onCancel}
        />
      )}
    </div>
  );
}

function Hero() {
  return (
    <section className="ob-hero">
      <div className="ob-eyebrow">Get started</div>
      <h1 className="ob-h1">
        Audit a Windows device against
        <br />
        a hardening baseline.
      </h1>
      <p className="ob-lede">
        BaselineLens parses a CIS Benchmark PDF you provide and checks this
        machine against it. Everything runs locally —{" "}
        <em>no data leaves the device</em>.
      </p>
    </section>
  );
}

function Action({
  state,
  deviceInfo,
  onBrowse,
}: {
  state: OnboardingState;
  deviceInfo: DeviceInfo | null;
  onBrowse: () => void;
}) {
  return (
    <section className="ob-action">
      <MachineStrip deviceInfo={deviceInfo} />
      <DropZone state={state} onBrowse={onBrowse} />
      <p className="ob-get-benchmark">
        Don't have the PDF yet?{" "}
        <button
          type="button"
          className="ob-link"
          onClick={() => void openUrl("https://downloads.cisecurity.org/")}
        >
          Download it from cisecurity.org
        </button>
      </p>
      {state.kind === "error" ? (
        <div className="ob-error" role="alert">
          <p className="ob-error-headline">{friendlyError(state.message)}</p>
          <p className="ob-error-hint">Drop another PDF to try again.</p>
        </div>
      ) : (
        <p className="ob-support">
          <strong>Currently supported:</strong> CIS Microsoft Intune for
          Windows 11 benchmark. Support for additional modern CIS Windows
          benchmarks is coming.
        </p>
      )}
    </section>
  );
}

function MachineStrip({ deviceInfo }: { deviceInfo: DeviceInfo | null }) {
  const management = managementLabel(deviceInfo);
  return (
    <div className="ob-machine">
      <div className="ob-machine-icon" aria-hidden="true">
        <MonitorIcon />
      </div>
      <div>
        <div className="ob-machine-label">Will scan</div>
        {deviceInfo ? (
          <div>
            <span className="ob-machine-host">{deviceInfo.hostname}</span>
            <span className="ob-machine-meta">
              {" · "}
              {deviceInfo.osName} {deviceInfo.osVersion}
              {" · "}
              Build {deviceInfo.osBuild}
              {management && (
                <>
                  {" · "}
                  {management}
                </>
              )}
            </span>
          </div>
        ) : (
          <div className="ob-machine-skeleton" aria-hidden="true">
            <span className="ob-skeleton-bar ob-skeleton-host" />
            <span className="ob-skeleton-bar ob-skeleton-meta" />
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * Translates the two managedBy booleans into a single display label.
 * Returns null while device info is still loading so the strip doesn't
 * flash "Unmanaged" before real values arrive.
 */
function managementLabel(deviceInfo: DeviceInfo | null): string | null {
  if (!deviceInfo) return null;
  const { intune, groupPolicy } = deviceInfo.managedBy;
  if (intune && groupPolicy) return "Intune + Group Policy Managed";
  if (intune) return "Intune Managed";
  if (groupPolicy) return "Group Policy Managed";
  return "Unmanaged";
}

function DropZone({
  state,
  onBrowse,
}: {
  state: OnboardingState;
  onBrowse: () => void;
}) {
  const parsing = state.kind === "parsing";
  // The drop zone shows the active file across both parsing and error
  // (when the error is tied to a file). This stops the label from
  // snapping back to "Drop benchmark PDF here" between a fast-failing
  // parse and the error message landing — the file just sits there with
  // a different sub-message.
  const activeFile = (() => {
    if (state.kind === "parsing") return state.fileName;
    if (state.kind === "error" && state.fileName) return state.fileName;
    return null;
  })();
  return (
    <button
      type="button"
      className="ob-drop"
      onClick={onBrowse}
      disabled={parsing || state.kind === "pendingConfirm"}
    >
      <span className="ob-drop-icon" aria-hidden="true">
        <DownloadIcon />
      </span>
      <span className="ob-drop-text">
        {activeFile ? (
          <>
            <span className="ob-drop-label">{activeFile}</span>
            {parsing ? (
              <ParseProgress
                progress={state.kind === "parsing" ? state.progress : null}
              />
            ) : (
              <span className="ob-drop-sub">Couldn't parse</span>
            )}
          </>
        ) : (
          <>
            <span className="ob-drop-label">Drop benchmark PDF here</span>
            <span className="ob-drop-sub">or click to browse files</span>
          </>
        )}
      </span>
      <span className="ob-drop-hint">.PDF</span>
    </button>
  );
}

/**
 * Renders a determinate progress bar plus stage label for the parsing
 * phase. The bar uses a single 0–100 percentage aggregated across all
 * pipeline stages — extraction is the dominant slow phase (~90% of
 * the time), so it owns most of the bar; the post-extraction stages
 * fill the last sliver.
 */
function ParseProgress({ progress }: { progress: ParserProgress | null }) {
  const percent = progressPercent(progress);
  return (
    <span className="ob-progress">
      <span className="ob-progress-row">
        <span className="ob-progress-label">{stageLabel(progress)}</span>
        <span className="ob-progress-percent mono">{Math.round(percent)}%</span>
      </span>
      <span className="ob-progress-track" aria-hidden="true">
        <span className="ob-progress-fill" style={{ width: `${percent}%` }} />
      </span>
    </span>
  );
}

function stageLabel(p: ParserProgress | null): string {
  if (!p) return "Starting…";
  switch (p.stage) {
    case "readingFile":
      return "Reading file…";
    case "computingChecksum":
      return "Hashing…";
    case "extractingText":
      return "Extracting text…";
    case "slicingRecommendations":
    case "classifying":
      return "Building catalog…";
    case "complete":
      return "Done";
  }
}

/**
 * Maps a `ParserProgress` event to a monotonic 0–100 progress
 * percentage. Extraction owns 5–95 (it's the dominant phase and has
 * per-page granularity); the post-extraction stages walk through
 * 95–100. The instant pre-extraction stages bump the bar off 0% so
 * the user sees motion immediately.
 */
function progressPercent(p: ParserProgress | null): number {
  if (!p) return 0;
  switch (p.stage) {
    case "readingFile":
      return 0;
    case "computingChecksum":
      return 3;
    case "extractingText":
      return p.total === 0 ? 5 : 5 + (p.done / p.total) * 90;
    case "slicingRecommendations":
      return 95;
    case "classifying":
      return p.total === 0 ? 95 : 95 + (p.done / p.total) * 5;
    case "complete":
      return 100;
  }
}

function Steps() {
  const steps = [
    {
      n: "01",
      title: "Compare",
      body:
        "Match this device's settings against every control in the benchmark.",
    },
    {
      n: "02",
      title: "Triage",
      body:
        "See what's failing, grouped by category and level, with the expected value for each.",
    },
    {
      n: "03",
      title: "Remediate",
      body:
        "Fix gaps using the cited registry paths; re-scan to verify.",
    },
  ];
  return (
    <section className="ob-steps">
      <div className="ob-steps-eyebrow">What happens next</div>
      <div className="ob-steps-list">
        {steps.map((step) => (
          <div key={step.n} className="ob-step">
            <div className="ob-step-num" aria-hidden="true" />
            <div className="ob-step-numlabel">Step {step.n}</div>
            <div className="ob-step-title">{step.title}</div>
            <div className="ob-step-body">{step.body}</div>
          </div>
        ))}
      </div>
    </section>
  );
}

function Footer() {
  return (
    <footer className="ob-footer">
      <div>
        {/* Documentation URL is TBD; leave inert until decided. */}
        <a
          href="#"
          onClick={(e) => e.preventDefault()}
        >
          Documentation
        </a>
        <a
          href="#"
          onClick={(e) => {
            e.preventDefault();
            void openUrl("https://github.com/RogerCibrian/baselinelens");
          }}
        >
          View on GitHub
        </a>
      </div>
      <div>
        <code>baselinelens v0.1.0</code>
      </div>
    </footer>
  );
}

function DragOverlay({
  variant,
  visible,
  fileName,
}: {
  variant: "valid" | "invalid";
  visible: boolean;
  /** The dragged file's name, captured on the `enter` event so the
   * overlay can echo it back. Persists across `leave`/`drop` so the
   * overlay's content doesn't blank out during the fade. */
  fileName: string | null;
}) {
  const invalid = variant === "invalid";
  const classes = [
    "ob-dragover",
    visible ? "ob-dragover-visible" : "",
    invalid ? "ob-dragover-invalid" : "",
  ]
    .filter(Boolean)
    .join(" ");
  const eyebrow = invalid ? "Not a PDF" : "Incoming file";
  const heading = invalid ? "PDF files only" : "Drop to parse";
  const subtitle = invalid
    ? "Drop a CIS Benchmark PDF to continue."
    : "We'll extract recommendations and confirm before scanning.";
  return (
    <div className={classes} aria-hidden="true">
      <div className="ob-dragover-inner">
        <div className="ob-dragover-eyebrow">{eyebrow}</div>
        <h2 className="ob-dragover-h">{heading}</h2>
        {fileName && (
          <div className="ob-dragover-file mono">{breakableFilename(fileName)}</div>
        )}
        <p className="ob-dragover-sub">{subtitle}</p>
      </div>
    </div>
  );
}

function ConfirmModal({
  baseline,
  fileName,
  deviceInfo,
  onConfirm,
  onCancel,
}: {
  baseline: Baseline;
  fileName: string;
  deviceInfo: DeviceInfo | null;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  // Esc closes; backdrop click closes too. Focus the primary action so
  // Enter confirms when the modal opens.
  const dialogRef = useRef<HTMLDivElement>(null);
  useFocusTrap(true, dialogRef);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onCancel();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel]);

  return (
    <div className="ob-confirm-scrim" onClick={onCancel} aria-hidden="true">
      <div
        className="ob-confirm"
        role="dialog"
        aria-modal="true"
        aria-labelledby="ob-confirm-title"
        aria-describedby="ob-confirm-sub"
        ref={dialogRef}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="ob-confirm-eyebrow">Confirm scan</div>
        <h2 id="ob-confirm-title" className="ob-confirm-h">
          Ready to scan this device?
        </h2>
        <p id="ob-confirm-sub" className="ob-confirm-sub">
          We parsed the benchmark and matched it to this machine. Review the
          details below before starting.
        </p>
        <div className="ob-confirm-card">
          <ConfirmRow k="Benchmark" v={baseline.source.benchmarkName} />
          <ConfirmRow k="Version" v={baseline.source.benchmarkVersion} mono />
          <ConfirmRow k="File" v={breakableFilename(fileName)} mono />
          <ConfirmRow
            k="Recommendations"
            v={`${baseline.recommendations.length} found`}
            mono
          />
          <ConfirmRow
            k="Target"
            v={
              deviceInfo
                ? `${deviceInfo.hostname} · ${deviceInfo.osName} ${deviceInfo.osVersion}`
                : ""
            }
            mono
          />
        </div>
        <div className="ob-confirm-actions">
          <button type="button" className="ob-btn" onClick={onCancel}>
            Cancel
          </button>
          <button
            type="button"
            className="ob-btn ob-btn-primary"
            onClick={onConfirm}
            autoFocus
          >
            Scan this device
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * Maps the parser's raw error message to a user-facing explanation. The
 * Rust side keeps its messages developer-oriented; we translate at the
 * UI boundary so the user gets actionable copy without losing the
 * underlying string in logs.
 */
function friendlyError(raw: string): string {
  if (raw.includes("Recommendations chapter")) {
    return "This doesn't look like a CIS benchmark — we couldn't find a Recommendations chapter inside.";
  }
  if (raw.includes("extract text from PDF")) {
    return "Couldn't read this PDF. It may be corrupted, password-protected, or image-only (scanned).";
  }
  if (raw.startsWith("failed to read")) {
    return "Couldn't open the file. Check that it still exists and isn't locked by another program.";
  }
  return raw;
}

function ConfirmRow({
  k,
  v,
  mono,
}: {
  k: string;
  v: ReactNode;
  mono?: boolean;
}) {
  return (
    <div className="ob-confirm-row">
      <div className="k">{k}</div>
      <div className={mono ? "v mono" : "v"}>{v}</div>
    </div>
  );
}

/**
 * Renders a filename with `<wbr>` tags at separator boundaries so long
 * filenames wrap on punctuation rather than mid-token. The trailing
 * version + extension suffix (e.g. `_v4.0.0.pdf`) is kept atomic so the
 * wrap point lands *before* the version, not inside it — browsers pick
 * the latest fitting `<wbr>`, and an internal dot break would land
 * somewhere like `..._v4.0` / `.0.pdf`.
 */
function breakableFilename(name: string): ReactNode {
  const suffixMatch = name.match(/(?:[_-]v\d+(?:\.\d+)*)?\.[A-Za-z0-9]+$/i);
  const suffix = suffixMatch ? suffixMatch[0] : "";
  const base = suffix ? name.slice(0, -suffix.length) : name;
  const parts = base ? base.split(/(?=[_\-.])/) : [];
  if (suffix) parts.push(suffix);
  return parts.map((part, i) => (
    <Fragment key={i}>
      {i > 0 && <wbr />}
      {part}
    </Fragment>
  ));
}

// ── Inline icons (lucide-style, 1.5px stroke) ─────────────────────────

function MonitorIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <rect x="2" y="3" width="20" height="14" rx="2" ry="2" />
      <line x1="8" y1="21" x2="16" y2="21" />
      <line x1="12" y1="17" x2="12" y2="21" />
    </svg>
  );
}

function DownloadIcon({ size = 18 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <polyline points="7 10 12 15 17 10" />
      <line x1="12" y1="15" x2="12" y2="3" />
    </svg>
  );
}

