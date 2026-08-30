"use client";

import { INTL_LOCALE, type Locale } from "@/i18n/config";
import { useI18n } from "@/i18n/provider";
import { LANGUAGES, type OnboardingDraft } from "./types";

function joinedLabel(locale: Locale) {
  return new Date().toLocaleDateString(INTL_LOCALE[locale], { month: "short", year: "numeric" });
}

export function ProfilePreview({
  draft,
  handle,
  whopHandle,
}: {
  draft: OnboardingDraft;
  handle: string;
  whopHandle: string | null;
}) {
  const { t, locale } = useI18n();
  const o = t.onboarding;
  const name = draft.fullName.trim() || o.previewName;
  const initial = name.charAt(0).toLowerCase();

  return (
    <div className="rounded-[var(--radius-token-lg)] border border-line bg-surface p-6 shadow-[var(--shadow-card)]">
      <div className="flex items-start gap-4">
        {draft.photoURL ? (
          // Remote Google/Whop avatars aren't in next.config images.remotePatterns,
          // so this stays a plain <img> rather than next/image.
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={draft.photoURL}
            alt=""
            className="h-14 w-14 shrink-0 rounded-[14px] object-cover"
            referrerPolicy="no-referrer"
          />
        ) : (
          <span
            className="flex h-14 w-14 shrink-0 items-center justify-center rounded-[14px] text-[24px] font-bold text-white"
            style={{ background: "linear-gradient(140deg, var(--accent), var(--accent-violet))" }}
          >
            {initial}
          </span>
        )}

        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
            <p className="text-[17px] font-bold tracking-tight text-ink">{name}</p>
            <span className="rounded-md bg-surface-sunken px-2 py-0.5 text-[11px] font-medium text-ink-soft">
              {o.previewUnranked}
            </span>
            <span className="ms-auto text-[12.5px] text-ink-soft">{o.previewJoined.replace("{date}", joinedLabel(locale))}</span>
          </div>
          <p className="mt-0.5 text-[14px] text-ink-soft">
            <span className="ltr-token">@{whopHandle ?? handle}</span>
          </p>
        </div>
      </div>

      {draft.bio.trim() && (
        <p className="mt-5 text-[13.5px] font-medium leading-relaxed text-ink">{draft.bio.trim()}</p>
      )}

      {draft.languages.length > 0 && (
        <div className="mt-5 flex flex-wrap gap-2">
          {draft.languages.map((lang) => {
            const flag = LANGUAGES.find((l) => l.label === lang)?.flag ?? "🌐";
            return (
              <span
                key={lang}
                className="inline-flex items-center gap-1.5 rounded-[var(--radius-token-sm)] bg-surface-sunken px-2.5 py-1.5 text-[12.5px] font-medium text-ink"
              >
                <span aria-hidden="true">{flag}</span>
                {o.languages[lang as keyof typeof o.languages] ?? lang}
              </span>
            );
          })}
        </div>
      )}

      {(draft.creatorType || draft.socials.length > 0) && (
        <div className="mt-5 flex flex-wrap gap-2 border-t border-line pt-5">
          {draft.creatorType && (
            <span className="rounded-[var(--radius-token-sm)] bg-accent-soft px-2.5 py-1.5 text-[12.5px] font-semibold text-accent-ink">
              {draft.creatorType}
            </span>
          )}
          {draft.socials.map((s) => (
            <span
              key={s}
              className="rounded-[var(--radius-token-sm)] bg-surface-sunken px-2.5 py-1.5 text-[12.5px] font-medium text-ink-soft"
            >
              {s}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
