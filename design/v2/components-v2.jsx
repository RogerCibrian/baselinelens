// v2 shared components — chips, sparkline, trend chart, mini bar.

// ── Chips ──────────────────────────────────────────────────────
function V2Chip({ children, color, bg, border, mono, style }) {
  return (
    <span
      className={mono ? 'v2-mono' : 'v2-tabular'}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 5,
        height: 20,
        padding: '0 7px',
        fontSize: 11,
        fontWeight: 500,
        letterSpacing: '0.01em',
        color: color || 'var(--v-text-muted)',
        background: bg || 'var(--v-paper-3)',
        border: border || '1px solid transparent',
        borderRadius: 4,
        whiteSpace: 'nowrap',
        ...style,
      }}
    >
      {children}
    </span>
  );
}

function V2StatusChip({ status, work }) {
  // If there's a work overlay on a fail, show that instead.
  if (work && V2_WORK[work]) {
    const w = V2_WORK[work];
    return (
      <V2Chip color={w.color} bg={w.bg}>
        <span style={{ width: 5, height: 5, borderRadius: 1, background: w.color }} />
        {w.label}
      </V2Chip>
    );
  }
  const s = V2_STATUS[status] || V2_STATUS.manual;
  return (
    <V2Chip color={s.color} bg={s.bg}>
      <span style={{ width: 5, height: 5, borderRadius: 1, background: s.color }} />
      {s.label}
    </V2Chip>
  );
}

function V2LevelChip({ level }) {
  const l = V2_LEVEL[level] || V2_LEVEL.L1;
  return <V2Chip mono color={l.color} bg={l.bg} style={{ letterSpacing: '0.04em', fontWeight: 600 }}>{l.label}</V2Chip>;
}

function V2DeltaChip({ delta }) {
  if (delta === 'improved') return <V2Chip color="var(--v-pass)" bg="var(--v-pass-bg)">▲ Improved</V2Chip>;
  if (delta === 'regressed') return <V2Chip color="var(--v-fail)" bg="var(--v-fail-bg)">▼ Regressed</V2Chip>;
  return null;
}

