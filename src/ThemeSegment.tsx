import { useLayoutEffect, useRef, useState, type CSSProperties } from "react";

import type { Theme } from "./bindings";

const OPTIONS = ["system", "light", "dark"] as const;
const LABELS: Record<Theme, string> = {
  system: "System",
  light: "Light",
  dark: "Dark",
};

/**
 * Three-way System / Light / Dark segmented control with a sliding-pill
 * indicator. Buttons size to their content + consistent padding so the
 * visible spacing between labels is uniform regardless of word length;
 * the pill measures the active button and animates both width and
 * position to match. Used both inside the dashboard's settings popover
 * and inline on the onboarding top bar.
 */
export default function ThemeSegment({
  theme,
  onThemeChange,
}: {
  theme: Theme;
  onThemeChange: (next: Theme) => void;
}) {
  const buttonRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const [pillStyle, setPillStyle] = useState<CSSProperties>({});

  // Recompute pill geometry after every theme change. useLayoutEffect
  // runs synchronously after DOM mutation but before paint, so the pill
  // is in the right place on first render — no flash from an unstyled
  // initial position.
  useLayoutEffect(() => {
    const button = buttonRefs.current[OPTIONS.indexOf(theme)];
    if (!button) return;
    setPillStyle({
      width: button.offsetWidth,
      transform: `translateX(${button.offsetLeft}px)`,
    });
  }, [theme]);

  return (
    <div className="settings-segment" role="radiogroup" aria-label="Theme">
      <span
        className="settings-segment-pill"
        style={pillStyle}
        aria-hidden="true"
      />
      {OPTIONS.map((option, i) => (
        <button
          key={option}
          ref={(el) => {
            buttonRefs.current[i] = el;
          }}
          type="button"
          role="radio"
          aria-checked={theme === option}
          className="settings-segment-option"
          onClick={() => onThemeChange(option)}
        >
          {LABELS[option]}
        </button>
      ))}
    </div>
  );
}
