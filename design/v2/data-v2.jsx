// v2 data extensions — layered on top of base compliance data.
// Adds: status delta vs prior scan, age in days, in-progress/snoozed,
// saved views, remediation bundles (placeholder for OpenBaseline),
// trend series (uses existing scan_history), posture sentence.

const V2_DATA_URL = 'compliance-data.json';

// Deterministic pseudo-random from a string seed (so mocks are stable).
function v2hash(s) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) / 4294967295;
}

// Enrich a raw rec with mocked time/work concepts.
function v2EnrichRec(rec) {
  const r1 = v2hash(rec.id + ':age');
  const r2 = v2hash(rec.id + ':delta');
  const r3 = v2hash(rec.id + ':work');

  // Age (days failing/passing). Cap at 90, skew younger.
  const ageDays = Math.floor(Math.pow(r1, 1.4) * 90);

  // Status delta vs previous scan. ~80% unchanged, ~10% improved, ~10% regressed.
  // Exceptions never count as regressions — they're documented decisions, not slips.
  let delta = 'unchanged';
  const isGood = rec.status === 'pass' || rec.status === 'exception';
  if (r2 < 0.10) delta = isGood ? 'improved' : 'regressed';
  else if (r2 < 0.20) delta = isGood ? 'regressed' : 'improved';
  if (rec.status === 'exception' && delta === 'regressed') delta = 'unchanged';

  // Work status overlay (only meaningful when failing).
  let work = null;
  if (rec.status === 'fail') {
    if (r3 < 0.18) work = 'in-progress';
    else if (r3 < 0.27) work = 'snoozed';
    else if (r3 < 0.34) work = 'awaiting-rescan';
  }

  // Last verified pass date — only if currently failing & has been seen passing.
  const lastVerified = rec.status === 'fail' && r1 > 0.4
    ? new Date(Date.now() - ageDays * 86400 * 1000).toISOString()
    : null;

  return { ...rec, age_days: ageDays, delta, work, last_verified_pass: lastVerified };
}

