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
  search: string;
};

export const defaultConsoleFilter: ConsoleFilter = {
  level: "all",
  status: "all",
  category: null,
  search: "",
};
