import { createContext, useContext, type ReactNode } from "react";

import type { Density, Theme, TimeFormat } from "../bindings";

/**
 * The active display preferences plus the setters that change and
 * persist them. App owns the underlying state and the persistence; this
 * context only delivers it to the screens that read it, so the values
 * don't have to thread through Dashboard as props.
 */
export type PreferencesContextValue = {
  theme: Theme;
  timeFormat: TimeFormat;
  density: Density;
  setTheme: (next: Theme) => void;
  setTimeFormat: (next: TimeFormat) => void;
  setDensity: (next: Density) => void;
};

const PreferencesContext = createContext<PreferencesContextValue | null>(null);

export function PreferencesProvider({
  value,
  children,
}: {
  value: PreferencesContextValue;
  children: ReactNode;
}) {
  return (
    <PreferencesContext.Provider value={value}>
      {children}
    </PreferencesContext.Provider>
  );
}

/**
 * Reads the active display preferences. Throws when called outside a
 * `PreferencesProvider` so a missing provider fails loudly instead of
 * handing back a silent null.
 */
export function usePreferences(): PreferencesContextValue {
  const value = useContext(PreferencesContext);
  if (value === null) {
    throw new Error("usePreferences must be used within a PreferencesProvider");
  }
  return value;
}
