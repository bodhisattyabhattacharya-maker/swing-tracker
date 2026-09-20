"use client";

/**
 * The colour-theme control. Three states, not two.
 *
 * ---------------------------------------------------------------------------
 * WHY THREE
 *
 * A two-position switch can only say "light" or "dark", and neither of those is what a first visit
 * is. Until today this page had exactly one behaviour — follow `prefers-color-scheme` — and that
 * behaviour is the right default, so it has to survive as a position on the control rather than be
 * destroyed the first time someone touches it. The cycle is system → light → dark → system.
 *
 * ---------------------------------------------------------------------------
 * THE STATE LIVES ON THE DOCUMENT, NOT IN REACT, AND THAT IS THE WHOLE DESIGN
 *
 * The chosen mode is written to two attributes on the root element by a script in `app/layout.tsx`
 * that runs BEFORE first paint:
 *
 *   data-theme   "light" | "dark", or absent — what the stylesheet's token blocks key off.
 *   data-mode    "system" | "light" | "dark" — which position the control is in.
 *
 * Two consequences, both deliberate:
 *
 *   1. NO FLASH. If the attribute were set from an effect, a viewer who chose dark would get one
 *      painted frame of the light palette on every navigation. The pre-paint script is the only
 *      place that can be fixed.
 *
 *   2. NO HYDRATION MISMATCH. This button renders no state text of its own. Its icon and label are
 *      CSS `content` keyed on `data-mode` (see .themebtn in app/layout.tsx), so the server and the
 *      client render byte-identical markup and the browser paints the right label from the
 *      attribute the script already set. A version that read localStorage into `useState` would
 *      render "SYSTEM" on the server, correct itself one frame later, and log a mismatch warning.
 *
 * So this component is a click handler and nothing else. It does not need to know the palette, and
 * `lib/chart-theme.ts` does not need to know this file exists — its MutationObserver on data-theme
 * is what repaints every canvas.
 */

import { useCallback } from "react";

/** The cycle, in order. Also the set of values `data-mode` is allowed to hold. */
export const MODES = ["system", "light", "dark"] as const;
export type Mode = (typeof MODES)[number];

/** Shared with the pre-paint script in app/layout.tsx. Changing it here changes it nowhere else. */
export const THEME_KEY = "swing-theme";

export function nextMode(m: Mode): Mode {
  return MODES[(MODES.indexOf(m) + 1) % MODES.length];
}

/**
 * Write a mode to the document and to storage.
 *
 * Exported because the pre-paint script applies the same mapping; keeping one function means the
 * two cannot drift into disagreeing about what "system" does to `data-theme`.
 */
export function applyMode(m: Mode): void {
  const el = document.documentElement;
  el.setAttribute("data-mode", m);
  // System means NO data-theme, so the media query in the stylesheet decides. Setting it to a value
  // would pin the palette and silently break the OS following that the default promises.
  if (m === "system") el.removeAttribute("data-theme");
  else el.setAttribute("data-theme", m);
  // Private mode and blocked site data both throw here rather than returning null, and neither is a
  // reason to leave the viewer unable to change theme for this page view.
  try {
    localStorage.setItem(THEME_KEY, m);
  } catch {
    /* the choice lasts this page view only */
  }
}

export default function ThemeToggle() {
  const onClick = useCallback(() => {
    const raw = document.documentElement.getAttribute("data-mode");
    const current = (MODES as readonly string[]).includes(raw ?? "") ? (raw as Mode) : "system";
    applyMode(nextMode(current));
  }, []);

  return (
    <button
      type="button"
      className="themebtn"
      onClick={onClick}
      // The visible text comes from CSS content keyed on data-mode, which a screen reader reading
      // the button's contents does announce — but the label says what the control IS, because
      // "SYSTEM" on its own is not a description of anything.
      aria-label="Colour theme: system, light or dark"
      title="Colour theme"
    >
      <span className="ti" aria-hidden="true" />
      <span className="tl" />
    </button>
  );
}