// ── Trend chart (Overview hero chart) ──────────────────────────
function V2TrendChart({ history, width = 720, height = 220 }) {
  if (!history || history.length === 0) return null;
  const padL = 44, padR = 16, padT = 16, padB = 28;
  const w = width - padL - padR;
  const h = height - padT - padB;

  // Build a passing-percentage series.
  const series = history.map((s) => ({
    date: new Date(s.scan_date),
    value: s.overall_score ?? s.passPct ?? s.value ?? 0,
    failed: s.failed ?? null,
    passed: s.passed ?? null,
  }));
  const min = Math.min(...series.map((s) => s.value)) - 4;
  const max = Math.max(...series.map((s) => s.value)) + 4;
  const range = Math.max(1, max - min);

  const x = (i) => padL + (i / (series.length - 1)) * w;
  const y = (v) => padT + h - ((v - min) / range) * h;

  const linePath = series.map((s, i) => `${i === 0 ? 'M' : 'L'} ${x(i).toFixed(1)} ${y(s.value).toFixed(1)}`).join(' ');
  const areaPath = linePath + ` L ${x(series.length - 1)} ${padT + h} L ${x(0)} ${padT + h} Z`;

  // Y axis ticks
  const ticks = 4;
  const yTicks = Array.from({ length: ticks + 1 }, (_, i) => min + (range * i) / ticks);

  return (
    <svg width={width} height={height} style={{ display: 'block', overflow: 'visible' }}>
      <defs>
        <linearGradient id="v2-trend-grad" x1="0" x2="0" y1="0" y2="1">
          <stop offset="0%" stopColor="var(--v-accent)" stopOpacity="0.20" />
          <stop offset="100%" stopColor="var(--v-accent)" stopOpacity="0" />
        </linearGradient>
      </defs>

      {/* y grid */}
      {yTicks.map((t, i) => (
        <g key={i}>
          <line
            x1={padL} x2={padL + w}
            y1={y(t)} y2={y(t)}
            stroke="var(--v-line)"
            strokeDasharray={i === 0 ? '0' : '2 4'}
          />
          <text
            x={padL - 8} y={y(t)} dy={3.5}
            fontSize="10"
            fill="var(--v-text-subtle)"
            textAnchor="end"
            fontFamily="var(--v-font-mono)"
          >
            {t.toFixed(0)}%
          </text>
        </g>
      ))}

      {/* area + line */}
      <path d={areaPath} fill="url(#v2-trend-grad)" />
      <path d={linePath} stroke="var(--v-accent)" strokeWidth={1.75} fill="none" strokeLinecap="round" strokeLinejoin="round" />

      {/* dots + labels */}
      {series.map((s, i) => (
        <g key={i}>
          <circle cx={x(i)} cy={y(s.value)} r={3} fill="var(--v-paper)" stroke="var(--v-accent)" strokeWidth={1.5} />
          <text
            x={x(i)} y={padT + h + 16}
            fontSize="10"
            fill="var(--v-text-subtle)"
            textAnchor="middle"
            fontFamily="var(--v-font-mono)"
          >
            {s.date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
          </text>
        </g>
      ))}

      {/* current value pinned */}
      {(() => {
        const last = series[series.length - 1];
        return (
          <g>
            <line
              x1={x(series.length - 1)} x2={x(series.length - 1)}
              y1={y(last.value)} y2={padT + h}
              stroke="var(--v-accent)" strokeOpacity="0.3" strokeDasharray="2 3"
            />
          </g>
        );
      })()}
    </svg>
  );
}

// ── Stacked status bar ─────────────────────────────────────────
function V2StatusBar({ counts, height = 6 }) {
  const total = (counts.pass || 0) + (counts.fail || 0) + (counts.exception || 0) + (counts.manual || 0);
  if (!total) return null;
  const seg = (n, color) => ({ flex: n, background: color, height });
  return (
    <div style={{ display: 'flex', borderRadius: 1, overflow: 'hidden', background: 'var(--v-line)', height }}>
      {counts.pass ? <div style={seg(counts.pass, 'var(--v-pass)')} /> : null}
      {counts.exception ? <div style={seg(counts.exception, 'var(--v-exception)')} /> : null}
      {counts.manual ? <div style={seg(counts.manual, 'var(--v-manual)')} /> : null}
      {counts.fail ? <div style={seg(counts.fail, 'var(--v-fail)')} /> : null}
    </div>
  );
}

// ── Impact bar (0–10) ──────────────────────────────────────────
function V2ImpactBar({ value }) {
  const pct = Math.max(0, Math.min(10, value)) * 10;
  const color = value >= 8 ? 'var(--v-fail)' : value >= 5 ? 'var(--v-warn)' : 'var(--v-text-muted)';
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <div style={{ width: 60, height: 4, background: 'var(--v-line)', borderRadius: 2, overflow: 'hidden' }}>
        <div style={{ width: `${pct}%`, height: '100%', background: color }} />
      </div>
      <span className="v2-mono" style={{ fontSize: 11, color: 'var(--v-text-muted)', minWidth: 18, textAlign: 'right' }}>{value}</span>
    </div>
  );
}

