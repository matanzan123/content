"use client";

import { useCallback, useEffect, useId, useRef, useState, useSyncExternalStore } from "react";
import { Link } from "@/i18n/Link";
import { useT } from "@/i18n/provider";

/* ==========================================================================
   ACCESSIBILITY PREFERENCES

   A small set of genuine display preferences. Everything here changes real CSS
   on the document; nothing pretends to be a screen reader or a substitute for
   the semantic work in the rest of the product.

   Preferences live in localStorage under one namespaced key and never leave the
   device.
   ========================================================================== */

const STORAGE_KEY = "cliprewards_accessibility_preferences";

type TextSize = "normal" | "large" | "xlarge";

type Prefs = {
  textSize: TextSize;
  contrast: boolean;
  highlightLinks: boolean;
  reduceMotion: boolean;
};

const DEFAULTS: Prefs = {
  textSize: "normal",
  contrast: false,
  highlightLinks: false,
  reduceMotion: false,
};

const TEXT_CLASS: Record<TextSize, string> = {
  normal: "",
  large: "a11y-text-large",
  xlarge: "a11y-text-xlarge",
};

function applyPrefs(prefs: Prefs) {
  const root = document.documentElement;
  root.classList.remove("a11y-text-large", "a11y-text-xlarge");
  if (TEXT_CLASS[prefs.textSize]) root.classList.add(TEXT_CLASS[prefs.textSize]);
  root.classList.toggle("a11y-contrast", prefs.contrast);
  root.classList.toggle("a11y-highlight-links", prefs.highlightLinks);
  root.classList.toggle("a11y-reduce-motion", prefs.reduceMotion);
}

/*
  The preferences live in localStorage, which is an external store, so the
  component subscribes to it rather than copying it into state on mount. The
  snapshot is cached because useSyncExternalStore compares it by identity.
*/
const listeners = new Set<() => void>();
let snapshot: Prefs = DEFAULTS;
let snapshotRaw: string | null = null;

function subscribe(cb: () => void) {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

function getSnapshot(): Prefs {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw !== snapshotRaw) {
      snapshotRaw = raw;
      snapshot = raw ? { ...DEFAULTS, ...(JSON.parse(raw) as Partial<Prefs>) } : DEFAULTS;
    }
  } catch {
    // Storage blocked or corrupt — keep whatever we last had.
  }
  return snapshot;
}

/** The server has no storage, so it always renders the defaults. */
function getServerSnapshot(): Prefs {
  return DEFAULTS;
}

function writePrefs(next: Prefs) {
  snapshot = next;
  try {
    snapshotRaw = JSON.stringify(next);
    window.localStorage.setItem(STORAGE_KEY, snapshotRaw);
  } catch {
    // Storage unavailable — the preference still applies for this session.
  }
  listeners.forEach((l) => l());
}

