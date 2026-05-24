import { memo, useState, type PointerEvent, type ReactNode } from "react";

import type {
  ChangeEvent,
  Recommendation,
  Scan,
  UserState,
} from "../bindings";
import { computeDelta } from "../data/changes";
import { type ConsoleColumns } from "../data/consoleColumns";
import { type Sort } from "../data/consoleModel";
import { effectiveStatus } from "../data/score";
import { LevelChip } from "../ui";
import { DeltaCell, SortHeader, StatusPill } from "./widgets";

type ColumnKey =
  | "id"
  | "status"
  | "level"
  | "title"
  | "category"
  | "expected"
  | "found";

// Starting widths (px) before any user drag. Title is the widest since it
// holds the recommendation text; the fixed delta indicator is sized in CSS.
const DEFAULT_WIDTHS: Record<ColumnKey, number> = {
  id: 80,
  status: 104,
  level: 120,
  title: 520,
  category: 160,
  expected: 220,
  found: 220,
};

const MIN_COLUMN_WIDTH = 64;
const DELTA_WIDTH = 32;

/**
 * The visible columns in render order. ID and Status are always shown; the
 * rest follow their visibility flags. Mirrors the cell order in RecRow and
 * the header order below, so the colgroup tracks line up with the cells.
 */
function visibleColumnKeys(columns: ConsoleColumns): ColumnKey[] {
  const keys: ColumnKey[] = ["id", "status"];
  if (columns.level) keys.push("level");
  if (columns.title) keys.push("title");
  if (columns.category) keys.push("category");
  if (columns.expected) keys.push("expected");
  if (columns.found) keys.push("found");
  return keys;
}

/**
 * Shows the Expected / Found string from a scan result, or an em-dash
 * when there isn't one. Registry recs that check several value names
 * have no single string here — the drawer's check table shows those.
 */
function valueCell(
  value: string | null | undefined,
  checksLen: number | undefined,
): ReactNode {
  if (value && value.trim().length > 0) return value;
  // Recs that check several value names have no single value to show;
  // their detail lives in the drawer's check table. Show the count so
  // the rows carrying the most data don't read as empty.
  if (checksLen && checksLen > 0) {
    return (
      <span className="muted-italic">
        {checksLen} check{checksLen === 1 ? "" : "s"}
      </span>
    );
  }
  return "—";
}

/**
 * One table row for a recommendation. Memoized so clicking a row
 * re-renders only the rows whose highlight changes, not every row in a
 * table that can run to several hundred.
 */
const RecRow = memo(function RecRow({
  rec,
  scan,
  changesIndex,
  userState,
  columns,
  categoryNames,
  selected,
  onOpen,
}: {
  rec: Recommendation;
  scan: Scan;
  changesIndex: Map<string, ChangeEvent>;
  userState: UserState;
  columns: ConsoleColumns;
  categoryNames: Map<string, string>;
  selected: boolean;
  onOpen: (recId: string) => void;
}) {
  const status = effectiveStatus(rec, scan, userState);
  const delta = computeDelta(rec, changesIndex, scan, userState);
  const result = scan.results[rec.id];
  const attested =
    result?.status === "Manual" &&
    userState.attestations?.[rec.id] !== undefined;
  const categoryLabel =
    categoryNames.get(rec.categoryNumber) ?? rec.categoryNumber;
  return (
    <tr
      data-rec-id={rec.id}
      role="button"
      tabIndex={0}
      onClick={() => onOpen(rec.id)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onOpen(rec.id);
        }
      }}
      className={selected ? "rec-row-selected" : ""}
      aria-selected={selected}
      aria-label={`${rec.id} ${rec.title} — open details`}
    >
      <td className="mono">{rec.id}</td>
      <td>
        <StatusPill status={status} attested={attested} />
      </td>
      {columns.level && (
        <td>
          <span className="level-cell">
            <LevelChip level={rec.level} />
            {rec.bitlocker && rec.level !== "BL" && (
              <span className="tag-bitlocker">BitLocker</span>
            )}
          </span>
        </td>
      )}
      {columns.title && <td>{rec.title}</td>}
      {columns.category && (
        <td className="muted" title={rec.categoryNumber}>
          {categoryLabel}
        </td>
      )}
      {columns.expected && (
        <td
          className="muted mono rec-table-value-col"
          title={result?.expected ?? undefined}
        >
          {valueCell(result?.expected, result?.checks?.length)}
        </td>
      )}
      {columns.found && (
        <td
          className="muted mono rec-table-value-col"
          title={result?.currentValue ?? undefined}
        >
          {valueCell(result?.currentValue, result?.checks?.length)}
        </td>
      )}
      <td className="rec-table-delta-col">
        <DeltaCell delta={delta} />
      </td>
    </tr>
  );
});

