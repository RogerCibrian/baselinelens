import { useEffect, useRef, type RefObject } from "react";

const FOCUSABLE =
  'a[href], button:not(:disabled), textarea:not(:disabled), input:not(:disabled), select:not(:disabled), [tabindex]:not([tabindex="-1"])';

/**
 * Confines Tab focus to `containerRef` while `active`, and restores
 * focus to whatever was focused before activation once it goes false.
 * Modal surfaces (drawer, confirm dialogs) set `aria-modal` but the DOM
 * behind them is still in the tab order without this — keyboard users
 * would tab straight out of the dialog and lose their place.
 *
 * Initial focus is left to the caller (the close button, a primary
 * action, etc.); the hook only moves focus in if nothing inside the
 * container holds it yet, so an explicit `autoFocus`/`ref.focus()`
 * still wins.
 */
export function useFocusTrap(
  active: boolean,
  containerRef: RefObject<HTMLElement | null>,
) {
  const restoreRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!active) return;
    const container = containerRef.current;
    if (!container) return;

    restoreRef.current = document.activeElement as HTMLElement | null;

    if (!container.contains(document.activeElement)) {
      const first = container.querySelector<HTMLElement>(FOCUSABLE);
      (first ?? container).focus();
    }

    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== "Tab") return;
      const focusable = Array.from(
        container!.querySelectorAll<HTMLElement>(FOCUSABLE),
      ).filter((el) => el.offsetParent !== null || el === document.activeElement);
      if (focusable.length === 0) {
        event.preventDefault();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const activeEl = document.activeElement as HTMLElement | null;
      if (event.shiftKey && activeEl === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && activeEl === last) {
        event.preventDefault();
        first.focus();
      }
    }

    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("keydown", onKeyDown, true);
      const restore = restoreRef.current;
      // Only pull focus back if it's still inside the container we're
      // tearing down — if something else already moved it, respect that.
      if (restore && container.contains(document.activeElement)) {
        restore.focus();
      }
    };
  }, [active, containerRef]);
}
