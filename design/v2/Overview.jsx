// v2 Overview — Document / editorial format.
// Audience: management. Wide reading column, restrained typography,
// posture sentence first, trend chart, then sections.

function V2Overview({ openDetail, jumpToConsole }) {
  const { data, recs, posture } = useV2Data();
  if (!data || !recs) {
    return <div style={{ padding: 60, color: 'var(--v-text-muted)', fontSize: 13 }}>Loading…</div>;
  }

  // Trend series — augment scan_history with current.
  const history = (data.scan_history || []).map((s) => ({
    scan_date: s.date,
    overall_score: s.pass_pct,
    passed: s.pass, failed: s.fail,
  }));

  // Recompute per-category passPct using the assessable definition:
  // (pass + exception) / (total − manual − N/A). The original passPct
  // baked into compliance-data.json penalizes exceptions; we want the
  // operational signal here, so we override.
  const catsAssessable = data.categories.map((c) => {
    const recsInCat = recs.filter((r) => parseInt(r.id.split('.')[0], 10) === c.id);
    const assessable = recsInCat.filter((r) => r.status !== 'manual' && r.status !== 'not-applicable');
    const passing = assessable.filter((r) => r.status === 'pass' || r.status === 'exception').length;
    const fails = assessable.filter((r) => r.status === 'fail').length;
    const passPct = assessable.length ? +((passing / assessable.length) * 100).toFixed(1) : 0;
    return { ...c, passPct, assessable: assessable.length, passing, fails };
  });

  const weakCats = catsAssessable.filter((c) => c.assessable >= 3).sort((a, b) => a.passPct - b.passPct).slice(0, 6);
  const recentlyChanged = recs.filter((r) => r.delta === 'improved' || r.delta === 'regressed').slice(0, 12);
  const topFailing = recs.filter((r) => r.status === 'fail').sort((a, b) => b.impact_score - a.impact_score).slice(0, 8);

  // Per-level: in-scope score + full-coverage score. L1 first (baseline),
  // then L2 (hardened), then BL (BitLocker, full-disk encryption).
  const levels = ['L1', 'L2', 'BL'].map((lv) => {
    const all = recs.filter((r) => r.level === lv);
    const assessable = all.filter((r) => r.status !== 'manual' && r.status !== 'not-applicable');
    const passing = assessable.filter((r) => r.status === 'pass' || r.status === 'exception').length;
    const strictPassing = all.filter((r) => r.status === 'pass').length;
    return {
      lv,
      total: assessable.length,
      passing,
      pct: assessable.length ? +((passing / assessable.length) * 100).toFixed(1) : 0,
      strictTotal: all.length,
      strictPassing,
      strictPct: all.length ? +((strictPassing / all.length) * 100).toFixed(1) : 0,
    };
  });

  return (
    <div style={{ background: 'var(--v-bg)', minHeight: '100%' }}>
      <article style={{
        maxWidth: 880,
        margin: '0 auto',
        padding: '64px 56px 96px',
        color: 'var(--v-text)',
      }}>
        {/* ── Document header ── */}
        <header style={{ marginBottom: 48 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginBottom: 12, fontSize: 11, color: 'var(--v-text-subtle)', textTransform: 'uppercase', letterSpacing: '0.12em', fontWeight: 600 }}>
            <span>Compliance Report</span>
            <span style={{ width: 1, height: 10, background: 'var(--v-line-strong)' }} />
            <span className="v2-mono" style={{ textTransform: 'none', letterSpacing: 0 }}>
              {new Date(data.device.last_scan).toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' })}
            </span>
          </div>

          <h1 className="v2-serif" style={{
            margin: '0 0 14px',
            fontSize: 44,
            fontWeight: 400,
            lineHeight: 1.08,
            letterSpacing: '-0.02em',
          }}>
            Windows 11 — CIS Benchmark
          </h1>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 13, color: 'var(--v-text-muted)' }}>
            <span className="v2-mono">{data.device.name}</span>
            <span style={{ color: 'var(--v-text-subtle)' }}>·</span>
            <span>{data.device.os}</span>
            <span style={{ color: 'var(--v-text-subtle)' }}>·</span>
            <span>{data.device.benchmark_version}</span>
          </div>
        </header>

        {/* ── Headline strip + score by level ── */}
        <section style={{ marginBottom: 48, paddingBottom: 40, borderBottom: '1px solid var(--v-line)' }}>
          {/* Headline: deterministic, fact-only. */}
          <div style={{
            display: 'flex',
            alignItems: 'baseline',
            gap: 14,
            paddingBottom: 24,
            marginBottom: 28,
            borderBottom: '1px solid var(--v-line-soft)',
            flexWrap: 'wrap',
          }}>
            <span className="v2-serif" style={{ fontSize: 24, fontWeight: 400, letterSpacing: '-0.012em' }}>
              Posture is <em style={{
                fontStyle: 'italic',
                color: posture.trend === 'improving' ? 'var(--v-pass)' : posture.trend === 'declining' ? 'var(--v-fail)' : 'var(--v-text)',
              }}>{posture.trend}</em>.
            </span>
            <span style={{ fontSize: 13, color: 'var(--v-text-muted)' }} className="v2-tabular">
              {posture.change >= 0 ? '↑' : '↓'} {Math.abs(posture.change).toFixed(1)} pts in 30 days
            </span>
            <span style={{ width: 1, height: 12, background: 'var(--v-line-strong)' }} />
            <span style={{ fontSize: 13, color: 'var(--v-text-muted)' }} className="v2-tabular">
              {posture.improved} remediated · {posture.regressed} regressed
            </span>
            {posture.weakCats > 0 && <>
              <span style={{ width: 1, height: 12, background: 'var(--v-line-strong)' }} />
              <span style={{ fontSize: 13, color: 'var(--v-text-muted)' }} className="v2-tabular">
                {posture.weakCats} categor{posture.weakCats === 1 ? 'y' : 'ies'} below 50%
              </span>
            </>}
          </div>

          {/* Score by level — full-width 3-card row. */}
          <div style={{ marginBottom: 14 }}>
            <div style={{ fontSize: 10, fontWeight: 600, color: 'var(--v-text-subtle)', textTransform: 'uppercase', letterSpacing: '0.1em' }}>
              § Score by level
            </div>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 16 }}>
            {levels.map((l) => (
              <div
                key={l.lv}
                onClick={() => jumpToConsole && jumpToConsole({ level: l.lv })}
                style={{
                  border: '1px solid var(--v-line)',
                  borderRadius: 4,
                  background: 'var(--v-paper)',
                  padding: '20px 22px',
                  cursor: 'pointer',
                  transition: 'border-color 120ms ease, background 120ms ease',
                }}
                onMouseEnter={(e) => { e.currentTarget.style.borderColor = 'var(--v-line-strong)'; }}
                onMouseLeave={(e) => { e.currentTarget.style.borderColor = 'var(--v-line)'; }}
              >
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
                  <V2LevelChip level={l.lv} />
                  <span style={{ fontSize: 10, color: 'var(--v-text-subtle)', fontWeight: 500 }}>
                    {V2_LEVEL[l.lv].long}
                  </span>
                </div>
                <div style={{ display: 'flex', alignItems: 'flex-end', gap: 18, justifyContent: 'space-between' }}>
                  <div>
                    <div style={{ fontSize: 9, color: 'var(--v-text-subtle)', textTransform: 'uppercase', letterSpacing: '0.1em', fontWeight: 600, marginBottom: 4 }}>
                      In-scope
                    </div>
                    <div className="v2-serif v2-tabular" style={{
                      fontSize: 44,
                      fontWeight: 400,
                      lineHeight: 1,
                      letterSpacing: '-0.02em',
                      color: l.pct >= 80 ? 'var(--v-pass)' : l.pct >= 50 ? 'var(--v-warn)' : 'var(--v-fail)',
                    }}>
                      {l.pct.toFixed(1)}<span style={{ fontSize: 16, color: 'var(--v-text-subtle)', marginLeft: 2 }}>%</span>
                    </div>
                  </div>
                  <div style={{ textAlign: 'right' }}>
                    <div style={{ fontSize: 9, color: 'var(--v-text-subtle)', textTransform: 'uppercase', letterSpacing: '0.1em', fontWeight: 600, marginBottom: 4 }}>
                      Full
                    </div>
                    <div className="v2-tabular" style={{ fontSize: 18, fontWeight: 500, lineHeight: 1, color: 'var(--v-text-2)' }}>
                      {l.strictPct.toFixed(1)}<span style={{ fontSize: 11, color: 'var(--v-text-subtle)', marginLeft: 1 }}>%</span>
                    </div>
                  </div>
                </div>
                <div style={{ marginTop: 10, fontSize: 11, color: 'var(--v-text-subtle)' }} className="v2-tabular">
                  {l.passing} of {l.total} in scope
                </div>
                <div style={{ marginTop: 10, height: 4, background: 'var(--v-line)', borderRadius: 2, overflow: 'hidden' }}>
                  <div style={{ width: `${l.pct}%`, height: '100%', background: l.pct >= 80 ? 'var(--v-pass)' : l.pct >= 50 ? 'var(--v-warn)' : 'var(--v-fail)' }} />
                </div>
              </div>
            ))}
          </div>
        </section>

        {/* ── §1 Trend ── */}
        <V2DocSection num="1" title="Trend">
          <p style={v2BodyP}>
            Compliance score across the last six scans. Each point represents a full benchmark run; the rightmost is today's value.
          </p>
          <figure style={{ margin: '20px 0 8px', padding: '20px 8px 8px', background: 'var(--v-paper)', border: '1px solid var(--v-line)', borderRadius: 4 }}>
            <V2TrendChart history={history} width={760} height={220} />
          </figure>
          <figcaption style={{ fontSize: 11, color: 'var(--v-text-subtle)', fontStyle: 'italic' }}>
            Fig. 1 — Overall compliance score, unweighted across all assessable controls.
          </figcaption>
        </V2DocSection>

        {/* ── §2 Weakest categories ── */}
        <V2DocSection num="2" title="Weakest categories">
          <p style={v2BodyP}>
            Six categories with the lowest pass rates. These represent the largest concentrations of remediation work.
          </p>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0 32px', marginTop: 16 }}>
            {weakCats.map((c) => (
              <button
                key={c.id}
                onClick={() => jumpToConsole && jumpToConsole({ category: c.id })}
                style={{
                  textAlign: 'left',
                  padding: '14px 0',
                  borderTop: '1px solid var(--v-line)',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 8,
                  cursor: 'pointer',
                }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 12 }}>
                  <span style={{ fontSize: 14, fontWeight: 500 }}>{c.name}</span>
                  <span className="v2-mono" style={{ fontSize: 13, color: c.passPct < 50 ? 'var(--v-fail)' : 'var(--v-warn)', fontWeight: 600 }}>{c.passPct}%</span>
                </div>
                <V2StatusBar counts={c} height={4} />
                <div style={{ fontSize: 11, color: 'var(--v-text-subtle)', display: 'flex', gap: 10 }}>
                  <span>{c.fail} failing</span>
                  <span>·</span>
                  <span>{c.pass} passing</span>
                  {c.exception > 0 && <><span>·</span><span>{c.exception} exception</span></>}
                </div>
              </button>
            ))}
          </div>
        </V2DocSection>

        {/* ── §3 Top failing ── */}
        <V2DocSection num="3" title="Highest-impact failures">
          <p style={v2BodyP}>
            The eight failing recommendations with the highest impact scores. Begin remediation here.
          </p>
          <ol style={{ margin: '20px 0 0', padding: 0, listStyle: 'none' }}>
            {topFailing.map((r, i) => (
              <li
                key={r.id}
                onClick={() => openDetail && openDetail(r)}
                style={{
                  display: 'grid',
                  gridTemplateColumns: '32px 70px 1fr auto auto',
                  gap: 16,
                  alignItems: 'center',
                  padding: '12px 0',
                  borderTop: '1px solid var(--v-line)',
                  cursor: 'pointer',
                }}
              >
                <span className="v2-mono" style={{ fontSize: 11, color: 'var(--v-text-subtle)' }}>{String(i + 1).padStart(2, '0')}</span>
                <span className="v2-mono" style={{ fontSize: 11, color: 'var(--v-text-muted)' }}>CIS {r.id}</span>
                <span style={{ fontSize: 13, color: 'var(--v-text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.title}</span>
                <V2LevelChip level={r.level} />
                <V2ImpactBar value={r.impact_score} />
              </li>
            ))}
          </ol>
        </V2DocSection>

        {/* ── §4 Recently changed ── */}
        <V2DocSection num="4" title="Recently changed">
          <p style={v2BodyP}>
            Controls whose status flipped in the most recent scan, relative to the prior one.
          </p>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0 32px', marginTop: 16 }}>
            <ChangeCol title="Improved" color="var(--v-pass)" symbol="▲" items={recentlyChanged.filter((r) => r.delta === 'improved').slice(0, 6)} openDetail={openDetail} />
            <ChangeCol title="Regressed" color="var(--v-fail)" symbol="▼" items={recentlyChanged.filter((r) => r.delta === 'regressed').slice(0, 6)} openDetail={openDetail} />
          </div>
        </V2DocSection>

        {/* ── Footer ── */}
        <footer style={{ marginTop: 64, paddingTop: 24, borderTop: '1px solid var(--v-line)', display: 'flex', justifyContent: 'space-between', fontSize: 11, color: 'var(--v-text-subtle)' }}>
          <span>{data.device.benchmark_version}</span>
          <span className="v2-mono">{data.totals.total_recs} of {data.totals.benchmark_total} recommendations applicable to this profile</span>
        </footer>
      </article>
    </div>
  );
}

