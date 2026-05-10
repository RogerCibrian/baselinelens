import type { Level } from "../bindings";
import type { EffectiveStatus } from "./score";

export type ConsoleFilter = {
  level: "all" | Level;
  status: "all" | EffectiveStatus;
  /** Category number to filter to, or `null` for no category filter. Set
   * via Overview click-throughs (level cards / weakest-categories rows). */
  category: string | null;
  search: string;
};

export const defaultConsoleFilter: ConsoleFilter = {
  level: "all",
  status: "all",
  category: null,
  search: "",
};
