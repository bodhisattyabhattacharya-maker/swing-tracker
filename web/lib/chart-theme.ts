/**
 * chart-theme.ts — the bridge between the stylesheet's design tokens and the charting library.
 *
 * PURE. No fetch, no env var, no secret. Client components import this, so it must stay that way;
 * `scripts/ci/check_web_boundary.sh` fails the build otherwise.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS FILE EXISTS AT ALL
 *
 * Lightweight Charts is canvas. It cannot read a CSS custom property, so every colour it draws has
 * to be handed to it as a literal string. The obvious move is to type the hex codes into the chart
 * options — and that creates a second palette, which is how a chart ends up ochre while the cell
 * beside it means the same thing in a different ochre. Worse, it silently breaks the moment the
 * page is in dark mode, because the literal does not change.
 *
 * So the colours are READ FROM THE PAGE at runtime: one probe of `getComputedStyle` on the root
 * element gives whatever the cascade actually resolved, in whichever mode is active. There is one
 * palette, in `app/layout.tsx`, and the charts are downstream of it.
 *
 * ---------------------------------------------------------------------------
 * NO THEME TOGGLE, AND THAT IS DELIBERATE (Bodhi, 2026-09-18)
 *
 * There is no switch in the UI; the page follows `prefers-color-scheme` and the toggle is a v2
 * item. That decision is the reason this file subscribes to the media query rather than reading
 * once: a viewer whose OS flips to dark mid-session gets charts that flip with it, and when the
 * toggle does arrive it changes `data-theme` on the root, which this same probe picks up. Nothing
 * here needs to know which mechanism moved the tokens.
 */

/** Every colour a chart in this app is allowed to use. Names mirror the CSS tokens exactly. */
export interface ChartTheme {
  ink: string;
  inkSoft: string;
  inkFaint: string;
  rule: string;
  ruleSoft: string;
  surface: string;
  paper: string;
  accent: string;
  below: string;
  belowBg: string;
  above: string;
  aboveBg: string;
  warn: string;
  /** True when the resolved palette is the dark one. Used for nothing but sanity assertions. */
  dark: boolean;
}

/**
 * The tokens this file needs, mapped to their CSS custom-property names.
 *
 * Spelled out rather than derived, because a typo in a custom-property name does not throw — it
 * resolves to the empty string, and an empty string handed to the charting library draws nothing
 * at all. `readTheme` treats a missing token as a hard error for exactly that reason.
 */
const TOKENS: Record<keyof Omit<ChartTheme, "dark">, string> = {
  ink: "--ink",
  inkSoft: "--ink-soft",
  inkFaint: "--ink-faint",
  rule: "--rule",
  ruleSoft: "--rule-soft",
  surface: "--surface",
  paper: "--paper",
  accent: "--accent",
  below: "--below",
  belowBg: "--below-bg",
  above: "--above",
  aboveBg: "--above-bg",
  warn: "--warn",
};

/**
 * The palette to fall back on when the page's own tokens cannot be read.
 *
 * This is the LIGHT palette, copied from `app/layout.tsx`. It exists for one narrow case: the first
 * render on the server, where there is no `document` to probe. It is not a second source of truth
 * and must never be the palette a viewer actually sees — `readTheme` is called after mount, and the
 * check below fails the build if these drift from the stylesheet.
 */
const FALLBACK: ChartTheme = {
  ink: "#101719",
  inkSoft: "#5d6d71",
  inkFaint: "#8b9a9d",
  rule: "#dde4e3",
  ruleSoft: "#eaefee",
  surface: "#ffffff",
  paper: "#f6f8f7",
  accent: "#2a7d6f",
  below: "#1f6f8b",
  belowBg: "#e4eff3",
  above: "#a8661c",
  aboveBg: "#f7ede0",
  warn: "#8a5a12",
  dark: false,
};

/**
 * Read the resolved palette off the document.
 *
 * Returns FALLBACK when there is no document (server render). Throws when the document is there but
 * a token resolves empty, because that means a name in TOKENS no longer matches the stylesheet and
 * the charts would draw in invisible ink — a failure that is far cheaper loud than quiet.
 */
