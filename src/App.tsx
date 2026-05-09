import { useState } from "react";

import { Channel } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";

import { commands, type Baseline, type ParserProgress } from "./bindings";

import "./App.css";

type State =
  | { kind: "idle" }
  | { kind: "parsing"; path: string; progress: ParserProgress | null }
  | { kind: "error"; message: string }
  | { kind: "loaded"; baseline: Baseline };

function App() {
  const [state, setState] = useState<State>({ kind: "idle" });

  async function selectAndParse() {
    const path = await open({
      multiple: false,
      directory: false,
      filters: [{ name: "PDF", extensions: ["pdf"] }],
    });
    if (!path) return;

    const channel = new Channel<ParserProgress>();
    channel.onmessage = (progress) => {
      setState((prev) =>
        prev.kind === "parsing" ? { ...prev, progress } : prev,
      );
    };

    setState({ kind: "parsing", path, progress: null });
    const result = await commands.parseBaseline(path, channel);
    if (result.status === "ok") {
      setState({ kind: "loaded", baseline: result.data });
    } else {
      setState({ kind: "error", message: result.error });
    }
  }

  return (
    <main className="container">
      <h1>BaselineLens</h1>
      <p>Parse a CIS benchmark PDF and inspect the recommendations.</p>

      <button onClick={selectAndParse} disabled={state.kind === "parsing"}>
        {state.kind === "parsing" ? "Parsing…" : "Select PDF"}
      </button>

      {state.kind === "parsing" && (
        <ParseProgress path={state.path} progress={state.progress} />
      )}

      {state.kind === "error" && (
        <p className="error">Failed to parse: {state.message}</p>
      )}

      {state.kind === "loaded" && <BaselineSummary baseline={state.baseline} />}
    </main>
  );
}

function ParseProgress({
  path,
  progress,
}: {
  path: string;
  progress: ParserProgress | null;
}) {
  const label = stageLabel(progress);
  const fraction =
    progress?.stage === "classifying" && progress.total > 0
      ? progress.done / progress.total
      : null;

  return (
    <div className="progress">
      <p className="muted">{path}</p>
      <p>{label}</p>
      {fraction !== null ? (
        <div className="progress-bar" role="progressbar" aria-valuenow={Math.round(fraction * 100)} aria-valuemin={0} aria-valuemax={100}>
          <div className="progress-bar-fill" style={{ width: `${fraction * 100}%` }} />
        </div>
      ) : (
        <div className="progress-bar progress-bar-indeterminate">
          <div className="progress-bar-fill" />
        </div>
      )}
    </div>
  );
}

function stageLabel(progress: ParserProgress | null): string {
  if (progress === null) return "Starting…";
  switch (progress.stage) {
    case "readingFile":
      return "Reading file…";
    case "computingChecksum":
      return "Computing checksum…";
    case "extractingText":
      return "Extracting text from PDF…";
    case "slicingRecommendations":
      return "Slicing recommendations…";
    case "classifying":
      return `Classifying audit procedures (${progress.done} / ${progress.total})…`;
    case "complete":
      return "Done.";
  }
}

function BaselineSummary({ baseline }: { baseline: Baseline }) {
  const { source, recommendations, categories } = baseline;
  const previewCount = 10;

  return (
    <section className="summary">
      <h2>{source.benchmarkName}</h2>
      <p>
        Version {source.benchmarkVersion} · {recommendations.length} recommendations
        across {categories.length} categories
      </p>
      <p className="muted">
        SHA-256 <code>{source.pdfSha256.slice(0, 16)}…</code> · parsed by parser{" "}
        {source.parserVersion}
      </p>

      <ul className="rec-list">
        {recommendations.slice(0, previewCount).map((rec) => (
          <li key={rec.id}>
            <strong>{rec.id}</strong> <span className="level">({rec.level})</span>{" "}
            {rec.title}
          </li>
        ))}
      </ul>
      {recommendations.length > previewCount && (
        <p className="muted">
          …and {recommendations.length - previewCount} more
        </p>
      )}
    </section>
  );
}

export default App;
