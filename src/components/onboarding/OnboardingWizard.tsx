"use client";

import { useT } from "@/i18n/provider";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAuth } from "@/components/auth/AuthProvider";
import { ProfilePreview } from "./ProfilePreview";
import { SocialIcon, WhopMark } from "./SocialIcons";
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
  const [whopHandle, setWhopHandle] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [done, setDone] = useState(false);
  // The OAuth callback redirects back with ?whop=connected or ?whop=<message>.
  // Read it once at mount so it stays derived state, not an effect write.
  const [whopResult] = useState(() =>
    typeof window === "undefined"
      ? null
      : new URLSearchParams(window.location.search).get("whop")
  );
  const whopError =
    whopResult && whopResult !== "connected" ? decodeURIComponent(whopResult) : null;
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
      // Coming back from Whop always lands on the final step.
      ...(whopResult ? { step: STEP_COUNT - 1 } : {}),
    });
    setHydrated(true);
  }, [storageKey, user, whopResult]);

  useEffect(() => {
    if (!hydrated) return;
    try {
      window.localStorage.setItem(storageKey, JSON.stringify(draft));
    } catch {
      // Storage unavailable — the wizard still works for this session.
    }
  }, [draft, storageKey, hydrated]);

  // Drop the ?whop= param so a refresh doesn't replay the callback message.
  useEffect(() => {
    if (whopResult) window.history.replaceState({}, "", window.location.pathname);
  }, [whopResult]);

  useEffect(() => {
    // The link belongs to a signed-in ClipRewards account, so asking about it
    // means proving who is asking. No token, no question.
    if (!user) return;
    let cancelled = false;
    (async () => {
      try {
        const idToken = await user.getIdToken();
        const response = await fetch("/api/whop/connection", {
          headers: { authorization: `Bearer ${idToken}` },
        });
        if (!response.ok || cancelled) return;
        const d = (await response.json()) as { connected: boolean; username?: string | null };
        if (!cancelled && d.connected && d.username) setWhopHandle(d.username);
      } catch {
        // A failed status read is not worth surfacing; the button still works.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [user]);

  /**
   * Starts the link.
   *
   * A POST rather than a link, because the server establishes who is
   * connecting before it will hand back an authorize URL. The old `<a>` could
   * be followed by anyone, signed in or not, which is precisely how the legacy
   * flow produced connections belonging to nobody.
   */
  const connectWhop = useCallback(async () => {
    if (!user || connecting) return;
    setConnecting(true);
    try {
      const idToken = await user.getIdToken();
      const response = await fetch("/api/whop/connect", {
        method: "POST",
        headers: { authorization: `Bearer ${idToken}`, "content-type": "application/json" },
        body: JSON.stringify({ return_to: "onboarding" }),
      });
      if (!response.ok) return setConnecting(false);
      const { authorize_url } = (await response.json()) as { authorize_url?: string };
      if (typeof authorize_url !== "string") return setConnecting(false);
      window.location.assign(authorize_url);
    } catch {
      setConnecting(false);
    }
  }, [user, connecting]);

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

  if (done) {
    return (
      <div className="mx-auto max-w-[560px] rounded-[var(--radius-token-lg)] bg-surface p-10 text-center shadow-[var(--shadow-float)]">
        <span className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-accent-soft text-accent">
          <svg width="26" height="26" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path d="M5 12.5L10 17.5L19 7.5" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </span>
        <h2 className="mt-5 font-[var(--font-display)] text-[26px] font-extrabold tracking-tight text-ink">
          {t.doneTitle}
        </h2>
        <p className="mt-2.5 text-[14px] leading-relaxed text-ink-soft">
          {t.doneBody}
        </p>
        <button
          type="button"
          onClick={() => update({ step: 0 })}
          className="mt-7 rounded-[var(--radius-token-pill)] border border-line px-5 py-2.5 text-[13px] font-semibold text-ink transition-colors hover:bg-surface-sunken"
        >
          {t.reviewAnswers}
        </button>
      </div>
    );
  }

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
                    {whopHandle ? t.fromWhop : t.autoGenerated}
                  </span>
                </label>
                <div className="relative mt-2">
                  <span className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-[14px] text-ink-soft/70">
                    @
                  </span>
                  <input
                    id="handle"
                    value={whopHandle ?? handle}
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
              <span className="flex h-14 w-14 items-center justify-center rounded-[16px] bg-surface-sunken text-ink">
                <WhopMark size={26} />
              </span>
              <h1 className="mt-5 font-[var(--font-display)] text-[24px] font-extrabold tracking-tight text-ink">
                {whopHandle ? t.whopConnected : t.whopConnect}
              </h1>
              <p className="mt-2.5 max-w-[320px] text-[14px] leading-relaxed text-ink-soft">
                {whopHandle ? (
                  <>
                    Linked as <span className="font-semibold text-ink">@{whopHandle}</span> — payouts
                    will land in that account.
                  </>
                ) : (
                  t.whopBody
                )}
              </p>
              {whopError && (
                <p role="alert" className="mt-4 max-w-[320px] text-[13px] font-medium text-red-700">
                  {whopError}
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

          {isLastStep && !whopHandle ? (
            <button
              type="button"
              onClick={connectWhop}
              disabled={!user || connecting}
              aria-busy={connecting}
              className="flex-1 rounded-[var(--radius-token-md)] bg-ink py-3 text-center text-[14px] font-bold text-white transition-colors hover:bg-ink/90 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {t.connectWhop}
            </button>
          ) : (
            <button
              type="button"
              disabled={!canContinue}
              onClick={() => (isLastStep ? setDone(true) : update({ step: draft.step + 1 }))}
              className="flex-1 rounded-[var(--radius-token-md)] bg-ink py-3 text-[14px] font-bold text-white transition-colors hover:bg-ink/90 disabled:cursor-not-allowed disabled:bg-ink-soft"
            >
              {isLastStep ? c.finish : c.continue}
            </button>
          )}
        </div>
      </div>

      {/* Right — live profile preview */}
      <div className="hidden items-center bg-surface-sunken/60 p-9 lg:flex">
        <div className="w-full">
          <ProfilePreview draft={draft} handle={handle} whopHandle={whopHandle} />
        </div>
      </div>
    </div>
  );
}
