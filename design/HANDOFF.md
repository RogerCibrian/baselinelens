# Handoff: NACT v2 — Compliance Document + Operations Console

## Overview

NACT ("Not A Compliance Tool") v2 is an alternate-format design for an endpoint compliance dashboard. The product evaluates a Windows 11 device against the CIS Benchmark and reports posture for two distinct audiences in one app:

- **Manager / leader (Overview tab):** Wants the answer. Posture trend, score breakdown, weakest categories. Reads top-down like a report.
- **SysAdmin / SecEng (Console tab):** Wants a workbench. Filterable list of every recommendation, saved views for common queries (Open fails, In progress, Awaiting rescan…), inline status changes, remediation bundles.

The design is intentionally typeset like a working paper rather than a typical SaaS dashboard. Two visual variants are provided (Studio = warmer, more editorial; Utility = cooler, more business). The Utility variant with **Segoe UI Variable** at light-theme is the user's chosen default.

## About the Design Files

The files in this bundle are **design references created in HTML/JSX** — prototypes showing intended look and behavior, not production code to copy directly. The HTML loads React + Babel inline and reads a JSON fixture; this is for fast iteration during design, not how the product should ship.

The task is to **recreate these HTML designs in the target codebase's existing environment** (React, Vue, SwiftUI, native, etc.) using its established patterns and libraries. If no environment exists yet, choose the most appropriate framework for the project. Lift the visual design (typography, layout, spacing, color thresholds, interactions) faithfully; do not lift the rendering approach (`<script type="text/babel">`, hash-based fixture data, `useTweaks` shim).

## Fidelity

**High-fidelity (hifi).** Final colors, typography, spacing scale, and interaction behavior are all locked. Recreate pixel-perfect, swapping the layer technologies for the target codebase's stack.

## Files in this bundle

| File | Purpose |
|---|---|
| `Dashboard v2.html` | App shell. Top bar with brand/tabs/host pill, tab routing between Overview and Console, Tweaks panel, theme/variant/font tokens applied via `data-*` attributes. |
| `v2/tokens-v2.css` | Design tokens. Two themes (light, dark) × two variants (studio, utility). Color, typography, spacing, table styling. |
| `v2/Overview.jsx` | Overview tab — the "report". Headline strip + 3 level cards + 4 sections. |
| `v2/Console.jsx` | Console tab — the workbench. Saved-view rail, filter chips, recommendation table, detail drawer. |
| `v2/components-v2.jsx` | Shared components: status pills, level chips, trend chart, section headers, detail drawer, table primitives. |
| `v2/data-v2.jsx` | Data layer: enrichment over the JSON fixture (delta vs prior scan, work status, posture sentence values). Replace with real API calls in production. |
| `compliance-data.json` | Fixture data — categories, recommendations, scan history, totals. Production should fetch this from the backend. |
| `tweaks-panel.jsx` | In-design tweak panel (variant/theme/font picker). **For design exploration only — strip from production.** |

## Reference screenshots

- `screenshots/01-overview.png` — Overview tab (manager view)
- `screenshots/02-console.png` — Console tab (admin workbench)

## Screens / Views

### Top bar (shared shell)

Sits across the top of every view. 48px tall, solid `--v-paper-2` background with bottom border `--v-line`.

- **Brand block (left):** "NACT" wordmark (13px / 600 / -0.005em letter-spacing) + small "v2" subdued tag.
- **Tabs:** `Overview` and `Console`. Inset panel style: 36px-tall pill container in `--v-paper-2` with 1px border `--v-line` and 6px radius. Each tab is 28px tall, 16px horizontal padding, 4px gap between. Inactive state: `--v-text-muted` color, transparent background. Hover: `--v-paper-3` background. Active: `--v-paper` background with subtle 1px shadow `0 1px 2px rgba(0,0,0,0.04)`, `--v-text` color, 600 weight.
- **Host pill (right):** small chip showing device name (e.g., `ADMIN-WKS-042`), 4px/9px padding, 11px font, in `--v-paper-3`.
- **Last scan timestamp:** mono, 11px, `--v-text-subtle`.
- **Rescan button:** primary action style — solid `--v-text` background, `--v-paper` foreground, 28px height, 12px horizontal padding, 6px radius.
- **Icon button cluster:** theme toggle, variant toggle, settings — 28×28px ghost buttons with hover `--v-paper-2`.

