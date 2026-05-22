import type { Baseline } from "../../bindings";

/**
 * Renders the small "{number} {local name}" context line beneath the
 * drawer's title. Falls back to the bare number when the parser
 * couldn't extract a heading for that section.
 */
export function DrawerCategoryMeta({
  baseline,
  number,
}: {
  baseline: Baseline;
  number: string;
}) {
  const cat = baseline.categories.find((c) => c.number === number);
  // `cat.name` is the parser's full hierarchical path joined with " - ";
  // the leaf segment is the local section heading.
  const localName = cat?.name ? (cat.name.split(" - ").pop() ?? null) : null;
  return (
    <p className="drawer-meta">
      <span className="mono drawer-meta-num">{number}</span>
      {localName && <span className="drawer-meta-name">{localName}</span>}
    </p>
  );
}
