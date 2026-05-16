import { useLayoutEffect, useRef, useState, type CSSProperties } from "react";

/**
 * Generic segmented control with a sliding-pill indicator. Buttons size
 * to their content plus consistent padding so the visible spacing
 * between labels is uniform regardless of word length; the pill
 * measures the active button and animates both width and position to
 * match. Backs the settings popover's theme and time-format controls.
 */
export default function SettingSegment<T extends string>({
  options,
  labels,
  value,
  ariaLabel,
  onChange,
}: {
  options: readonly T[];
  labels: Record<T, string>;
  value: T;
  ariaLabel: string;
  onChange: (next: T) => void;
}) {
  const buttonRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const [pillStyle, setPillStyle] = useState<CSSProperties>({});

  // Recompute pill geometry after every value change. useLayoutEffect
  // runs synchronously after DOM mutation but before paint, so the pill
  // is in the right place on first render — no flash from an unstyled
  // initial position.
  useLayoutEffect(() => {
    const button = buttonRefs.current[options.indexOf(value)];
    if (!button) return;
    setPillStyle({
      width: button.offsetWidth,
      transform: `translateX(${button.offsetLeft}px)`,
    });
  }, [value, options]);

  return (
    <div className="settings-segment" role="radiogroup" aria-label={ariaLabel}>
      <span
        className="settings-segment-pill"
        style={pillStyle}
        aria-hidden="true"
      />
      {options.map((option, i) => (
        <button
          key={option}
          ref={(el) => {
            buttonRefs.current[i] = el;
          }}
          type="button"
          role="radio"
          aria-checked={value === option}
          className="settings-segment-option"
          onClick={() => onChange(option)}
        >
          {labels[option]}
        </button>
      ))}
    </div>
  );
}