### Overview tab

Centered article, max-width 880px, generous vertical rhythm. Reads as a structured report.

#### Document header
- Eyebrow: "COMPLIANCE REPORT · {date}" — 11px, uppercase, 0.12em letter-spacing, 600 weight, `--v-text-subtle`. Mono date.
- H1: "Windows 11 — CIS Benchmark" — 44px serif (`--v-font-serif`), 400 weight, 1.08 line-height, -0.02em letter-spacing.
- Meta line: device name (mono) · OS · benchmark version. 13px `--v-text-muted`.

#### Headline strip
Single short factual line at top of the score section. Generated from numbers, deterministic. Reads:
> **Posture is improving.** ↑ 2.7 pts in 30 days · 4 remediated · 2 regressed · 3 categories below 50%

Layout: flex row, baseline alignment, 14px gap, wraps. Vertical bullet separators `1px × 12px` in `--v-line-strong`.

The verb "improving" / "declining" / "stable" colored by posture trend (green/red/neutral), italic. Rest of the strip is `--v-text-muted` 13px tabular-nums.

#### Score by level (3 cards)
Three full-width cards in a `1fr 1fr 1fr` grid, 16px gap. Order: **L1, L2, BL**. Each card is 20px/22px padding, 1px `--v-line` border, 4px radius, `--v-paper` background. Hover raises border to `--v-line-strong`.

Card contents:
- Top row: level chip (left) + long name "Level 1 — Baseline" (right, 10px `--v-text-subtle`).
- Number row: two stacked label blocks side-by-side
  - **Left (In-scope):** tiny caption "IN-SCOPE" (9px, uppercase, 0.1em letter-spacing, 600 weight, 4px below the number), then the percentage in 44px serif. **The number is colored by threshold:**
    - `≥80%` → `--v-pass` (green)
    - `≥50%` → `--v-warn` (amber)
    - `<50%` → `--v-fail` (red)
    - The `%` sign is a separate span: 16px, `--v-text-subtle`, with `marginLeft: 2px` to keep digit-to-percent gap consistent across glyphs.
  - **Right (Full):** caption "FULL", same style. Number in 18px tabular sans, 500 weight, `--v-text-2` (NOT colored — only In-scope is colored).
- "{passing} of {total} in scope" — 11px tabular `--v-text-subtle`.
- 4px-tall threshold bar: width = `${pct}%`, color = same threshold logic as the In-scope number, `--v-line` background.

Click on a card → jumps to Console filtered by that level.

#### §2 — Weakest categories
Six categories with the lowest in-scope pass rates (categories with ≥3 in-scope recommendations). Two-column grid. Each row: top border, click-through to Console filtered by category.
- Category name (left, 13px, 500 weight)
- Pass count fraction (right, mono)
- Inline 70px progress bar with threshold colors
- Hover: text color shifts to `--v-text`.

#### §3 — Highest-impact failures
Up to 8 failing recommendations, sorted by `impact_score` desc.
Each row: rec ID (mono) · status pill · level chip · title · age (mono small).
Click → opens detail drawer.

#### §4 — Recently changed
Up to 12 recs whose status flipped vs prior scan. Same row layout as §3, with delta indicator (↑ improved / ↓ regressed) instead of impact.

#### Footer
Benchmark version (left) · "{X} of {Y} recommendations applicable to this profile" (right, mono).

### Console tab

Workbench layout. Three regions: saved-view rail (left, ~220px), main column (center, fluid), no right panel by default — detail drawer slides in over the right side when a row is opened.

#### Saved view rail
Vertical list of named filters. Each item: name (13px, 500 weight) + count badge + tiny description (11px `--v-text-subtle`).

Default views:
- **Open fails** — `status === 'fail'`
- **High-impact fails** — `status === 'fail' && impact_score >= 8`
- **In progress** — `work === 'in-progress'`
- **Awaiting rescan** — `work === 'awaiting-rescan'`
- **Snoozed** — `work === 'snoozed'`
- **Regressed** — `delta === 'regressed'`
- **Recently fixed** — `delta === 'improved'`
- **BitLocker only** — `level === 'BL'`

