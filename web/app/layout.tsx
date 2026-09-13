/**
 * Root layout. Desktop-first (decision 0005): this dashboard is a dense grid read at a desk,
 * not on a phone, so there is no mobile breakpoint work here and that is deliberate.
 *
 * Styles are inline in a <style> tag rather than a CSS module because there is exactly one
 * page so far. When a second page arrives, move them out - not before.
 */
import type { ReactNode } from "react";

export const metadata = {
  title: "Swing Tracker",
  description: "Watchlist tracker — 26 parameters, colour-coded against norms we set.",
};

const CSS = `
  :root {
    --bg: #0f1115;
    --panel: #171a21;
    --line: #262b35;
    --text: #e7e9ee;
    --muted: #98a1b3;
    --ok: #3fb950;
    --warn: #d29922;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    background: var(--bg);
    color: var(--text);
    font: 15px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
  }
  main { max-width: 860px; margin: 0 auto; padding: 56px 24px 80px; }
  h1 { font-size: 28px; letter-spacing: -0.01em; margin: 0 0 6px; }
  .sub { color: var(--muted); margin: 0 0 36px; }
  .panel {
    background: var(--panel);
    border: 1px solid var(--line);
    border-radius: 10px;
    padding: 20px 22px;
    margin-bottom: 18px;
  }
  .panel h2 { font-size: 13px; text-transform: uppercase; letter-spacing: 0.08em;
    color: var(--muted); margin: 0 0 14px; font-weight: 600; }
  table { width: 100%; border-collapse: collapse; font-size: 14px; }
  td { padding: 7px 0; border-bottom: 1px solid var(--line); vertical-align: top; }
  tr:last-child td { border-bottom: 0; }
  td:first-child { color: var(--muted); width: 46%; }
  code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 13px; }
  .yes { color: var(--ok); }
  .no { color: var(--warn); }
  footer { color: var(--muted); font-size: 13px; margin-top: 32px; }
  a { color: inherit; }
`;

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <head>
        <style dangerouslySetInnerHTML={{ __html: CSS }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