export function RecTable({
  recs,
  scan,
  changesIndex,
  userState,
  sort,
  onSortChange,
  columns,
  columnWidths,
  onColumnWidthsChange,
  categoryNames,
  selectedRecId,
  onOpen,
}: {
  recs: Recommendation[];
  scan: Scan;
  changesIndex: Map<string, ChangeEvent>;
  userState: UserState;
  sort: Sort;
  onSortChange: (next: Sort) => void;
  columns: ConsoleColumns;
  /** Session-only pixel widths keyed by column id; a missing key falls
   * back to the column's default. Owned by Dashboard so a drag survives
   * switching tabs. */
  columnWidths: Record<string, number>;
  onColumnWidthsChange: (next: Record<string, number>) => void;
  /** Lookup from category number to its display name; used by the
   * Category cell so the user sees "Account Policies" instead of
   * "1.1.2". The number is preserved as a tooltip for reference. */
  categoryNames: Map<string, string>;
  selectedRecId: string | null;
  onOpen: (recId: string) => void;
}) {
  // The column being dragged, if any. Kept local so a drag re-renders only
  // this table (the memoized rows skip it); the width commits up to
  // Dashboard on pointer-up.
  const [drag, setDrag] = useState<{
    key: ColumnKey;
    startX: number;
    startWidth: number;
    width: number;
  } | null>(null);

  const widthFor = (key: ColumnKey): number =>
    drag?.key === key ? drag.width : (columnWidths[key] ?? DEFAULT_WIDTHS[key]);

  function startResize(key: ColumnKey, e: PointerEvent<HTMLSpanElement>) {
    e.preventDefault();
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    // Measure the column's rendered width so the drag begins from what's on
    // screen. The columns are scaled up to fill the panel, so a stored
    // width can be narrower than what's shown; starting from the rendered
    // width keeps the handle from jumping on grab.
    const th = e.currentTarget.parentElement;
    const width = th
      ? Math.round(th.getBoundingClientRect().width)
      : widthFor(key);
    setDrag({ key, startX: e.clientX, startWidth: width, width });
  }

  function moveResize(e: PointerEvent<HTMLSpanElement>) {
    setDrag((d) =>
      d === null
        ? null
        : {
            ...d,
            width: Math.max(
              MIN_COLUMN_WIDTH,
              d.startWidth + (e.clientX - d.startX),
            ),
          },
    );
  }

  function endResize(e: PointerEvent<HTMLSpanElement>) {
    if (drag) onColumnWidthsChange({ ...columnWidths, [drag.key]: drag.width });
    setDrag(null);
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
  }

  const resizer = (key: ColumnKey, label: string) => (
    <span
      className="col-resizer"
      role="separator"
      aria-orientation="vertical"
      aria-label={`Resize ${label} column`}
      onPointerDown={(e) => startResize(key, e)}
      onPointerMove={moveResize}
      onPointerUp={endResize}
    />
  );

  const visibleKeys = visibleColumnKeys(columns);

  return (
    <div className="rec-table-scroll">
      <table className={`rec-table${drag ? " rec-table-resizing" : ""}`}>
        <colgroup>
          {visibleKeys.map((k) => (
            <col key={k} style={{ width: widthFor(k) }} />
          ))}
          <col style={{ width: DELTA_WIDTH }} />
        </colgroup>
        <thead>
          <tr>
            <th>
              <SortHeader sort={sort} onChange={onSortChange} keyName="id">ID</SortHeader>
              {resizer("id", "ID")}
            </th>
            <th>
              <SortHeader sort={sort} onChange={onSortChange} keyName="status">Status</SortHeader>
              {resizer("status", "Status")}
            </th>
            {columns.level && (
              <th>
                <SortHeader sort={sort} onChange={onSortChange} keyName="level">Level</SortHeader>
                {resizer("level", "Level")}
              </th>
            )}
            {columns.title && (
              <th>
                <SortHeader sort={sort} onChange={onSortChange} keyName="title">Title</SortHeader>
                {resizer("title", "Title")}
              </th>
            )}
            {columns.category && (
              <th>
                <SortHeader sort={sort} onChange={onSortChange} keyName="category">Category</SortHeader>
                {resizer("category", "Category")}
              </th>
            )}
            {columns.expected && (
              <th>Expected{resizer("expected", "Expected")}</th>
            )}
            {columns.found && <th>Found{resizer("found", "Found")}</th>}
            <th
              className="rec-table-delta-col"
              title="Recent status change"
            >
              <span aria-hidden="true">Δ</span>
              <span className="sr-only">Recent status change</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {recs.map((rec) => (
            <RecRow
              key={rec.id}
              rec={rec}
              scan={scan}
              changesIndex={changesIndex}
              userState={userState}
              columns={columns}
              categoryNames={categoryNames}
              selected={rec.id === selectedRecId}
              onOpen={onOpen}
            />
          ))}
        </tbody>
      </table>
    </div>
  );
}