// Bundle several recs into a single remediation. Simple: group by top-level
// category id + similar title prefix. Placeholder for OpenBaseline integration.
function v2BuildBundles(recs) {
  const groups = new Map();
  recs.forEach((r) => {
    if (r.status !== 'fail') return;
    const top = r.id.split('.')[0];
    const key = `cat-${top}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  });
  // Only emit a bundle when it covers ≥3 failing recs in a category.
  const bundles = [];
  groups.forEach((items, key) => {
    if (items.length < 3) return;
    const top = items[0].id.split('.')[0];
    const catId = parseInt(top, 10);
    bundles.push({
      id: `bundle-${key}`,
      category_id: catId,
      rec_ids: items.map((r) => r.id),
      count: items.length,
      avg_impact: +(items.reduce((s, r) => s + r.impact_score, 0) / items.length).toFixed(1),
      // Placeholder source — eventually OpenBaseline templates.
      source: 'openbaseline-stub',
      title: null, // filled by view layer once cat name is in scope
    });
  });
  return bundles.sort((a, b) => b.avg_impact - a.avg_impact);
}

// Default saved views for the Console.
const V2_SAVED_VIEWS = [
  { id: 'open-fails',     name: 'Open fails',          desc: 'All currently failing',                filter: { status: 'fail' } },
  { id: 'high-impact',    name: 'High-impact fails',   desc: 'Failing with impact ≥ 8',              filter: { status: 'fail', minImpact: 8 } },
  { id: 'in-progress',    name: 'In progress',         desc: 'Currently being remediated',           filter: { work: 'in-progress' } },
  { id: 'awaiting',       name: 'Awaiting rescan',     desc: 'Policy pushed, waiting to verify',     filter: { work: 'awaiting-rescan' } },
  { id: 'snoozed',        name: 'Snoozed',             desc: 'Acknowledged, deferred',               filter: { work: 'snoozed' } },
  { id: 'regressed',      name: 'Regressed',           desc: 'Got worse since last scan',            filter: { delta: 'regressed' } },
  { id: 'recently-fixed', name: 'Recently fixed',      desc: 'Improved since last scan',             filter: { delta: 'improved' } },
  { id: 'bl-only',        name: 'BitLocker only',      desc: 'Level: BL',                            filter: { level: 'BL' } },
];

// Posture sentence — generated from numbers. Two scoring methods:
//   - assessable: passing / (all − manual − N/A); exceptions count as passing.
//     The actionable score; documented exceptions don't hurt it.
//   - strict: passing / total; exceptions count as not-passing.
//     The audit score; raw coverage of the full benchmark.
function v2PostureSentence(data, enriched) {
  const assessable = enriched.filter((r) => r.status !== 'manual' && r.status !== 'not-applicable');
  const assessablePassing = assessable.filter((r) => r.status === 'pass' || r.status === 'exception').length;
  const score = assessable.length ? +(assessablePassing / assessable.length * 100).toFixed(1) : 0;

  const strictPassing = enriched.filter((r) => r.status === 'pass').length;
  const strictScore = enriched.length ? +(strictPassing / enriched.length * 100).toFixed(1) : 0;

  const change = data.score.change_30d;
  const fails = enriched.filter((r) => r.status === 'fail');
  const improved = enriched.filter((r) => r.delta === 'improved').length;
  const regressed = enriched.filter((r) => r.delta === 'regressed').length;
  // Per-category assessable pass rate, recomputed (the precomputed
  // passPct in JSON treats exceptions as not-passing).
  const catPassPct = (catId) => {
    const inCat = enriched.filter((r) => parseInt(r.id.split('.')[0], 10) === catId);
    const ass = inCat.filter((r) => r.status !== 'manual' && r.status !== 'not-applicable');
    if (!ass.length) return 100;
    const p = ass.filter((r) => r.status === 'pass' || r.status === 'exception').length;
    return (p / ass.length) * 100;
  };
  const weakCats = data.categories.filter((c) => {
    const inCat = enriched.filter((r) => parseInt(r.id.split('.')[0], 10) === c.id);
    const ass = inCat.filter((r) => r.status !== 'manual' && r.status !== 'not-applicable');
    return ass.length >= 3 && catPassPct(c.id) < 50;
  }).length;

  const trend = change > 0 ? 'improving' : change < 0 ? 'declining' : 'stable';
  return {
    trend,
    score, strictScore,
    assessablePassing, assessableTotal: assessable.length,
    strictPassing, strictTotal: enriched.length,
    change,
    fails: fails.length,
    improved, regressed, weakCats,
  };
}

// Hook: load + enrich.
function useV2Data() {
  const [raw, setRaw] = React.useState(null);
  const [err, setErr] = React.useState(null);
  React.useEffect(() => {
    fetch(V2_DATA_URL).then((r) => r.json()).then(setRaw).catch((e) => setErr(e.message));
  }, []);
  return React.useMemo(() => {
    if (!raw) return { data: null, recs: null, bundles: null, posture: null, err };
    const recs = raw.recommendations.map(v2EnrichRec);
    const bundles = v2BuildBundles(recs);
    const posture = v2PostureSentence(raw, recs);
    return { data: raw, recs, bundles, posture, err };
  }, [raw, err]);
}

// ─── Palettes / formatters ──────────────────────────────────────
const V2_STATUS = {
  pass:        { label: 'Pass',        color: 'var(--v-pass)',      bg: 'var(--v-pass-bg)' },
  fail:        { label: 'Fail',        color: 'var(--v-fail)',      bg: 'var(--v-fail-bg)' },
  exception:   { label: 'Exception',   color: 'var(--v-exception)', bg: 'var(--v-exception-bg)' },
  manual:      { label: 'Manual',      color: 'var(--v-manual)',    bg: 'var(--v-manual-bg)' },
};
const V2_WORK = {
  'in-progress':     { label: 'In progress',     color: 'var(--v-progress)',  bg: 'var(--v-progress-bg)' },
  'awaiting-rescan': { label: 'Awaiting rescan', color: 'var(--v-warn)',      bg: 'var(--v-warn-bg)' },
  'snoozed':         { label: 'Snoozed',         color: 'var(--v-snooze)',    bg: 'var(--v-snooze-bg)' },
};
const V2_LEVEL = {
  BL: { label: 'BL', long: 'BitLocker', color: 'var(--v-bl)', bg: 'var(--v-bl-bg)', weight: 3 },
  L1: { label: 'L1', long: 'Level 1',   color: 'var(--v-l1)', bg: 'var(--v-l1-bg)', weight: 2 },
  L2: { label: 'L2', long: 'Level 2',   color: 'var(--v-l2)', bg: 'var(--v-l2-bg)', weight: 1 },
};

function v2FormatRelative(iso) {
  if (!iso) return '—';
  try {
    const d = new Date(iso);
    const diffSec = (Date.now() - d.getTime()) / 1000;
    if (diffSec < 60) return 'just now';
    if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m ago`;
    if (diffSec < 86400) return `${Math.floor(diffSec / 3600)}h ago`;
    if (diffSec < 86400 * 7) return `${Math.floor(diffSec / 86400)}d ago`;
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  } catch { return iso; }
}

function v2FormatAge(days) {
  if (days == null) return '—';
  if (days < 1) return 'today';
  if (days < 30) return `${days}d`;
  if (days < 365) return `${Math.floor(days / 30)}mo`;
  return `${Math.floor(days / 365)}y`;
}

Object.assign(window, {
  useV2Data, V2_STATUS, V2_WORK, V2_LEVEL,
  V2_SAVED_VIEWS, v2FormatRelative, v2FormatAge,
});
