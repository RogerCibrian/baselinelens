import { Fragment, useEffect, useState, type ReactNode } from "react";

import { getCurrentWebview } from "@tauri-apps/api/webview";
import { open } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";

import type { Baseline, ParserProgress } from "./bindings";
import { TARGET_MACHINE } from "./data/host";

import "./Onboarding.css";

export type OnboardingState =
  | { kind: "onboarding" }
  | { kind: "parsing"; fileName: string; progress: ParserProgress | null }
  | { kind: "pendingConfirm"; fileName: string; baseline: Baseline }
  | { kind: "error"; message: string; fileName: string | null };

type DragState = "none" | "valid" | "invalid";

export default function Onboarding({
  state,
  onPickPath,
  onError,
  onConfirm,
  onCancel,
}: {
  state: OnboardingState;
  onPickPath: (path: string) => void;
  onError: (message: string, fileName?: string) => void;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const [dragState, setDragState] = useState<DragState>("none");
  // Remember the last "active" variant so the overlay's content stays
  // stable while it fades out — otherwise a non-PDF drop would flash
  // back to "valid" styling for one frame as it disappears.
  const [overlayVariant, setOverlayVariant] = useState<"valid" | "invalid">(
    "valid",
  );
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
      </header>

      <main className="ob-main">
        <article className="ob-article">
          <Hero />
          <Action state={state} onBrowse={browse} />
          <Steps />
        </article>
      </main>

      <Footer />

      <DragOverlay variant={overlayVariant} visible={dragState !== "none"} />

      {state.kind === "pendingConfirm" && (
        <ConfirmModal
          baseline={state.baseline}
          fileName={state.fileName}
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
      <div className="ob-eyebrow">§ Get started</div>
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
  onBrowse,
}: {
  state: OnboardingState;
  onBrowse: () => void;
}) {
  return (
    <section className="ob-action">
      <MachineStrip />
      <DropZone state={state} onBrowse={onBrowse} />
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

function MachineStrip() {
  return (
    <div className="ob-machine">
      <div className="ob-machine-icon" aria-hidden="true">
        <MonitorIcon />
      </div>
      <div>
        <div className="ob-machine-label">Will scan</div>
        <div>
          <span className="ob-machine-host">{TARGET_MACHINE.hostname}</span>
          <span className="ob-machine-meta">
            {" · "}
            {TARGET_MACHINE.osName} {TARGET_MACHINE.osVersion}
            {" · "}
            Build {TARGET_MACHINE.osBuild}
          </span>
        </div>
      </div>
    </div>
  );
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
            <span className="ob-drop-sub">
              {parsing ? (
                <>
                  parsing
                  <ParseEllipsis
                    progress={
                      state.kind === "parsing" ? state.progress : null
                    }
                  />
                </>
              ) : (
                <>Couldn't parse</>
              )}
            </span>
          </>
        ) : (
          <>
            <span className="ob-drop-label">Drop benchmark PDF here</span>
            <span className="ob-drop-sub">
              or{" "}
              <span
                className="ob-drop-link"
                onClick={(e) => {
                  e.stopPropagation();
                  onBrowse();
                }}
              >
                browse files
              </span>{" "}
              · download from{" "}
              <span
                className="ob-drop-link"
                onClick={(e) => {
                  e.stopPropagation();
                  void openUrl(
                    "https://www.cisecurity.org/benchmark/microsoft_windows_desktop",
                  );
                }}
              >
                cisecurity.org
              </span>
            </span>
          </>
        )}
      </span>
      <span className="ob-drop-hint">.PDF</span>
    </button>
  );
}

function ParseEllipsis({ progress }: { progress: ParserProgress | null }) {
  if (!progress) return <>…</>;
  if (progress.stage === "classifying" && progress.total > 0) {
    return (
      <>
        {" "}
        ({progress.done}/{progress.total})…
      </>
    );
  }
  return <>…</>;
}

function Steps() {
  const steps = [
    {
      n: "01",
      title: "Parse the PDF",
      body:
        "Extract recommendations, expected values, and remediation guidance from the benchmark document.",
    },
    {
      n: "02",
      title: "Scan this device",
      body:
        "Read registry, GPO, and policy state to evaluate each control against its expected value.",
    },
    {
      n: "03",
      title: "Show the report",
      body:
        "A per-control pass / fail breakdown, weakest categories, and remediation work organized by level.",
    },
  ];
  return (
    <section className="ob-steps">
      <div className="ob-steps-eyebrow">§ What happens next</div>
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
        {/* Placeholder hrefs until docs/repo URLs are wired. */}
        <a
          href="#"
          onClick={(e) => e.preventDefault()}
        >
          Documentation
        </a>
        <a
          href="#"
          onClick={(e) => e.preventDefault()}
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
}: {
  variant: "valid" | "invalid";
  visible: boolean;
}) {
  const invalid = variant === "invalid";
  const classes = [
    "ob-dragover",
    visible ? "ob-dragover-visible" : "",
    invalid ? "ob-dragover-invalid" : "",
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <div className={classes} aria-hidden="true">
      <div className="ob-dragover-inner">
        <div className="ob-dragover-icon">
          {invalid ? <BlockIcon size={24} /> : <DownloadIcon size={24} />}
        </div>
        <div className="ob-dragover-h">
          {invalid ? "PDF files only" : "Drop benchmark PDF anywhere"}
        </div>
      </div>
    </div>
  );
}

function ConfirmModal({
  baseline,
  fileName,
  onConfirm,
  onCancel,
}: {
  baseline: Baseline;
  fileName: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  // Esc closes; backdrop click closes too. Focus the primary action so
  // Enter confirms when the modal opens.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onCancel();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel]);

  return (
    <div
      className="ob-confirm-scrim"
      role="dialog"
      aria-modal="true"
      onClick={onCancel}
    >
      <div className="ob-confirm" onClick={(e) => e.stopPropagation()}>
        <div className="ob-confirm-eyebrow">§ Confirm scan</div>
        <h2 className="ob-confirm-h">Ready to scan this device?</h2>
        <p className="ob-confirm-sub">
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
            v={`${TARGET_MACHINE.hostname} · ${TARGET_MACHINE.osName} ${TARGET_MACHINE.osVersion}`}
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
 * Renders a filename with `<wbr>` tags at natural break points so long
 * filenames wrap on separators rather than mid-token. Breaks are offered
 * before underscores, hyphens, and dots, with one exception: a dot
 * sitting between two digits (e.g. the `.` in `4.0.0`) is left alone
 * because version numbers should stay intact. Combined with
 * `overflow-wrap: break-word`, the browser falls back to mid-segment
 * breaks only if no preferred break point fits.
 */
function breakableFilename(name: string): ReactNode {
  const parts = name.split(/(?=[_\-])|(?<!\d)(?=\.)|(?<=\d)(?=\.)(?!\d)/);
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

function BlockIcon({ size = 18 }: { size?: number }) {
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
      <circle cx="12" cy="12" r="10" />
      <line x1="4.93" y1="4.93" x2="19.07" y2="19.07" />
    </svg>
  );
}
