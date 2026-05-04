// v2 Console — Operations admin tool.
// Audience: SysAdmin/SecEng. Saved views (left rail), filter chips,
// dense table, bundle hint chips, deep-link aware.

function V2Console({ openDetail, initialFilter }) {
  const { data, recs, bundles } = useV2Data();
  const [view, setView] = React.useState('all');
  const [selectedCat, setSelectedCat] = React.useState(initialFilter?.category ?? 'all');
  const [selectedStatus, setSelectedStatus] = React.useState(initialFilter?.status ?? 'all');
  const [selectedLevel, setSelectedLevel] = React.useState(initialFilter?.level ?? 'all');
  const [selectedWork, setSelectedWork] = React.useState('all');
  const [selectedDelta, setSelectedDelta] = React.useState('all');
  const [minImpact, setMinImpact] = React.useState(0);
  const [query, setQuery] = React.useState('');
  const [sort, setSort] = React.useState({ key: 'impact', dir: 'desc' });

  // Honor incoming deep-link.
  React.useEffect(() => {
    if (!initialFilter) return;
    if (initialFilter.category !== undefined) setSelectedCat(initialFilter.category);
    if (initialFilter.status !== undefined) setSelectedStatus(initialFilter.status);
    if (initialFilter.level !== undefined) setSelectedLevel(initialFilter.level);
    setView('custom');
  }, [initialFilter]);

  // Counts for left rail. Must be declared BEFORE any early-return to keep hook order stable.
  const viewCounts = React.useMemo(() => {
    if (!recs) return { all: 0 };
    const out = { all: recs.length };
    V2_SAVED_VIEWS.forEach((v) => {
      out[v.id] = recs.filter((r) => {
        if (v.filter.status && r.status !== v.filter.status) return false;
        if (v.filter.level && r.level !== v.filter.level) return false;
        if (v.filter.work && r.work !== v.filter.work) return false;
        if (v.filter.delta && r.delta !== v.filter.delta) return false;
        if (v.filter.minImpact && r.impact_score < v.filter.minImpact) return false;
        return true;
      }).length;
    });
    return out;
  }, [recs]);

  if (!data || !recs) return <div style={{ padding: 60, color: 'var(--v-text-muted)' }}>Loading…</div>;

  // Apply view (saved-view preset overrides axes).
  const applyView = (vId) => {
    setView(vId);
    if (vId === 'all') {
      setSelectedCat('all'); setSelectedStatus('all'); setSelectedLevel('all');
      setSelectedWork('all'); setSelectedDelta('all'); setMinImpact(0);
      return;
    }
    const v = V2_SAVED_VIEWS.find((x) => x.id === vId);
    if (!v) return;
    setSelectedCat('all');
    setSelectedStatus(v.filter.status ?? 'all');
    setSelectedLevel(v.filter.level ?? 'all');
    setSelectedWork(v.filter.work ?? 'all');
    setSelectedDelta(v.filter.delta ?? 'all');
    setMinImpact(v.filter.minImpact ?? 0);
  };

  const filtered = recs.filter((r) => {
    if (selectedCat !== 'all') {
      const top = r.id.split('.')[0];
      if (top !== String(selectedCat)) return false;
    }
    if (selectedStatus !== 'all' && r.status !== selectedStatus) return false;
    if (selectedLevel !== 'all' && r.level !== selectedLevel) return false;
    if (selectedWork !== 'all' && r.work !== selectedWork) return false;
    if (selectedDelta !== 'all' && r.delta !== selectedDelta) return false;
    if (minImpact > 0 && r.impact_score < minImpact) return false;
    if (query) {
      const q = query.toLowerCase();
      if (!r.title.toLowerCase().includes(q) && !r.id.includes(query)) return false;
    }
    return true;
  });

  const sorted = [...filtered].sort((a, b) => {
    const dir = sort.dir === 'desc' ? -1 : 1;
    if (sort.key === 'impact') return dir * (a.impact_score - b.impact_score);
    if (sort.key === 'age') return dir * (a.age_days - b.age_days);
    if (sort.key === 'id') {
      const ap = a.id.split('.').map(Number), bp = b.id.split('.').map(Number);
      for (let i = 0; i < Math.max(ap.length, bp.length); i++) {
        const x = ap[i] ?? 0, y = bp[i] ?? 0;
        if (x !== y) return dir * (x - y);
      }
      return 0;
    }
    if (sort.key === 'status') {
      const order = { fail: 0, exception: 1, manual: 2, pass: 3 };
      return dir * ((order[a.status] ?? 9) - (order[b.status] ?? 9));
    }
    if (sort.key === 'title') return dir * a.title.localeCompare(b.title);
    return 0;
  });

  const toggleSort = (key) => {
    setSort((p) => p.key === key ? { key, dir: p.dir === 'desc' ? 'asc' : 'desc' } : { key, dir: 'desc' });
  };

  const cats = data.categories.filter((c) => c.total >= 1).sort((a, b) => a.passPct - b.passPct);

  // Active bundle hint for the current category filter.
  const activeBundle = selectedCat !== 'all' ? bundles.find((b) => String(b.category_id) === String(selectedCat)) : null;

  return (
    <div style={{ background: 'var(--v-bg)', minHeight: '100%', display: 'grid', gridTemplateColumns: '240px 1fr', minHeight: 0 }}>
      {/* ── Left rail: saved views + categories ── */}
      <aside style={{
        background: 'var(--v-paper-2)',
        borderRight: '1px solid var(--v-line)',
        padding: '20px 0',
        overflow: 'auto',
        position: 'sticky',
        top: 0,
        height: 'calc(100vh - 48px)',
      }}>
        <div style={{ padding: '0 16px', marginBottom: 16 }}>
          <RailHeader>Views</RailHeader>
          <RailItem
            active={view === 'all'}
            onClick={() => applyView('all')}
            label="All recommendations"
            count={viewCounts.all}
          />
          {V2_SAVED_VIEWS.map((v) => (
            <RailItem
              key={v.id}
              active={view === v.id}
              onClick={() => applyView(v.id)}
              label={v.name}
              count={viewCounts[v.id]}
              dot={v.id === 'open-fails' ? 'var(--v-fail)' : v.id === 'in-progress' ? 'var(--v-progress)' : v.id === 'awaiting' ? 'var(--v-warn)' : v.id === 'snoozed' ? 'var(--v-snooze)' : v.id === 'regressed' ? 'var(--v-fail)' : v.id === 'recently-fixed' ? 'var(--v-pass)' : null}
            />
          ))}
          <button style={{ ...v2RailItemStyle, color: 'var(--v-text-subtle)', fontSize: 12, marginTop: 4 }}>
            + New view
          </button>
        </div>

        <div style={{ padding: '0 16px' }}>
          <RailHeader>Categories</RailHeader>
          <RailItem
            active={selectedCat === 'all'}
            onClick={() => { setSelectedCat('all'); setView('custom'); }}
            label="All"
            count={data.totals.total_recs}
          />
          {cats.map((c) => (
            <RailItem
              key={c.id}
              active={String(selectedCat) === String(c.id)}
              onClick={() => { setSelectedCat(String(c.id)); setView('custom'); }}
              label={c.name}
              count={c.total}
              progress={c.passPct}
            />
          ))}
        </div>
      </aside>

      {/* ── Main ── */}
      <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
        {/* Filter bar */}
        <div style={{
          padding: '14px 24px',
          background: 'var(--v-paper)',
          borderBottom: '1px solid var(--v-line)',
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          flexWrap: 'wrap',
          position: 'sticky',
          top: 0,
          zIndex: 10,
        }}>
          {/* Search */}
          <div style={{
            display: 'flex', alignItems: 'center', gap: 8,
            height: 30, padding: '0 10px',
            background: 'var(--v-paper-3)',
            border: '1px solid var(--v-line)',
            borderRadius: 4,
            flex: '1 1 280px',
            maxWidth: 360,
          }}>
            <span style={{ color: 'var(--v-text-subtle)', fontSize: 12 }}>⌕</span>
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search by title or CIS id…"
              style={{ flex: 1, background: 'transparent', border: 0, outline: 'none', fontSize: 12.5, color: 'var(--v-text)' }}
            />
            {query && <button onClick={() => setQuery('')} style={{ color: 'var(--v-text-subtle)', fontSize: 12 }}>✕</button>}
          </div>

          <FilterPill
            label="Status"
            value={selectedStatus}
            onChange={(v) => { setSelectedStatus(v); setView('custom'); }}
            options={[
              { value: 'all', label: 'Any status' },
              { value: 'fail', label: 'Fail' },
              { value: 'pass', label: 'Pass' },
              { value: 'exception', label: 'Exception' },
              { value: 'manual', label: 'Manual' },
            ]}
          />
          <FilterPill
            label="Level"
            value={selectedLevel}
            onChange={(v) => { setSelectedLevel(v); setView('custom'); }}
            options={[
              { value: 'all', label: 'Any level' },
              { value: 'BL', label: 'BL' },
              { value: 'L1', label: 'L1' },
              { value: 'L2', label: 'L2' },
            ]}
          />
          <FilterPill
            label="Work"
            value={selectedWork}
            onChange={(v) => { setSelectedWork(v); setView('custom'); }}
            options={[
              { value: 'all', label: 'Any work state' },
              { value: 'in-progress', label: 'In progress' },
              { value: 'awaiting-rescan', label: 'Awaiting rescan' },
              { value: 'snoozed', label: 'Snoozed' },
            ]}
          />
          <FilterPill
            label="Δ"
            value={selectedDelta}
            onChange={(v) => { setSelectedDelta(v); setView('custom'); }}
            options={[
              { value: 'all', label: 'Any change' },
              { value: 'improved', label: 'Improved' },
              { value: 'regressed', label: 'Regressed' },
              { value: 'unchanged', label: 'Unchanged' },
            ]}
          />

          <div style={{ flex: 1 }} />

          <span className="v2-mono" style={{ fontSize: 11, color: 'var(--v-text-subtle)' }}>
            {sorted.length} of {recs.length}
          </span>

          <button style={{ ...v2BtnGhost, height: 28, fontSize: 11, padding: '0 10px' }}>Export CSV</button>
        </div>

        {/* Bundle hint banner */}
        {activeBundle && (
          <div style={{
            margin: '10px 24px 0',
            padding: '10px 14px',
            border: '1px dashed var(--v-accent-line)',
            background: 'var(--v-accent-bg)',
            borderRadius: 4,
            display: 'flex', alignItems: 'center', gap: 10,
            fontSize: 12,
          }}>
            <span style={{ width: 6, height: 6, borderRadius: 3, background: 'var(--v-accent)' }} />
            <span style={{ color: 'var(--v-accent-text)', fontWeight: 600 }}>Remediation bundle available</span>
            <span style={{ color: 'var(--v-text-muted)' }}>
              {activeBundle.count} failing controls in this category may share a single Intune policy fix.
            </span>
            <span style={{ flex: 1 }} />
            <span className="v2-mono" style={{ fontSize: 10, color: 'var(--v-text-subtle)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>via OpenBaseline</span>
            <button style={{ ...v2BtnPrimary, height: 26, fontSize: 11, padding: '0 10px' }}>View bundle</button>
          </div>
        )}

        {/* Table */}
        <div style={{ flex: 1, overflow: 'auto', padding: '12px 24px 40px' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12.5 }}>
            <thead>
              <tr style={{ background: 'var(--v-paper-2)', position: 'sticky', top: 0 }}>
                <Th onClick={() => toggleSort('id')} sortKey="id" sort={sort} width={84}>ID</Th>
                <Th onClick={() => toggleSort('status')} sortKey="status" sort={sort} width={120}>Status</Th>
                <Th width={56}>Level</Th>
                <Th onClick={() => toggleSort('title')} sortKey="title" sort={sort}>Title</Th>
                <Th onClick={() => toggleSort('impact')} sortKey="impact" sort={sort} width={120} align="right">Impact</Th>
                <Th onClick={() => toggleSort('age')} sortKey="age" sort={sort} width={70} align="right">Age</Th>
                <Th width={60}>Δ</Th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((r) => (
                <tr
                  key={r.id}
                  onClick={() => openDetail && openDetail(r)}
                  style={{ cursor: 'pointer', borderBottom: '1px solid var(--v-line)' }}
                  onMouseEnter={(e) => e.currentTarget.style.background = 'var(--v-paper-3)'}
                  onMouseLeave={(e) => e.currentTarget.style.background = 'transparent'}
                >
                  <Td><span className="v2-mono" style={{ color: 'var(--v-text-muted)' }}>{r.id}</span></Td>
                  <Td><V2StatusChip status={r.status} work={r.work} /></Td>
                  <Td><V2LevelChip level={r.level} /></Td>
                  <Td>
                    <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 540 }}>
                      {r.title}
                    </div>
                  </Td>
                  <Td align="right"><V2ImpactBar value={r.impact_score} /></Td>
                  <Td align="right"><span className="v2-mono" style={{ fontSize: 11.5, color: r.age_days > 30 ? 'var(--v-fail)' : 'var(--v-text-muted)' }}>{r.status === 'fail' ? v2FormatAge(r.age_days) : '—'}</span></Td>
                  <Td>
                    {r.delta === 'improved' && <span style={{ color: 'var(--v-pass)', fontSize: 11 }}>▲</span>}
                    {r.delta === 'regressed' && <span style={{ color: 'var(--v-fail)', fontSize: 11 }}>▼</span>}
                  </Td>
                </tr>
              ))}
              {sorted.length === 0 && (
                <tr>
                  <td colSpan={7} style={{ padding: 48, textAlign: 'center', color: 'var(--v-text-subtle)', fontSize: 13 }}>
                    No recommendations match these filters.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

// ── Sub-components ────────────────────────────────────────────
function RailHeader({ children }) {
  return (
    <div style={{ fontSize: 10, fontWeight: 600, color: 'var(--v-text-subtle)', textTransform: 'uppercase', letterSpacing: '0.1em', padding: '4px 8px 8px' }}>
      {children}
    </div>
  );
}

const v2RailItemStyle = {
  display: 'flex', alignItems: 'center', gap: 8,
  width: '100%', textAlign: 'left',
  padding: '6px 8px', height: 28,
  borderRadius: 4,
  fontSize: 12.5,
  color: 'var(--v-text-2)',
};

function RailItem({ active, onClick, label, count, dot, progress }) {
  return (
    <button
      onClick={onClick}
      style={{
        ...v2RailItemStyle,
        background: active ? 'var(--v-accent-bg)' : 'transparent',
        color: active ? 'var(--v-accent-text)' : 'var(--v-text-2)',
        fontWeight: active ? 600 : 500,
      }}
    >
      {dot && <span style={{ width: 6, height: 6, borderRadius: 1, background: dot }} />}
      <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{label}</span>
      {progress != null && (
        <span style={{ width: 24, height: 3, background: 'var(--v-line)', borderRadius: 1.5, overflow: 'hidden', flexShrink: 0 }}>
          <span style={{ display: 'block', width: `${progress}%`, height: '100%', background: progress >= 80 ? 'var(--v-pass)' : progress >= 50 ? 'var(--v-warn)' : 'var(--v-fail)' }} />
        </span>
      )}
      {count != null && (
        <span className="v2-mono" style={{ fontSize: 10.5, color: active ? 'var(--v-accent-text)' : 'var(--v-text-subtle)', minWidth: 24, textAlign: 'right' }}>{count}</span>
      )}
    </button>
  );
}

function FilterPill({ label, value, onChange, options }) {
  const active = value !== 'all';
  return (
    <label style={{
      display: 'inline-flex', alignItems: 'center', gap: 6,
      height: 30, padding: '0 4px 0 10px',
      background: active ? 'var(--v-accent-bg)' : 'var(--v-paper-3)',
      border: `1px solid ${active ? 'var(--v-accent-line)' : 'var(--v-line)'}`,
      borderRadius: 4,
      fontSize: 11.5,
      color: active ? 'var(--v-accent-text)' : 'var(--v-text-muted)',
      cursor: 'pointer',
    }}>
      <span style={{ fontWeight: 500 }}>{label}</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        style={{
          background: 'transparent', border: 0, outline: 'none',
          fontSize: 11.5,
          fontWeight: active ? 600 : 500,
          color: 'inherit',
          cursor: 'pointer',
          padding: '0 4px',
        }}
      >
        {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    </label>
  );
}

function Th({ children, onClick, width, align, sortKey, sort }) {
  const isActive = sort && sort.key === sortKey;
  return (
    <th
      onClick={onClick}
      style={{
        textAlign: align || 'left',
        fontSize: 10.5,
        fontWeight: 600,
        color: 'var(--v-text-subtle)',
        textTransform: 'uppercase',
        letterSpacing: '0.06em',
        padding: '8px 10px',
        borderBottom: '1px solid var(--v-line-strong)',
        width,
        cursor: onClick ? 'pointer' : 'default',
        userSelect: 'none',
      }}
    >
      {children}
      {isActive && <span style={{ marginLeft: 4, color: 'var(--v-accent)' }}>{sort.dir === 'desc' ? '↓' : '↑'}</span>}
    </th>
  );
}

function Td({ children, align }) {
  return (
    <td style={{
      padding: '9px 10px',
      textAlign: align || 'left',
      verticalAlign: 'middle',
      color: 'var(--v-text)',
    }}>{children}</td>
  );
}

Object.assign(window, { V2Console });