function AccessibilityIcon({ size = 22 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="1.8" opacity="0.45" />
      <circle cx="12" cy="6.4" r="1.55" fill="currentColor" />
      <path
        d="M6.8 9.4c1.7.6 3.4.9 5.2.9s3.5-.3 5.2-.9M12 10.3v4m0 0l-2.1 4.4M12 14.3l2.1 4.4"
        stroke="currentColor"
        strokeWidth="1.9"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function SegmentedTextSize({
  value,
  onChange,
  labelId,
}: {
  value: TextSize;
  onChange: (v: TextSize) => void;
  labelId: string;
}) {
  const t = useT();
  const options: { key: TextSize; label: string }[] = [
    { key: "normal", label: t.a11y.normal },
    { key: "large", label: t.a11y.large },
    { key: "xlarge", label: t.a11y.xlarge },
  ];
  return (
    <div role="radiogroup" aria-labelledby={labelId} className="mt-2 flex gap-1.5">
      {options.map((opt) => {
        const selected = value === opt.key;
        return (
          <button
            key={opt.key}
            type="button"
            role="radio"
            aria-checked={selected}
            onClick={() => onChange(opt.key)}
            className={[
              "flex-1 rounded-[var(--radius-token-sm)] border px-2 py-2 text-[12.5px] font-semibold transition-colors",
              selected
                ? "border-accent bg-accent text-white"
                : "border-line bg-surface text-ink-soft hover:text-ink",
            ].join(" ")}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}

/** A real checkbox styled as a switch, so it is announced and operated natively. */
function Toggle({
  checked,
  onChange,
  label,
  description,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
  description: string;
}) {
  return (
    <label className="flex cursor-pointer items-start gap-3 rounded-[var(--radius-token-sm)] py-2">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="peer sr-only"
      />
      <span
        aria-hidden="true"
        className={[
          "mt-0.5 flex h-5 w-9 shrink-0 items-center rounded-full border px-[2px] transition-colors",
          checked ? "justify-end border-accent bg-accent" : "justify-start border-line bg-surface-sunken",
          "peer-focus-visible:outline peer-focus-visible:outline-[3px] peer-focus-visible:outline-offset-2 peer-focus-visible:outline-[color:var(--accent)]",
        ].join(" ")}
      >
        <span className="block h-4 w-4 rounded-full bg-white shadow-[0_1px_3px_rgba(0,0,0,0.3)]" />
      </span>
      <span className="min-w-0">
        <span className="block text-[13.5px] font-semibold text-ink">{label}</span>
        <span className="block text-[12px] leading-snug text-ink-soft">{description}</span>
      </span>
    </label>
  );
}

export function AccessibilityWidget() {
  const prefs = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  const t = useT();
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const headingId = useId();
  const textSizeLabelId = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  // Keep the document classes in step with the stored preferences. The inline
  // script in the layout has normally already done this before first paint;
  // this covers every change made afterwards.
  useEffect(() => {
    applyPrefs(prefs);
  }, [prefs]);

  const update = useCallback(
    (next: Partial<Prefs>) => {
      writePrefs({ ...prefs, ...next });
    },
    [prefs],
  );

  const close = useCallback(
    (returnFocus = true) => {
      setOpen(false);
      if (returnFocus) triggerRef.current?.focus();
    },
    [],
  );

  // Escape closes and hands focus back; a click outside just closes.
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.stopPropagation();
        close();
      }
    }
    function onPointer(e: MouseEvent) {
      const t = e.target as Node;
      if (panelRef.current?.contains(t) || triggerRef.current?.contains(t)) return;
      close(false);
    }
    document.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onPointer);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onPointer);
    };
  }, [open, close]);

  // Move focus into the panel when it opens so keyboard users land inside it.
  useEffect(() => {
    if (!open) return;
    const first = panelRef.current?.querySelector<HTMLElement>("button, input, a");
    first?.focus();
  }, [open]);

  const changed =
    prefs.textSize !== "normal" || prefs.contrast || prefs.highlightLinks || prefs.reduceMotion;

  return (
    <div className="a11y-launcher fixed bottom-4 left-4 z-50 print:hidden">
      {open && (
        <div
          ref={panelRef}
          id={panelId}
          role="dialog"
          aria-modal="false"
          aria-labelledby={headingId}
          className="mb-3 w-[min(320px,calc(100vw-2rem))] rounded-[var(--radius-token-lg)] border border-line bg-surface p-4 shadow-[var(--shadow-float)]"
        >
          <div className="flex items-start justify-between gap-3">
            <h2 id={headingId} className="text-[15px] font-extrabold tracking-tight text-ink">
              {t.a11y.options}
            </h2>
            <button
              type="button"
              onClick={() => close()}
              aria-label={t.a11y.close}
              className="-mr-1 -mt-1 flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-ink-soft transition-colors hover:bg-surface-sunken hover:text-ink"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                <path d="M6 6l12 12M18 6L6 18" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
              </svg>
            </button>
          </div>

          <p className="mt-1 text-[12px] leading-snug text-ink-soft">
            {t.a11y.savedLocally}
          </p>

          <div className="mt-4">
            <p id={textSizeLabelId} className="text-[13.5px] font-semibold text-ink">
              {t.a11y.textSize}
            </p>
            <SegmentedTextSize
              value={prefs.textSize}
              onChange={(v) => update({ textSize: v })}
              labelId={textSizeLabelId}
            />
          </div>

          <div className="mt-3 divide-y divide-line border-t border-line pt-1">
            <Toggle
              checked={prefs.contrast}
              onChange={(v) => update({ contrast: v })}
              label={t.a11y.contrast}
              description={t.a11y.contrastHint}
            />
            <Toggle
              checked={prefs.highlightLinks}
              onChange={(v) => update({ highlightLinks: v })}
              label={t.a11y.highlightLinks}
              description={t.a11y.highlightLinksHint}
            />
            <Toggle
              checked={prefs.reduceMotion}
              onChange={(v) => update({ reduceMotion: v })}
              label={t.a11y.reduceMotion}
              description={t.a11y.reduceMotionHint}
            />
          </div>

          <div className="mt-4 flex items-center justify-between gap-3 border-t border-line pt-3">
            <button
              type="button"
              onClick={() => update(DEFAULTS)}
              disabled={!changed}
              className="rounded-[var(--radius-token-pill)] border border-line px-3.5 py-2 text-[12.5px] font-semibold text-ink transition-colors hover:bg-surface-sunken disabled:cursor-not-allowed disabled:text-ink-soft disabled:opacity-70"
            >
              {t.a11y.reset}
            </button>
            <Link
              href="/accessibility"
              onClick={() => setOpen(false)}
              className="text-[12.5px] font-semibold text-accent-ink underline underline-offset-2"
            >
              {t.a11y.statement}
            </Link>
          </div>

          {/* announces the reset to assistive technology without a visual change */}
          <p className="sr-only" role="status">
            {changed ? "" : t.a11y.atDefaults}
          </p>
        </div>
      )}

      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-controls={panelId}
        aria-label={t.a11y.options}
        className="relative flex h-12 w-12 items-center justify-center rounded-full border border-line bg-surface text-ink shadow-[var(--shadow-float)] transition-colors hover:bg-surface-sunken"
      >
        <AccessibilityIcon />
        {changed && (
          <span
            aria-hidden="true"
            className="absolute right-0 top-0 h-3 w-3 rounded-full border-2 border-surface bg-accent"
          />
        )}
      </button>
    </div>
  );
}
