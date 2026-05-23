import { memo, type ReactNode } from "react";

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
  /** Lookup from category number to its display name; used by the
   * Category cell so the user sees "Account Policies" instead of
   * "1.1.2". The number is preserved as a tooltip for reference. */
  categoryNames: Map<string, string>;
  selectedRecId: string | null;
  onOpen: (recId: string) => void;
}) {
  return (
    <table className="rec-table">
      <thead>
        <tr>
          <th><SortHeader sort={sort} onChange={onSortChange} keyName="id">ID</SortHeader></th>
          <th><SortHeader sort={sort} onChange={onSortChange} keyName="status">Status</SortHeader></th>
          {columns.level && (
            <th><SortHeader sort={sort} onChange={onSortChange} keyName="level">Level</SortHeader></th>
          )}
          {columns.title && (
            <th><SortHeader sort={sort} onChange={onSortChange} keyName="title">Title</SortHeader></th>
          )}
          {columns.category && (
            <th><SortHeader sort={sort} onChange={onSortChange} keyName="category">Category</SortHeader></th>
          )}
          {columns.expected && <th>Expected</th>}
          {columns.found && <th>Found</th>}
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
  );
}