// ── Helpers ─────────────────────────────────────────────────────
function V2DocSection({ num, title, children }) {
  return (
    <section style={{ marginBottom: 56 }}>
      <h2 className="v2-serif" style={{
        margin: '0 0 12px',
        fontSize: 22,
        fontWeight: 500,
        letterSpacing: '-0.012em',
        display: 'flex', alignItems: 'baseline', gap: 12,
      }}>
        <span className="v2-mono" style={{ fontSize: 12, color: 'var(--v-text-subtle)', fontWeight: 400 }}>§ {num}</span>
        {title}
      </h2>
      {children}
    </section>
  );
}

function ChangeCol({ title, color, symbol, items, openDetail }) {
  return (
    <div>
      <div style={{ fontSize: 11, fontWeight: 600, color, textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 8, display: 'flex', alignItems: 'center', gap: 6 }}>
        <span>{symbol}</span>
        <span>{title}</span>
        <span style={{ color: 'var(--v-text-subtle)', fontWeight: 400 }}>· {items.length}</span>
      </div>
      {items.length === 0 ? (
        <div style={{ fontSize: 12, color: 'var(--v-text-subtle)', fontStyle: 'italic', padding: '8px 0' }}>None this scan.</div>
      ) : (
        <ul style={{ margin: 0, padding: 0, listStyle: 'none' }}>
          {items.map((r) => (
            <li
              key={r.id}
              onClick={() => openDetail && openDetail(r)}
              style={{ padding: '10px 0', borderTop: '1px solid var(--v-line)', cursor: 'pointer', display: 'flex', flexDirection: 'column', gap: 4 }}
            >
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <span className="v2-mono" style={{ fontSize: 10, color: 'var(--v-text-subtle)' }}>{r.id}</span>
                <V2LevelChip level={r.level} />
              </div>
              <div style={{ fontSize: 12, color: 'var(--v-text-2)', lineHeight: 1.4 }}>{r.title}</div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

const v2BodyP = {
  margin: 0,
  fontSize: 14,
  lineHeight: 1.62,
  color: 'var(--v-text-2)',
};

const v2DocTable = {
  width: '100%',
  borderCollapse: 'collapse',
  marginTop: 18,
  fontSize: 13,
};
const v2DocTh = {
  textAlign: 'left',
  fontSize: 10,
  fontWeight: 600,
  color: 'var(--v-text-subtle)',
  textTransform: 'uppercase',
  letterSpacing: '0.08em',
  padding: '8px 12px',
  borderBottom: '1px solid var(--v-line-strong)',
};
const v2DocTd = {
  padding: '12px',
  borderBottom: '1px solid var(--v-line)',
  color: 'var(--v-text)',
};

Object.assign(window, { V2Overview });