Active view shows accent left-border in `--v-accent`, `--v-paper` background.

#### Filter chip strip
Above the table. Status filter (All / Fail / Pass / Manual / N/A / Exception), level filter (All / L1 / L2 / BL), category dropdown, free-text search.

#### Recommendation table
Columns: ID (mono) · Status pill · Level chip · Title · Category · Impact (mono right-aligned) · Age · Delta indicator.
Sticky header. Zebra striping with `--v-paper-2`. Row hover `--v-paper-3`. Click → opens detail drawer.

#### Detail drawer
Slides in from right, ~520px wide, full height. Shows full recommendation: ID, title, level, status, category, description, current value, expected value, impact, age, work status (with action buttons: Mark in-progress / Awaiting rescan / Snooze / Add exception). Footer: remediation bundle (if part of one), references.

## Interactions & Behavior

- **Tab switching:** routes between Overview and Console. State preserved on switch.
- **Card click in Overview:** sets a Console filter and switches to Console tab. The filter is communicated via a `consoleFilter` state object with shape `{level?, category?, status?, ...}`.
- **Saved view click:** applies that view's filter; only one view active at a time.
- **Filter chip change:** narrows the visible recommendations live.
- **Row click:** opens detail drawer over the right.
- **Drawer close:** click backdrop, ✕ button, or Esc.
- **Theme/variant/font:** `data-v2-theme`, `data-v2-variant`, `data-v2-font` attributes on a wrapper div drive token swaps via CSS.

### Animation/transition specs
- Tab background/color: 120ms ease.
- Card border on hover: 120ms ease.
- Drawer slide-in: 200ms cubic-bezier(0.16, 1, 0.3, 1).
- Status pill hover (none — static).

### State management
- `tab`: `'overview' | 'console'`
- `detail`: `recommendation | null` (active drawer)
- `consoleFilter`: `{ level?, category?, status?, work?, delta?, search? } | null`
- `tweaks`: `{ variant, theme, font }` (design-only; remove in production)

### Data fetching
The fixture (`compliance-data.json`) is a single shape that combines:
- `device`: name, OS, last scan timestamp, benchmark version
- `score`: current % + 30-day delta
- `categories`: array of `{ id, name, total, pass, fail, manual, na, passPct }`
- `recommendations`: array of `{ id, title, description, level (BL/L1/L2), status (pass/fail/manual/not-applicable/exception), category_id, impact_score, current_value, expected_value, ... }`
- `scan_history`: array of `{ date, pass_pct, pass, fail }`
- `totals`: total recommendations applicable

In production this should be one or several backend endpoints. The `v2EnrichRec` function in `data-v2.jsx` adds synthetic `delta`, `age_days`, `work` fields per recommendation — these come from the backend in production, not from a hash function.

## Scoring methodology

Two scores are computed and shown:

- **In-scope** = `(pass + exception) / (total − manual − N/A)` — the operational score. Documented exceptions count as passing because they're accepted decisions, not unfixed bugs. Manual and N/A are excluded from the denominator.
- **Full** = `pass / total` — the audit score. Raw coverage of the entire benchmark.

The In-scope score is the headline. Full is shown as secondary for transparency / audit purposes.

The same In-scope methodology is used everywhere (per-level cards, per-category weakest ranking, headline strip). It is computed live in `v2/Overview.jsx` and `v2/data-v2.jsx`; the precomputed `passPct` field in the JSON fixture uses the strict definition and is only used as a fallback / for display where appropriate.

**Exceptions are never classified as regressed.** In `v2EnrichRec`, the delta logic treats `exception` as a "good" status alongside `pass`, and explicitly downgrades any `regressed` delta on an exception to `unchanged`.

## Design Tokens

All tokens are defined in `v2/tokens-v2.css`. The light theme (`data-v2-theme="light"`) is the default.

### Light theme — Utility variant (chosen default)

