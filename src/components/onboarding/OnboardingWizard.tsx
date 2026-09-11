"use client";

import { useT } from "@/i18n/provider";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAuth } from "@/components/auth/AuthProvider";
import { ProfilePreview } from "./ProfilePreview";
import { SocialIcon } from "./SocialIcons";
import {
  CREATOR_TYPES,
  LANGUAGES,
  MAX_BIO,
  MAX_LANGUAGES,
  REFERRAL_SOURCES,
  SOCIAL_PLATFORMS,
  STEP_COUNT,
  emptyDraft,
  handleFromEmail,
  type OnboardingDraft,
  type SocialPlatform,
} from "./types";

const STORAGE_PREFIX = "cr-onboarding:";

function Chip({
  active,
  disabled,
  onClick,
  children,
}: {
  active: boolean;
  disabled?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-pressed={active}
      className={[
        "inline-flex items-center gap-2 rounded-[var(--radius-token-md)] px-3.5 py-2 text-[13.5px] font-medium transition-colors",
        active
          ? "bg-accent text-white"
          : "bg-surface-sunken text-ink hover:bg-line/60 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-surface-sunken",
      ].join(" ")}
    >
      {children}
    </button>
  );
}
function ProgressBar({ step }: { step: number }) {
  const t = useT().onboarding;
  return (
    <div
      className="flex gap-2"
      role="progressbar"
      aria-valuemin={1}
      aria-valuemax={STEP_COUNT}
      aria-valuenow={step + 1}
      aria-label={t.stepOf.replace("{current}", String(step + 1)).replace("{total}", String(STEP_COUNT))}
    >
      {Array.from({ length: STEP_COUNT }, (_, i) => (
        <span
          key={i}
          className={[
            "h-1.5 w-14 rounded-full transition-colors",
            i <= step ? "bg-accent" : "bg-line",
          ].join(" ")}
        />
      ))}
    </div>
  );
}

const FIELD =
  "w-full rounded-[var(--radius-token-md)] border border-line bg-surface-sunken px-4 py-3 text-[14px] text-ink outline-none transition-colors placeholder:text-ink-soft/70 focus:border-accent focus:bg-surface focus:ring-4 focus:ring-accent-soft";

