import { formatClock, formatDateShort } from "../format";

import type { TrendPoint } from "./util";

/**
 * SVG line chart of pass-rate over the last N scans. Renders the line
 * with an area fill below it, dots at each scan point, and Y-axis
 * percentage ticks. Range is derived from the data with a small pad
 * so the line never touches the chart edges.
 */
export function TrendChart({ points }: { points: TrendPoint[] }) {
  const width = 720;
  const height = 200;
  const padL = 40;
  const padR = 12;
  const padT = 12;
  const padB = 24;
  const innerW = width - padL - padR;
  const innerH = height - padT - padB;

  const values = points.map((p) => p.passPct * 100);
  const rawMin = Math.min(...values);
  const rawMax = Math.max(...values);
  const padPct = Math.max(2, (rawMax - rawMin) * 0.15);
  const yMin = Math.max(0, rawMin - padPct);
  const yMax = Math.min(100, rawMax + padPct);
  const yRange = Math.max(1, yMax - yMin);

  const x = (i: number) =>
    points.length === 1
      ? padL + innerW / 2
      : padL + (i / (points.length - 1)) * innerW;
  const y = (v: number) => padT + innerH - ((v - yMin) / yRange) * innerH;

  const linePath = values
    .map((v, i) => `${i === 0 ? "M" : "L"} ${x(i).toFixed(1)} ${y(v).toFixed(1)}`)
    .join(" ");
  const areaPath =
    linePath +
    ` L ${x(points.length - 1).toFixed(1)} ${(padT + innerH).toFixed(1)}` +
    ` L ${x(0).toFixed(1)} ${(padT + innerH).toFixed(1)} Z`;

  const ticks = 4;
  const yTicks = Array.from({ length: ticks + 1 }, (_, i) => yMin + (yRange * i) / ticks);

  // Calendar-day key per point. A point whose day appears more than
  // once among the visible points gets its time appended so same-day
  // scans are distinguishable; lone-day points stay just the date.
  const dayKeys = points.map((p) => {
    const date = new Date(p.startedAt);
    return Number.isNaN(date.getTime())
      ? p.startedAt
      : `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
  });
  const dayCounts = new Map<string, number>();
  for (const key of dayKeys) {
    dayCounts.set(key, (dayCounts.get(key) ?? 0) + 1);
  }
  const labels = points.map((p, i) =>
    (dayCounts.get(dayKeys[i]) ?? 0) > 1
      ? `${formatDateShort(p.startedAt)} ${formatClock(p.startedAt)}`
      : formatDateShort(p.startedAt),
  );
  // Thin labels when they'd collide: roughly 6px per char in the small
  // mono axis font plus breathing room, against the per-point spacing.
  // First and last always render so the range stays readable.
  const maxLabelLen = labels.reduce((max, s) => Math.max(max, s.length), 0);
  const minSpacing = maxLabelLen * 6 + 10;
  const spacing =
    points.length > 1 ? innerW / (points.length - 1) : innerW;
  const labelStep = Math.max(1, Math.ceil(minSpacing / spacing));
  const showLabel = (i: number) =>
    i === 0 || i === points.length - 1 || i % labelStep === 0;

  return (
    <svg
      className="trend-chart"
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      role="img"
      aria-label={`In-scope pass rate, ${points.length} points`}
    >
      <defs>
        <linearGradient id="trend-grad" x1="0" x2="0" y1="0" y2="1">
          <stop offset="0%" stopColor="var(--v-pass)" stopOpacity="0.18" />
          <stop offset="100%" stopColor="var(--v-pass)" stopOpacity="0" />
        </linearGradient>
      </defs>

      {yTicks.map((t, i) => (
        <g key={i}>
          <line
            x1={padL}
            x2={padL + innerW}
            y1={y(t)}
            y2={y(t)}
            stroke="var(--v-line)"
            strokeDasharray={i === 0 ? "0" : "2 4"}
          />
          <text
            x={padL - 6}
            y={y(t)}
            dy={3}
            className="trend-chart-axis mono"
            textAnchor="end"
          >
            {t.toFixed(0)}%
          </text>
        </g>
      ))}

      <path d={areaPath} fill="url(#trend-grad)" />
      <path
        d={linePath}
        stroke="var(--v-pass)"
        strokeWidth={1.75}
        fill="none"
        strokeLinecap="round"
        strokeLinejoin="round"
      />

      {points.map((p, i) => (
        <g key={p.startedAt}>
          {/* Wide transparent hit target so the per-point tooltip is
              reachable without pixel-hunting the 3px dot. */}
          <circle cx={x(i)} cy={y(values[i])} r={12} fill="transparent">
            <title>
              {p.scans.length > 1
                ? `${values[i].toFixed(1)}% in scope · ${p.scans.length} scans, ${formatDateShort(p.scans[0])} ${formatClock(p.scans[0])} – ${formatDateShort(p.startedAt)} ${formatClock(p.startedAt)}`
                : `${formatDateShort(p.startedAt)} ${formatClock(p.startedAt)} — ${values[i].toFixed(1)}% in scope`}
            </title>
          </circle>
          <circle
            cx={x(i)}
            cy={y(values[i])}
            r={3}
            fill="var(--v-paper)"
            stroke="var(--v-pass)"
            strokeWidth={1.5}
            pointerEvents="none"
          />
          {showLabel(i) && (
            <text
              x={x(i)}
              y={padT + innerH + 14}
              className="trend-chart-axis mono"
              textAnchor={
                i === 0
                  ? "start"
                  : i === points.length - 1
                    ? "end"
                    : "middle"
              }
            >
              {labels[i]}
            </text>
          )}
        </g>
      ))}
    </svg>
  );
}
