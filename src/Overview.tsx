import type { Baseline, Level, Scan, UserState } from "./bindings";
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
}: {
  baseline: Baseline;
  scan: Scan;
  userState: UserState;
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
            <LevelCard key={score.level} score={score} />
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
              <CategoryRow key={cat.number} score={cat} />
            ))}
          </ul>
        )}
      </section>
    </article>
  );
}

function LevelCard({ score }: { score: LevelScore }) {
  const tone = toneFor(score.inScopePct);
  const inScopeText =
    score.inScopePct === null ? "—" : `${Math.round(score.inScopePct * 100)}%`;
  const inScopeDenom = score.total - score.manual;
  return (
    <div className="level-card">
      <div className="level-card-head">
        <span className={`level-chip level-${score.level.toLowerCase()}`}>
          {score.level}
        </span>
        <span className="level-card-name">{levelName(score.level)}</span>
      </div>
      <div className="level-card-numbers">
        <div>
          <span className="caption">In-scope</span>
          <span className={`level-pct serif tone-${tone}`}>{inScopeText}</span>
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
      </p>
      <div className={`threshold-bar tone-${tone}`}>
        <div
          className="threshold-bar-fill"
          style={{ width: `${(score.inScopePct ?? 0) * 100}%` }}
        />
      </div>
    </div>
  );
}

function CategoryRow({ score }: { score: CategoryScore }) {
  const tone = toneFor(score.inScopePct);
  // Until the parser extracts category names, `name` is empty and we fall
  // back to the number — same render path either way.
  const label = score.name || score.number;
  return (
    <li>
      <span className="category-label">{label}</span>
      <span className="category-pct mono">
        {score.pass} / {score.inScope}
      </span>
      <div className={`category-bar tone-${tone}`}>
        <div
          className="category-bar-fill"
          style={{ width: `${score.inScopePct * 100}%` }}
        />
      </div>
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