export function readTheme(el?: Element | null): ChartTheme {
  if (typeof document === "undefined") return FALLBACK;
  const target = el ?? document.documentElement;
  const cs = getComputedStyle(target);
  const out = {} as ChartTheme;
  const missing: string[] = [];
  for (const [key, prop] of Object.entries(TOKENS) as [keyof typeof TOKENS, string][]) {
    const v = cs.getPropertyValue(prop).trim();
    if (!v) missing.push(prop);
    out[key] = v;
  }
  if (missing.length > 0) {
    throw new Error(
      `chart-theme: these CSS custom properties resolved empty: ${missing.join(", ")}. ` +
        `They are defined in app/layout.tsx; a chart colour read as "" draws nothing.`,
    );
  }
  // Which palette resolved, from the page itself rather than from matchMedia. The two can disagree
  // once a data-theme attribute is in play, and what the charts must match is the page.
  out.dark = isDarkSurface(out.paper);
  return out;
}

/**
 * Whether a resolved colour is a dark surface, by relative luminance.
 *
 * Handles the two forms the browser returns for these tokens: `rgb(r, g, b)` from a computed style,
 * and `#rrggbb` when reading a custom property that was never resolved against a paint. Anything
 * else returns false rather than throwing — this drives nothing but a label.
 */
export function isDarkSurface(colour: string): boolean {
  const rgb = colour.match(/rgba?\(([^)]+)\)/);
  let r: number, g: number, b: number;
  if (rgb) {
    const parts = rgb[1].split(/[,/\s]+/).map(Number);
    [r, g, b] = parts;
  } else {
    const hex = colour.replace("#", "");
    if (hex.length !== 6 || !/^[0-9a-f]{6}$/i.test(hex)) return false;
    r = parseInt(hex.slice(0, 2), 16);
    g = parseInt(hex.slice(2, 4), 16);
    b = parseInt(hex.slice(4, 6), 16);
  }
  if (![r, g, b].every((n) => Number.isFinite(n))) return false;
  // Rec. 601 luma, which is plenty for "is this a dark background".
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255 < 0.5;
}

/**
 * Subscribe to anything that could change the resolved palette, and call back with the new one.
 *
 * Two triggers, because there are two ways the tokens move: the OS colour scheme (today) and a
 * `data-theme` attribute on the root (the v2 toggle). Wiring both now costs four lines and means
 * the toggle needs no change here.
 *
 * Returns an unsubscribe function. Safe to call on the server, where it does nothing.
 */
export function watchTheme(onChange: (theme: ChartTheme) => void): () => void {
  if (typeof window === "undefined") return () => {};
  const emit = () => onChange(readTheme());
  const mq = window.matchMedia("(prefers-color-scheme: dark)");
  mq.addEventListener("change", emit);
  const mo = new MutationObserver(emit);
  mo.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
  return () => {
    mq.removeEventListener("change", emit);
    mo.disconnect();
  };
}

/**
 * The chart options every chart in this app shares, in the resolved palette.
 *
 * Kept here rather than in each component so that "what a chart looks like in this product" is one
 * decision in one place — the same argument that put the column catalogue in `lib/columns.ts`.
 */
export function baseChartOptions(t: ChartTheme) {
  return {
    layout: {
      background: { color: "transparent" },
      textColor: t.inkFaint,
      fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
      fontSize: 10,
      attributionLogo: false,
    },
    grid: {
      vertLines: { visible: false },
      horzLines: { color: t.ruleSoft, style: 0 as const },
    },
    rightPriceScale: { borderColor: t.rule, scaleMargins: { top: 0.12, bottom: 0.08 } },
    timeScale: { borderColor: t.rule, fixLeftEdge: true, fixRightEdge: true },
    crosshair: {
      // Magnet mode snaps the crosshair to the nearest data point rather than floating between two
      // of them, which matters on a daily series where "between two sessions" is not a place.
      mode: 1 as const,
      vertLine: { color: t.inkFaint, width: 1 as const, style: 3 as const, labelBackgroundColor: t.ink },
      horzLine: { color: t.inkFaint, width: 1 as const, style: 3 as const, labelBackgroundColor: t.ink },
    },
    handleScroll: false,
    handleScale: false,
    localization: { dateFormat: "yyyy-MM-dd" },
  };
}

/**
 * The light palette above, re-exported so a test can assert it still matches the stylesheet.
 * Not for rendering.
 */
export const LIGHT_FALLBACK = FALLBACK;
export const TOKEN_NAMES = TOKENS;