// ── Detail drawer (v2) ─────────────────────────────────────────
function V2DetailDrawer({ rec, onClose }) {
  React.useEffect(() => {
    if (!rec) return;
    const h = (e) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', h);
    return () => document.removeEventListener('keydown', h);
  }, [rec, onClose]);

  if (!rec) return null;
  const s = V2_STATUS[rec.status] || V2_STATUS.manual;

  return (
    <div
      onClick={onClose}
      style={{
        position: 'absolute', inset: 0, zIndex: 100,
        background: 'rgba(0,0,0,0.36)',
        display: 'flex', justifyContent: 'flex-end',
        animation: 'v2Fade .15s var(--v-ease)',
      }}
    >
      <style>{`
        @keyframes v2Fade { from{opacity:0} to{opacity:1} }
        @keyframes v2Slide { from{transform:translateX(20px);opacity:0} to{transform:translateX(0);opacity:1} }
      `}</style>
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 560, maxWidth: '95%', height: '100%',
          background: 'var(--v-paper)',
          borderLeft: '1px solid var(--v-line)',
          overflow: 'auto',
          animation: 'v2Slide .18s var(--v-ease)',
          boxShadow: 'var(--v-shadow-lg)',
        }}
      >
        <div style={{ padding: '18px 24px 14px', borderBottom: '1px solid var(--v-line)', display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span className="v2-mono" style={{ fontSize: 11, color: 'var(--v-text-subtle)' }}>CIS {rec.id}</span>
            <button onClick={onClose} style={{ width: 26, height: 26, borderRadius: 4, color: 'var(--v-text-muted)', background: 'var(--v-paper-3)' }}>
              ✕
            </button>
          </div>
          <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
            <V2LevelChip level={rec.level} />
            <V2StatusChip status={rec.status} work={rec.work} />
            {rec.delta && rec.delta !== 'unchanged' && <V2DeltaChip delta={rec.delta} />}
            <V2Chip>{rec.automated ? 'Automated' : 'Manual check'}</V2Chip>
          </div>
          <h2 style={{ margin: 0, fontSize: 18, fontWeight: 600, lineHeight: 1.3 }}>{rec.title}</h2>
        </div>

        <div style={{ padding: '16px 24px 40px', display: 'flex', flexDirection: 'column', gap: 18 }}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 0, border: '1px solid var(--v-line)', borderRadius: 4 }}>
            <V2Stat label="Impact" value={`${rec.impact_score}/10`} color={rec.impact_score >= 8 ? 'var(--v-fail)' : 'var(--v-text)'} />
            <V2Stat label="Failing for" value={v2FormatAge(rec.age_days)} divider />
            <V2Stat label="Last scanned" value={v2FormatRelative(rec.last_checked)} divider />
          </div>

          {rec.description && <V2Section title="Description">{rec.description}</V2Section>}
          {rec.rationale && <V2Section title="Rationale">{rec.rationale}</V2Section>}
          {rec.impact_text && <V2Section title="Operational impact">{rec.impact_text}</V2Section>}
          {rec.remediation && (
            <V2Section title="Remediation">
              <pre style={{
                margin: 0, padding: 12,
                background: 'var(--v-paper-3)',
                borderRadius: 4,
                fontFamily: 'var(--v-font-mono)',
                fontSize: 12, color: 'var(--v-text)',
                whiteSpace: 'pre-wrap', wordBreak: 'break-word',
                lineHeight: 1.55,
              }}>{rec.remediation}</pre>
            </V2Section>
          )}

          <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
            {rec.status !== 'pass' && (
              <>
                <button style={v2BtnPrimary}>Mark in progress</button>
                <button style={v2BtnGhost}>Add exception</button>
                <button style={v2BtnGhost}>Snooze</button>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function V2Stat({ label, value, color, divider }) {
  return (
    <div style={{ padding: '10px 14px', borderLeft: divider ? '1px solid var(--v-line)' : 'none' }}>
      <div style={{ fontSize: 10, color: 'var(--v-text-subtle)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 4 }}>{label}</div>
      <div className="v2-tabular" style={{ fontSize: 14, fontWeight: 600, color: color || 'var(--v-text)' }}>{value}</div>
    </div>
  );
}
function V2Section({ title, children }) {
  return (
    <div>
      <div style={{ fontSize: 10, color: 'var(--v-text-subtle)', textTransform: 'uppercase', letterSpacing: '0.08em', fontWeight: 600, marginBottom: 6 }}>{title}</div>
      <div style={{ fontSize: 13, color: 'var(--v-text-2)', lineHeight: 1.55 }}>{children}</div>
    </div>
  );
}

const v2BtnPrimary = {
  height: 30, padding: '0 12px',
  background: 'var(--v-accent)', color: 'var(--v-accent-on)',
  borderRadius: 4, fontSize: 12, fontWeight: 600,
};
const v2BtnGhost = {
  height: 30, padding: '0 12px',
  background: 'var(--v-paper-3)', color: 'var(--v-text)',
  border: '1px solid var(--v-line)',
  borderRadius: 4, fontSize: 12, fontWeight: 500,
};

Object.assign(window, {
  V2Chip, V2StatusChip, V2LevelChip, V2DeltaChip,
  V2TrendChart, V2StatusBar, V2ImpactBar,
  V2DetailDrawer, v2BtnPrimary, v2BtnGhost,
});
