import { Link } from "@/i18n/Link";
import type { Locale } from "@/i18n/config";

/**
 * The refusal surface. A server component on purpose: it renders instead of
 * the dashboard, never alongside it, so there is no admin payload to reveal.
 *
 * "unconfigured" and "forbidden" are worded differently because they are
 * different problems — one is an operator's missing service account, the other
 * is a real user without the role — but neither leaks anything about what the
 * dashboard contains.
 */
export function AccessDenied({
  locale,
  title,
  body,
  homeLabel,
}: {
  locale: Locale;
  title: string;
  body: string;
  homeLabel: string;
}) {

  return (
    <main
      id="main-content"
      className="flex min-h-[70vh] flex-1 items-center justify-center px-6 py-20"
      lang={locale}
    >
      <div className="w-full max-w-[440px] rounded-[var(--radius-token-lg)] border border-line bg-surface p-8 text-center shadow-[var(--shadow-card)]">
        <span
          className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-surface-sunken text-ink-soft"
          aria-hidden="true"
        >
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none">
            <rect x="4" y="10" width="16" height="10" rx="2.5" stroke="currentColor" strokeWidth="1.8" />
            <path
              d="M8 10V7.5a4 4 0 018 0V10"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
            />
          </svg>
        </span>

        <h1 className="mt-5 font-[var(--font-display)] text-[22px] font-extrabold tracking-tight text-ink">
          {title}
        </h1>
        <p className="mt-2.5 text-[14px] leading-relaxed text-ink-soft">
          {body}
        </p>

        <Link
          href="/"
          className="mt-6 inline-flex rounded-[var(--radius-token-pill)] bg-ink px-5 py-2.5 text-[13.5px] font-bold text-white transition-colors hover:bg-ink/90"
        >
          {homeLabel}
        </Link>
      </div>
    </main>
  );
}
