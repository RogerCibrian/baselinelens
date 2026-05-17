import type { Level } from "../bindings";
import type { EffectiveStatus } from "./score";

export type ConsoleFilter = {
  level: "all" | Level;
  status: "all" | EffectiveStatus;
  /** Category number to filter to as a prefix, or `null` for no
   * category filter. A value of `"1"` matches both `"1"` and every
   * sub-section (`"1.2"`, `"1.2.3"`, …) so the Console rail can pick a
   * whole top-level group with one click. Overview click-throughs from
   * the weakest-categories list set this to a leaf number, which still
   * matches as an exact prefix of itself. */
  category: string | null;
  /** Restricts to recs whose latest change-event places them in the
   * named delta bucket against the live scan. `"unchanged"` is omitted
   * deliberately — the saved views surface only the two flip
   * directions, since a no-flip view would just be "everything that
   * didn't move", which the All view already covers. */
  delta: "all" | "improved" | "regressed";
  /** Restricts to BitLocker-tagged recs when `"only"`. Keyed on the
   * rec's `bitlocker` tag, which is independent of `level`. */
  bitlocker: "all" | "only";
  search: string;
};

export const defaultConsoleFilter: ConsoleFilter = {
  level: "all",
  status: "all",
  category: null,
  delta: "all",
  bitlocker: "all",
  search: "",
};
