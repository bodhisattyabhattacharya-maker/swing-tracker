"use client";

/**
 * The two-tab control. A client component only because it needs to know which route is active.
 *
 * Imports nothing but `next/navigation` — no data layer, no config with a secret in it. The tab
 * state is the URL, deliberately: a preset or a filter is transient and belongs in memory, but
 * "which half of the product am I in" is something you send someone a link to.
 */

import Link from "next/link";
import { usePathname } from "next/navigation";

const TABS = [
  { href: "/", label: "Dashboard", icon: "≡" },
  { href: "/deep-dive", label: "Deep Dive", icon: "⌁" },
];

export default function Tabs() {
  const path = usePathname();
  return (
    <nav className="tabs" aria-label="Primary">
      {TABS.map((t) => {
        const active = t.href === "/" ? path === "/" : path.startsWith(t.href);
        return (
          <Link
            key={t.href}
            href={t.href}
            className={active ? "tab on" : "tab"}
            aria-current={active ? "page" : undefined}
          >
            <span className="tabicon">{t.icon}</span>
            {t.label}
          </Link>
        );
      })}
    </nav>
  );
}
