/**
 * Visibility flags for the Console table's toggleable columns. ID and
 * Status are always-on (locked from the menu) because they're the
 * navigation + triage anchors; everything else is user-controlled.
 * Defaults preserve the prior always-visible set and keep Expected /
 * Found off so narrow windows aren't crowded out of the gate.
 */
export type ConsoleColumns = {
  level: boolean;
  title: boolean;
  category: boolean;
  expected: boolean;
  found: boolean;
};

export const defaultConsoleColumns: ConsoleColumns = {
  level: true,
  title: true,
  category: true,
  expected: false,
  found: false,
};
