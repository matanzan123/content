"use client";

import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import { Link } from "@/i18n/Link";
import { splitLocalePath } from "@/i18n/config";
import { NAV_GROUPS } from "@/lib/admin/nav";
import { NavIcon } from "./Icons";
import type { Dictionary } from "@/i18n/dictionaries/en";

type Copy = Dictionary["admin"];

/**
 * Persistent on desktop, a drawer below it.
 *
 * Active state is `aria-current="page"` as well as a colour change, because
 * colour on its own is not a signal. The drawer closes on Escape and on
 * navigation, and returns focus to the trigger — the same pattern the public
 * mobile menu uses.
 */
export function AdminSidebar({ t }: { t: Copy }) {
  const pathname = usePathname();
  const { rest } = splitLocalePath(pathname ?? "/admin");
  // The drawer records the route it was opened on and derives its open state
  // from that, rather than closing itself in an effect. Navigating changes the
  // pathname, which closes it as a render result — no cascading state update.
  const [openedOn, setOpenedOn] = useState<string | null>(null);
  const open = openedOn !== null && openedOn === pathname;
  const setOpen = (next: boolean) => setOpenedOn(next ? (pathname ?? "/admin") : null);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpenedOn(null);
        document.getElementById("admin-nav-toggle")?.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  const nav = (
    <nav aria-label={t.navLabel} className="flex flex-col gap-6 p-4">
      {NAV_GROUPS.map((group, i) => (
        <div key={group.labelKey ?? `group-${i}`}>
          {group.labelKey && (
            <p className="mb-2 px-3 text-[10.5px] font-bold uppercase tracking-[0.14em] text-[color:var(--a-text-dim)]">
              {t[group.labelKey]}
            </p>
          )}
          <ul className="flex flex-col gap-0.5">
            {group.items.map((item) => {
              // Exact match for the index route, prefix for the rest, so
              // /admin does not stay highlighted on /admin/revenue.
              const active = item.href === "/admin" ? rest === "/admin" : rest.startsWith(item.href);
              return (
                <li key={item.key}>
                  <Link
                    href={item.href}
                    aria-current={active ? "page" : undefined}
                    className={[
                      "flex items-center gap-2.5 rounded-md px-3 py-2 text-[13.5px] font-medium transition-colors",
                      active
                        ? "bg-[color:var(--a-accent-soft)] text-[color:var(--a-accent)]"
                        : "text-[color:var(--a-text-muted)] hover:bg-[color:var(--a-panel-raised)] hover:text-[color:var(--a-text)]",
                    ].join(" ")}
                  >
                    <NavIcon name={item.icon} />
                    <span className="truncate">{t.nav[item.key]}</span>
                    {active && (
                      <span
                        aria-hidden="true"
                        className="ms-auto h-4 w-[2px] rounded-full bg-[color:var(--a-accent)]"
                      />
                    )}
                  </Link>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </nav>
  );

  return (
    <>
      <button
        id="admin-nav-toggle"
        type="button"
        onClick={() => setOpen(true)}
        aria-expanded={open}
        aria-controls="admin-drawer"
        aria-label={t.openNav}
        className="flex h-9 w-9 items-center justify-center rounded-md border border-[color:var(--a-border)] text-[color:var(--a-text-muted)] lg:hidden"
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
          <path d="M4 7h16M4 12h16M4 17h16" strokeLinecap="round" />
        </svg>
      </button>

      {/* Desktop rail */}
      <aside className="hidden w-[224px] shrink-0 border-e border-[color:var(--a-border)] bg-[color:var(--a-panel)] lg:block">
        <div className="sticky top-0 max-h-screen overflow-y-auto">
          <div className="flex items-center gap-2.5 border-b border-[color:var(--a-border)] px-5 py-4">
            <span
              aria-hidden="true"
              className="flex h-7 w-7 items-center justify-center rounded-[7px] bg-[color:var(--a-accent)] text-[11px] font-black text-[#1a0d05]"
            >
              CR
            </span>
            <span className="text-[13px] font-bold tracking-tight">{t.title}</span>
          </div>
          {nav}
        </div>
      </aside>

      {/* Mobile drawer */}
      {open && (
        <div className="fixed inset-0 z-50 lg:hidden">
          <button
            type="button"
            aria-label={t.closeNav}
            onClick={() => setOpen(false)}
            className="absolute inset-0 bg-black/70"
          />
          <div
            id="admin-drawer"
            className="absolute inset-y-0 start-0 w-[264px] overflow-y-auto border-e border-[color:var(--a-border)] bg-[color:var(--a-panel)]"
          >
            <div className="flex items-center justify-between border-b border-[color:var(--a-border)] px-5 py-4">
              <span className="text-[13px] font-bold">{t.title}</span>
              <button
                type="button"
                onClick={() => setOpen(false)}
                aria-label={t.closeNav}
                className="text-[color:var(--a-text-muted)]"
              >
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                  <path d="M6 6l12 12M18 6L6 18" strokeLinecap="round" />
                </svg>
              </button>
            </div>
            {nav}
          </div>
        </div>
      )}
    </>
  );
}