```
--v-bg:               #fbfbfd
--v-paper:            #ffffff
--v-paper-2:          #f7f7fa
--v-paper-3:          #f0f0f3

--v-text:             #14141c
--v-text-2:           #2d2d3a
--v-text-muted:       #565669
--v-text-subtle:      #8a8a9a

--v-line:             rgba(20, 20, 28, 0.09)
--v-line-strong:      rgba(20, 20, 28, 0.16)
--v-line-soft:        rgba(20, 20, 28, 0.05)

--v-accent:           #4a5fc1
--v-pass:             #2d7a4f
--v-warn:             #b87a1e
--v-fail:             #b8302d
```

The Studio variant uses warmer paper tones and a slightly different accent — see tokens-v2.css for exact values.

### Typography

- **Sans (UI):** Segoe UI Variable, fallback Segoe UI, then system-ui. Available alternatives wired via `data-v2-font`: Inter, IBM Plex Sans, Manrope, Public Sans, Geist, SF Pro stack, plain system. **Default: Segoe UI Variable.**
- **Serif (display + report-feel callouts):** Source Serif 4, fallback Georgia. Used for H1, level percentages, the headline strip's main verb, executive paragraph (where present).
- **Mono (data, IDs, dates):** ui-monospace, JetBrains Mono fallback.

Type scale (in use):
- H1 — 44px / 400 / 1.08 line-height / -0.02em letter-spacing — serif
- Level percentage — 44px / 400 / 1 / -0.02em — serif, threshold-colored
- Headline verb — 24px / 400 / -0.012em — serif italic, trend-colored
- Section eyebrow — 11px / 600 / 0.12em letter-spacing / uppercase
- Card caption — 9–10px / 600 / 0.1em letter-spacing / uppercase / `--v-text-subtle`
- Body — 14px / 400 / 1.55 line-height / `--v-text`
- Body small — 13px / 400 / 1.5 / `--v-text-muted`
- Mono — 12–13px / 500 / `--v-text` (lining tabular nums via `font-feature-settings: "tnum"`)

### Spacing

8/12/16/20/24/32/40/48/64 px scale. Section bottom margin = 48px. Section header → first child = 16px. Card internal = 20/22px.

### Border radius

- Pills/chips: 999px (full)
- Tabs/cards: 4–6px
- Buttons: 6px
- Bars: 2px

### Shadows

- Active tab: `0 1px 2px rgba(0,0,0,0.04)`
- Drawer: `-8px 0 32px rgba(0,0,0,0.08)` (light theme)
- No other shadows used — borders carry separation.

## Assets

No images, photography, or illustrations. The design is fully typographic + tokenized colors + small SVG (trend chart line, threshold bars).

Icons are inline SVG strokes drawn at 16×16 with `currentColor`. Used sparingly: the rescan ↻ glyph, drawer ✕, sort triangles, delta arrows. Should be replaced with whatever icon library the target codebase uses (Lucide, Phosphor, etc.) at matching weights.

## Open items / production notes

1. **Strip the Tweaks panel** — `tweaks-panel.jsx` and the `useTweaks` hook in the shell are design-tooling only. The shipped product should commit to one variant + one theme + one font. The user's settled defaults are: `variant=utility`, `theme=light`, `font=Segoe UI Variable`.
2. **Replace the data layer** — `v2EnrichRec` synthesizes `delta`, `age_days`, and `work` from a hash. In production these come from the backend (you'll need scan history per recommendation, exception records, and a work-status table).
3. **Saved views** — currently hardcoded constants. Production should let users create/save/share custom views.
4. **Remediation bundles** — the placeholder `v2BuildBundles` function emits stub bundles when ≥3 fails share a category. Real bundles should come from OpenBaseline or similar.
5. **Tokens-v2.css can be lifted as-is** if the target environment supports CSS custom properties (most do). Otherwise port the values into the framework's token system.

## Acknowledgements

This was the second design iteration. The first (`Not A Compliance Tool.html`, not bundled here) used an Apple/SF Pro system aesthetic with weighted scoring and a single overview pane. v2 was an explicit alternate format: more editorial, two-audience, unweighted scoring with the In-scope/Full distinction, and the dedicated Console for admins.
