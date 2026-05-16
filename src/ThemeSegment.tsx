import type { Theme } from "./bindings";
import SettingSegment from "./SettingSegment";

const OPTIONS = ["system", "light", "dark"] as const;
const LABELS: Record<Theme, string> = {
  system: "System",
  light: "Light",
  dark: "Dark",
};

/**
 * System / Light / Dark segmented control. Used both inside the
 * dashboard's settings popover and inline on the onboarding top bar.
 */
export default function ThemeSegment({
  theme,
  onThemeChange,
}: {
  theme: Theme;
  onThemeChange: (next: Theme) => void;
}) {
  return (
    <SettingSegment
      options={OPTIONS}
      labels={LABELS}
      value={theme}
      ariaLabel="Theme"
      onChange={onThemeChange}
    />
  );
}
