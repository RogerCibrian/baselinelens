import type { Baseline, Level, Scan, UserState } from "./bindings";
import type { ConsoleFilter } from "./data/consoleFilter";
import {
  scoresByLevel,
  weakestCategories,
  type CategoryScore,
  type LevelScore,
} from "./data/score";

export default function Overview({
  baseline,
  scan,
  userState,
  onJumpToConsole,
}: {
  baseline: Baseline;
  scan: Scan;
  userState: UserState;
  onJumpToConsole: (filter: Partial<ConsoleFilter>) => void;
}) {
  const levels = scoresByLevel(baseline, scan, userState);
  const weakest = weakestCategories(baseline, scan, userState, 6);
  return (
    <article className="overview">
      <header className="overview-header">
        <p className="eyebrow">
          Compliance report ·{" "}
          <span className="mono">{formatDate(scan.startedAt)}</span>
        </p>
        <h1 className="serif overview-title">{baseline.source.benchmarkName}</h1>
        <p className="meta">
          <span className="mono">{scan.device.hostname}</span> ·{" "}
          {scan.device.osName} {scan.device.osVersion} ·{" "}
          {baseline.source.benchmarkVersion}
        </p>
      </header>

      <section className="overview-section">
        <h2 className="section-eyebrow">Score by level</h2>
        <div className="level-cards">
          {levels.map((score) => (
            <LevelCard
              key={score.level}
              score={score}
              onJump={() => onJumpToConsole({ level: score.level })}
            />
          ))}
        </div>
      </section>

      <section className="overview-section">
        <h2 className="section-eyebrow">Weakest categories</h2>
        {weakest.length === 0 ? (
          <p className="muted">
            No categories with at least three in-scope recommendations.
          </p>
        ) : (
          <ul className="category-list">
            {weakest.map((cat) => (
              <CategoryRow
                key={cat.number}
                score={cat}
                onJump={() => onJumpToConsole({ category: cat.number })}
              />
            ))}
          </ul>
        )}
      </section>

      <footer className="overview-footer">
        <span className="mono">{baseline.source.benchmarkVersion}</span>
        <span className="mono">
          {baseline.recommendations.length} recommendations
        </span>
      </footer>
    </article>
  );
}

function LevelCard({
  score,
  onJump,
}: {
  score: LevelScore;
  onJump: () => void;
}) {
  const tone = toneFor(score.inScopePct);
  // In-scope excludes both Manual recs (no automated check) and Pending
  // ones (haven't been scanned yet) so the % reflects only settled
  // verdicts. Pending count surfaces separately in the note when > 0.
  const inScopeDenom = score.total - score.manual - score.pending;
  const inScopePct =
    score.inScopePct === null ? null : Math.round(score.inScopePct * 100);
  return (
    <button type="button" className="level-card" onClick={onJump}>
      <div className="level-card-head">
        <span className={`level-chip level-${score.level.toLowerCase()}`}>
          {score.level}
        </span>
        <span className="level-card-name">{levelName(score.level)}</span>
      </div>
      <div className="level-card-numbers">
        <div>
          <span className="caption">In-scope</span>
          <span className={`level-pct serif tone-${tone}`}>
            {inScopePct === null ? (
              "—"
            ) : (
              <>
                {inScopePct}
                <span className="level-pct-unit">%</span>
              </>
            )}
          </span>
        </div>
        <div>
          <span className="caption">Full</span>
          <span className="level-full mono">
            {Math.round(score.fullPct * 100)}%
          </span>
        </div>
      </div>
      <p className="level-card-note muted mono">
        {score.pass + score.exception} of {inScopeDenom} in scope
        {score.pending > 0 && ` · ${score.pending} pending`}
      </p>
      <div className={`threshold-bar tone-${tone}`}>
        <div
          className="threshold-bar-fill"
          style={{ width: `${(score.inScopePct ?? 0) * 100}%` }}
        />
      </div>
    </button>
  );
}

function CategoryRow({
  score,
  onJump,
}: {
  score: CategoryScore;
  onJump: () => void;
}) {
  const tone = toneFor(score.inScopePct);
  // Until the parser extracts category names, `name` is empty and we fall
  // back to the number — same render path either way.
  const label = score.name || score.number;
  return (
    <li>
      <button type="button" className="category-row" onClick={onJump}>
        <span className="category-label">{label}</span>
        <span className="category-pct mono">
          {score.pass} / {score.inScope}
        </span>
        <span className={`category-bar tone-${tone}`}>
          <span
            className="category-bar-fill"
            style={{ width: `${score.inScopePct * 100}%` }}
          />
        </span>
      </button>
    </li>
  );
}

function toneFor(pct: number | null): "pass" | "warn" | "fail" | "neutral" {
  if (pct === null) return "neutral";
  if (pct >= 0.8) return "pass";
  if (pct >= 0.5) return "warn";
  return "fail";
}

function levelName(level: Level): string {
  switch (level) {
    case "L1":
      return "Level 1";
    case "L2":
      return "Level 2";
    case "BL":
      return "BitLocker";
  }
}

function formatDate(iso: string): string {
  return iso.slice(0, 10);
}