export function OnboardingWizard() {
  const dict = useT();
  const t = dict.onboarding;
  const c = dict.common;
  const { user, signOut } = useAuth();
  const [draft, setDraft] = useState<OnboardingDraft>(emptyDraft);
  const [hydrated, setHydrated] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  /*
   * WHOP CONNECTION HAS BEEN REMOVED FROM ONBOARDING.
   *
   * The last step used to offer "Connect Whop", so anyone who had merely
   * signed in with Google could start linking a Whop account before
   * ClipRewards had spoken to them. Whop connection belongs AFTER approval:
   * the server now refuses it for anyone who is not an approved creator or
   * brand (`requireWhopEligible`), and this step submits the application
   * instead.
   */
  const storageKey = `${STORAGE_PREFIX}${user?.uid ?? "guest"}`;
  const seededFor = useRef<string | null>(null);

  const handle = handleFromEmail(user?.email);

  // Restore any half-finished draft, then seed blanks from the Google profile.
  useEffect(() => {
    if (seededFor.current === storageKey) return;
    seededFor.current = storageKey;
    let restored: Partial<OnboardingDraft> = {};
    try {
      const raw = window.localStorage.getItem(storageKey);
      if (raw) restored = JSON.parse(raw) as Partial<OnboardingDraft>;
    } catch {
      // Corrupt or blocked storage — fall back to a fresh draft.
    }
    setDraft({
      ...emptyDraft(),
      fullName: user?.displayName ?? "",
      photoURL: user?.photoURL ?? null,
      ...restored,
    });
    setHydrated(true);
  }, [storageKey, user]);

  useEffect(() => {
    if (!hydrated) return;
    try {
      window.localStorage.setItem(storageKey, JSON.stringify(draft));
    } catch {
      // Storage unavailable — the wizard still works for this session.
    }
  }, [draft, storageKey, hydrated]);

  // Pull any profile already saved server-side, so a reload or a second device
  // resumes where the applicant left off. The wizard previously kept its draft
  // in localStorage only, which is why signing in elsewhere started over.
  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    (async () => {
      try {
        const idToken = await user.getIdToken();
        const response = await fetch("/api/onboarding/profile", {
          headers: { authorization: `Bearer ${idToken}` },
        });
        if (!response.ok || cancelled) return;
        const d = (await response.json()) as {
          profile?: {
            fullName?: string | null;
            bio?: string | null;
            languages?: string[] | null;
            creatorType?: string | null;
            referralSource?: string | null;
            socials?: string[] | null;
            lastStep?: number;
          } | null;
        };
        if (cancelled || !d.profile) return;
        setDraft((current) => ({
          ...current,
          fullName: d.profile?.fullName ?? current.fullName,
          bio: d.profile?.bio ?? current.bio,
          languages: d.profile?.languages ?? current.languages,
          creatorType: d.profile?.creatorType ?? current.creatorType,
          referral: d.profile?.referralSource ?? current.referral,
          socials: (d.profile?.socials as SocialPlatform[]) ?? current.socials,
          step: typeof d.profile?.lastStep === "number" ? d.profile.lastStep : current.step,
        }));
      } catch {
        // A failed read is not worth surfacing; the local draft still works.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [user]);

  /**
   * Submits the application: persists the profile and marks onboarding done.
   *
   * THE SERVER DECIDES WHAT HAPPENS NEXT. This reloads rather than routing, so
   * the page guard re-runs and sends the applicant to interview booking — or
   * wherever their real stage belongs. A client that picked the destination
   * itself would be guessing at an authorization decision.
   */
  const submitApplication = useCallback(async () => {
    if (!user || submitting) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      const idToken = await user.getIdToken();

      /*
       * THE ROLE IS RECORDED FIRST, AND COMPLETION DEPENDS ON IT.
       *
       * `refreshProgress` only lets an account leave `onboarding` when a role
       * AND a completed profile are both present. Saving the profile first
       * would stamp `onboarding_completed_at`, advance nothing, and strand the
       * applicant on this wizard — which is exactly what used to happen.
       *
       * The role is "creator" because this IS the creator wizard. It is not
       * derived from `creatorType`, which is a content category ("Clipper",
       * "UGC Face") and says nothing about the kind of account.
       */
      const roleResponse = await fetch("/api/onboarding/role", {
        method: "POST",
        headers: { authorization: `Bearer ${idToken}`, "content-type": "application/json" },
        body: JSON.stringify({ role: "creator" }),
      });
      if (!roleResponse.ok) {
        // Stop here: an application that cannot record what it is applying as
        // must not be marked complete.
        const body = (await roleResponse.json().catch(() => null)) as { error?: string } | null;
        setSubmitError(body?.error ?? "error");
        setSubmitting(false);
        return;
      }

      const response = await fetch("/api/onboarding/profile", {
        method: "POST",
        headers: { authorization: `Bearer ${idToken}`, "content-type": "application/json" },
        body: JSON.stringify({
          fullName: draft.fullName,
          bio: draft.bio,
          photoUrl: draft.photoURL,
          languages: draft.languages,
          creatorType: draft.creatorType,
          referralSource: draft.referral,
          socials: draft.socials,
          lastStep: draft.step,
          complete: true,
        }),
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as { error?: string } | null;
        setSubmitError(body?.error ?? "error");
        setSubmitting(false);
        return;
      }
      window.location.reload();
    } catch {
      setSubmitError("network");
      setSubmitting(false);
    }
  }, [user, submitting, draft]);

  const update = (patch: Partial<OnboardingDraft>) => setDraft((d) => ({ ...d, ...patch }));

  function toggleLanguage(label: string) {
    setDraft((d) => {
      const has = d.languages.includes(label);
      if (!has && d.languages.length >= MAX_LANGUAGES) return d;
      return {
        ...d,
        languages: has ? d.languages.filter((l) => l !== label) : [...d.languages, label],
      };
    });
  }

  function toggleSocial(platform: SocialPlatform) {
    setDraft((d) => ({
      ...d,
      socials: d.socials.includes(platform)
        ? d.socials.filter((s) => s !== platform)
        : [...d.socials, platform],
    }));
  }

  const canContinue = useMemo(() => {
    switch (draft.step) {
      case 0:
        return draft.fullName.trim().length > 0;
      case 1:
        return draft.languages.length > 0;
      case 2:
        return draft.creatorType !== "" && draft.referral !== "";
      default:
        return true;
    }
  }, [draft]);

  if (!hydrated) {
    return <div className="min-h-[520px] rounded-[var(--radius-token-lg)] bg-surface" />;
  }

  /*
   * There is no local "done" screen any more.
   *
   * Submitting reloads, the server page guard re-runs, and the applicant is
   * routed to their real next stage — interview booking, or the waiting page
   * if they already have a slot. A client-rendered success screen would be the
   * wizard asserting an outcome the server had not yet agreed to.
   */
  const isLastStep = draft.step === STEP_COUNT - 1;

  return (
    <div className="grid overflow-hidden rounded-[var(--radius-token-lg)] bg-surface shadow-[var(--shadow-float)] lg:grid-cols-[1fr_1fr]">
      {/* Left — the step form */}
      <div className="flex min-h-[560px] flex-col p-7 sm:p-9">
        <ProgressBar step={draft.step} />

        <div className="mt-7 flex-1">
          {draft.step === 0 && (
            <>
              <h1 className="font-[var(--font-display)] text-[26px] font-extrabold tracking-tight text-ink">
                {t.step1Title}
              </h1>

              <p className="mt-6 text-[13px] font-medium text-ink-soft">{t.profilePhoto}</p>
              <div className="mt-2 flex items-center gap-4">
                <span className="inline-flex items-center gap-2.5 rounded-[var(--radius-token-md)] bg-surface-sunken py-2 pl-2 pr-4">
                  {draft.photoURL ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={draft.photoURL}
                      alt=""
                      className="h-7 w-7 rounded-[8px] object-cover"
                      referrerPolicy="no-referrer"
                    />
                  ) : (
                    <span
                      className="flex h-7 w-7 items-center justify-center rounded-[8px] text-[13px] font-bold text-white"
                      style={{ background: "linear-gradient(140deg, var(--accent), var(--accent-violet))" }}
                    >
                      {(draft.fullName.trim() || "c").charAt(0).toLowerCase()}
                    </span>
                  )}
                  <span className="text-[13.5px] font-medium text-ink">
                    {draft.photoURL ? t.fromGoogle : t.noPhoto}
                  </span>
                </span>
                {draft.photoURL && (
                  <button
                    type="button"
                    onClick={() => update({ photoURL: null })}
                    className="text-[13.5px] font-medium text-red-600 transition-colors hover:text-red-700"
                  >
                    {t.remove}
                  </button>
                )}
              </div>

              <div className="mt-6">
                <label htmlFor="fullName" className="block text-[13px] font-medium text-ink-soft">
                  {t.fullName}
                </label>
                <input
                  id="fullName"
                  value={draft.fullName}
                  onChange={(e) => update({ fullName: e.target.value })}
                  placeholder={t.fullNamePlaceholder}
                  className={`mt-2 ${FIELD}`}
                />
              </div>

              <div className="mt-5">
                <label htmlFor="handle" className="block text-[13px] font-medium text-ink-soft">
                  {t.username}{" "}
                  <span className="text-ink-soft/70">
                    {t.autoGenerated}
                  </span>
                </label>
                <div className="relative mt-2">
                  <span className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-[14px] text-ink-soft/70">
                    @
                  </span>
                  <input
                    id="handle"
                    value={handle}
                    readOnly
                    disabled
                    className={`${FIELD} cursor-not-allowed pl-9 pr-10 text-ink-soft`}
                  />
                  <svg
                    width="16"
                    height="16"
                    viewBox="0 0 24 24"
                    fill="none"
                    aria-hidden="true"
                    className="pointer-events-none absolute right-4 top-1/2 -translate-y-1/2 text-ink-soft"
                  >
                    <rect x="5" y="10.5" width="14" height="9.5" rx="2.2" stroke="currentColor" strokeWidth="1.7" />
                    <path d="M8.2 10.5V8a3.8 3.8 0 0 1 7.6 0v2.5" stroke="currentColor" strokeWidth="1.7" />
                  </svg>
                </div>
              </div>

              <div className="mt-5">
                <label htmlFor="bio" className="block text-[13px] font-medium text-ink-soft">
                  {t.bio}
                </label>
                <textarea
                  id="bio"
                  rows={2}
                  maxLength={MAX_BIO}
                  value={draft.bio}
                  onChange={(e) => update({ bio: e.target.value })}
                  placeholder={t.bioPlaceholder}
                  className={`mt-2 resize-none ${FIELD}`}
                />
                <p className="mt-1.5 text-right text-[12px] text-ink-soft">
                  {draft.bio.length}/{MAX_BIO}
                </p>
              </div>
            </>
          )}

          {draft.step === 1 && (
            <>
              <h1 className="font-[var(--font-display)] text-[26px] font-extrabold tracking-tight text-ink">
                {t.step2Title}
              </h1>
              <p className="mt-6 text-[13px] font-medium text-ink-soft">
                {t.languageQuestion}
              </p>
              <div className="mt-3 flex flex-wrap gap-2">
                {LANGUAGES.map((lang) => {
                  const active = draft.languages.includes(lang.label);
                  return (
                    <Chip
                      key={lang.label}
                      active={active}
                      disabled={!active && draft.languages.length >= MAX_LANGUAGES}
                      onClick={() => toggleLanguage(lang.label)}
                    >
                      <span aria-hidden="true">{lang.flag}</span>
                      {t.languages[lang.label]}
                    </Chip>
                  );
                })}
              </div>
              <p className="mt-3 text-[12.5px] text-ink-soft">
                {t.selectedCount.replace("{count}", String(draft.languages.length)).replace("{max}", String(MAX_LANGUAGES))}
              </p>
            </>
          )}

          {draft.step === 2 && (
            <>
              <h1 className="font-[var(--font-display)] text-[26px] font-extrabold tracking-tight text-ink">
                {t.step3Title}
              </h1>
              <div className="mt-6 flex flex-wrap gap-2">
                {CREATOR_TYPES.map((type) => (
                  <Chip
                    key={type}
                    active={draft.creatorType === type}
                    onClick={() => update({ creatorType: draft.creatorType === type ? "" : type })}
                  >
                    {type}
                  </Chip>
                ))}
              </div>

              <p className="mt-7 text-[13px] font-medium text-ink-soft">{t.referralQuestion}</p>
              <div className="mt-3 flex flex-wrap gap-2">
                {REFERRAL_SOURCES.map((source) => (
                  <Chip
                    key={source}
                    active={draft.referral === source}
                    onClick={() => update({ referral: draft.referral === source ? "" : source })}
                  >
                    {t.referralSources[source]}
                  </Chip>
                ))}
              </div>
            </>
          )}

          {draft.step === 3 && (
            <>
              <h1 className="font-[var(--font-display)] text-[26px] font-extrabold tracking-tight text-ink">
                {t.step4Title}
              </h1>
              <ul className="mt-6 divide-y divide-line overflow-hidden rounded-[var(--radius-token-md)] border border-line">
                {SOCIAL_PLATFORMS.map((platform) => {
                  const connected = draft.socials.includes(platform);
                  return (
                    <li key={platform} className="flex items-center gap-3 px-4 py-3.5">
                      <span className="flex h-9 w-9 items-center justify-center rounded-[10px] bg-surface-sunken text-ink">
                        <SocialIcon platform={platform} />
                      </span>
                      <span className="flex-1 text-[14px] font-medium text-ink">{platform}</span>
                      <button
                        type="button"
                        onClick={() => toggleSocial(platform)}
                        className={[
                          "rounded-[var(--radius-token-sm)] border px-3.5 py-1.5 text-[13px] font-semibold transition-colors",
                          connected
                            ? "border-accent bg-accent-soft text-accent-ink"
                            : "border-line text-ink hover:bg-surface-sunken",
                        ].join(" ")}
                      >
                        {connected ? t.connected : t.connect}
                      </button>
                    </li>
                  );
                })}
              </ul>
              <p className="mt-3 text-[12.5px] text-ink-soft">
                {t.socialsNote}
              </p>
            </>
          )}

          {draft.step === 4 && (
            <div className="flex h-full flex-col items-center justify-center py-10 text-center">
              <h1 className="mt-5 font-[var(--font-display)] text-[24px] font-extrabold tracking-tight text-ink">
                {t.reviewTitle}
              </h1>
              <p className="mt-2.5 max-w-[340px] text-[14px] leading-relaxed text-ink-soft">
                {t.reviewBody}
              </p>
              {submitError && (
                <p role="alert" className="mt-4 max-w-[320px] text-[13px] font-medium text-red-700">
                  {submitError}
                </p>
              )}
            </div>
          )}
        </div>

        <div className="mt-8 flex items-center gap-3">
          <button
            type="button"
            onClick={() => (draft.step === 0 ? signOut() : update({ step: draft.step - 1 }))}
            className="rounded-[var(--radius-token-md)] bg-surface-sunken px-6 py-3 text-[14px] font-medium text-ink transition-colors hover:bg-line/60"
          >
            {c.back}
          </button>

          <button
            type="button"
            disabled={!canContinue || submitting}
            aria-busy={submitting}
            onClick={() => (isLastStep ? submitApplication() : update({ step: draft.step + 1 }))}
            className="flex-1 rounded-[var(--radius-token-md)] bg-ink py-3 text-[14px] font-bold text-white transition-colors hover:bg-ink/90 disabled:cursor-not-allowed disabled:bg-ink-soft"
          >
            {isLastStep ? c.finish : c.continue}
          </button>
        </div>
      </div>

      {/* Right — live profile preview */}
      <div className="hidden items-center bg-surface-sunken/60 p-9 lg:flex">
        <div className="w-full">
          <ProfilePreview draft={draft} handle={handle} whopHandle={null} />
        </div>
      </div>
    </div>
  );
}
